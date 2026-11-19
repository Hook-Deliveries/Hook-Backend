import { ProductAvailabilityStatus, ProductStatus, ProductSubmissionStatus } from '@lib/constants';
import { CatalogMediaAsset, ProductSubmission, type SubmissionVariant } from '@models/catalog/catalog.model';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { Product } from '@models/products/product.model';
import { Market } from '@models/platform/network.model';
import { Category } from '@models/categories/category.model';
import { User } from '@models/users/user.model';
import { adminProductStatsCache, adminReviewCache } from '@lib/ttl-cache';
import { comparePassword } from '@lib/security';
import { encryptVendorAccountNumber } from '@lib/vendor-payment-crypto';
import { createCommerceNotification } from '@modules/notifications';
import { CatalogMediaService } from '@modules/catalog/catalog-media.service';
import { categoryService } from '@modules/catalog/category.service';
import {
  assignableCategory,
  canonicalSubmissionMedia,
  claimMedia,
  identifierQuery,
  sellerReferenceFor,
  validateSubmissionReady,
  type SubmissionInput,
} from '@modules/catalog/catalog.service';
import { notifyStaffByPermission } from '@modules/notifications';
import { reconcileProductInBackground } from '@modules/negotiation/public';
import { nextPublicId, publishRealtime } from '@modules/platform';
import { HttpError } from '@utils/http';

const EDITABLE = [ProductSubmissionStatus.DRAFT, ProductSubmissionStatus.CHANGES_REQUESTED];

/** The supplier behind a vendor login. Everything a vendor does is scoped to this record, never to an id they send. */
async function vendorFor(accountId: string) {
  const vendor: any = await MarketVendor.findOne({ accountId, deletedAt: { $exists: false } }).lean({ virtuals: true });
  if (!vendor) throw new HttpError(403, 'No vendor profile is linked to this account', undefined, 'ACCESS_DENIED');
  if (vendor.status !== 'active') throw new HttpError(403, 'This vendor account is not active', undefined, 'ACCESS_DENIED');
  return vendor;
}

/** Reviewer notes a vendor may see: what was decided and why, without who decided it. */
function publicNotes(notes: any[] = []) {
  return notes.map((note) => ({ action: note.action, message: note.message, fields: note.fields, createdAt: note.createdAt }));
}

function present(submission: any, extra: Record<string, unknown> = {}) {
  const { reviewNotes, internalSellerReference: _ref, marketAssociateId: _ma, reviewedBy: _by, ...rest } = submission;
  return { ...rest, reviewNotes: publicNotes(reviewNotes), ...extra };
}

/**
 * Product capture for vendors. Mirrors the Market Associate flow (draft, edit, submit, review) but is owned by the
 * vendor: no market assignment, and the supplier is always the signed-in vendor.
 */
export class VendorCatalogService {
  async profile(accountId: string) {
    const [vendor, account] = await Promise.all([
      vendorFor(accountId),
      User.findById(accountId).select('email firstName lastName phone avatarUrl').lean(),
    ]);
    const marketRecord = await Market.findById(vendor.marketId).select('publicId name address stateId').lean({ virtuals: true });
    const profile = vendor.paymentProfile || {};
    return {
      vendor: {
        publicId: vendor.publicId,
        businessName: vendor.businessName,
        contactName: vendor.contactName,
        phone: vendor.phone,
        email: vendor.email || null,
        address: vendor.address || null,
        description: vendor.description || null,
        imageUrl: vendor.imageUrl || null,
        preferredContactChannel: vendor.preferredContactChannel,
        status: vendor.status,
        verifiedAt: vendor.verifiedAt || null,
        paymentProfile: {
          method: profile.method || 'cash',
          bankName: profile.bankName || null,
          bankCode: profile.bankCode || null,
          accountName: profile.accountName || null,
          accountNumberLast4: profile.accountNumberLast4 || null,
          verificationStatus: profile.verificationStatus || 'unverified',
        },
      },
      market: marketRecord,
      account,
    };
  }

  async updateProfile(accountId: string, input: Record<string, any>) {
    const vendor = await vendorFor(accountId);
    const set: Record<string, unknown> = {};
    for (const key of ['businessName', 'contactName', 'address', 'description', 'preferredContactChannel', 'imageUrl'] as const) {
      if (input[key] !== undefined) set[key] = typeof input[key] === 'string' ? input[key].trim() : input[key];
    }
    if (input.phone !== undefined) {
      const digits = String(input.phone).replace(/\D/g, '');
      const normalized = digits.startsWith('234') && digits.length === 13 ? `0${digits.slice(3)}` : digits;
      if (normalized.length < 7) throw new HttpError(400, 'Enter a valid phone number', { field: 'phone' }, 'VALIDATION_ERROR');
      const clash = await MarketVendor.exists({ marketId: vendor.marketId, normalizedPhone: normalized, _id: { $ne: vendor._id }, deletedAt: { $exists: false } });
      if (clash) throw new HttpError(409, 'Another vendor in this market already uses that phone number', { field: 'phone' }, 'CONFLICT');
      set.phone = String(input.phone).trim();
      set.normalizedPhone = normalized;
    }
    if (Object.keys(set).length) {
      await MarketVendor.updateOne({ _id: vendor._id }, { $set: set });
      const accountSet: Record<string, unknown> = {};
      if (set.phone) accountSet.phone = set.phone;
      if (set.contactName) {
        const parts = String(set.contactName).split(/\s+/);
        accountSet.firstName = parts[0];
        accountSet.lastName = parts.slice(1).join(' ');
      }
      if (Object.keys(accountSet).length) await User.updateOne({ _id: accountId }, { $set: accountSet }).catch(() => undefined);
    }
    return this.profile(accountId);
  }

  /**
   * How Hook pays this vendor. Bank details are sensitive, so changing them needs the account password, they go back
   * to "pending" until Hook staff check them, and the vendor is told it happened.
   */
  async updatePayment(accountId: string, input: { method: 'cash' | 'bank_transfer' | 'other'; bankName?: string; bankCode?: string; accountName?: string; accountNumber?: string; password: string }) {
    const vendor = await vendorFor(accountId);
    const account: any = await User.findById(accountId).select('+password').lean();
    if (!account?.password || !(await comparePassword(input.password, account.password))) {
      throw new HttpError(400, 'That password is not correct', { field: 'password' }, 'VALIDATION_ERROR');
    }
    const current = vendor.paymentProfile || {};
    const accountNumber = String(input.accountNumber || '').replace(/\s/g, '');
    const next: Record<string, unknown> = { method: input.method, updatedAt: new Date() };
    if (input.method === 'bank_transfer') {
      const keepNumber = !accountNumber && current.accountNumberEncrypted;
      if (!input.bankName?.trim() || !input.accountName?.trim() || (!accountNumber && !keepNumber)) {
        throw new HttpError(400, 'Enter the bank, account name and account number', undefined, 'VALIDATION_ERROR');
      }
      next.bankName = input.bankName.trim();
      next.bankCode = input.bankCode?.trim() || undefined;
      next.accountName = input.accountName.trim();
      next.accountNumberEncrypted = accountNumber ? encryptVendorAccountNumber(accountNumber) : current.accountNumberEncrypted;
      next.accountNumberLast4 = accountNumber ? accountNumber.slice(-4) : current.accountNumberLast4;
      const changed = Boolean(accountNumber) || next.bankName !== current.bankName || next.accountName !== current.accountName;
      next.verificationStatus = changed || current.method !== 'bank_transfer' ? 'pending' : current.verificationStatus || 'pending';
    } else {
      // Cash and other methods carry no account details, so any saved ones are cleared rather than left behind.
      next.verificationStatus = 'unverified';
    }
    await MarketVendor.updateOne({ _id: vendor._id }, { $set: { paymentProfile: next } });
    await createCommerceNotification({
      eventKey: `vendor:${vendor.publicId}:payment-updated:${Date.now()}`,
      userId: accountId,
      title: 'Payout details updated',
      body: input.method === 'bank_transfer' ? 'Your bank details were changed. Hook will verify them before the next payout.' : 'Your payout method was changed.',
      type: 'catalog_availability',
      data: { vendorId: vendor.publicId },
    }).catch(() => undefined);
    return this.profile(accountId);
  }

  async dashboard(accountId: string) {
    const vendor = await vendorFor(accountId);
    const vendorId = vendor._id.toString();
    const [counts, published, paused, recent] = await Promise.all([
      ProductSubmission.aggregate([
        { $match: { marketVendorId: vendorId, createdBy: 'vendor', deletedAt: { $exists: false } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Product.countDocuments({ sourceMarketVendorId: vendorId, status: ProductStatus.PUBLISHED, deletedAt: { $exists: false } }),
      Product.countDocuments({ sourceMarketVendorId: vendorId, status: { $in: [ProductStatus.PAUSED, ProductStatus.UNPUBLISHED, ProductStatus.SOLD_OUT] }, deletedAt: { $exists: false } }),
      Product.find({ sourceMarketVendorId: vendorId, status: ProductStatus.PUBLISHED, deletedAt: { $exists: false } })
        .select('publicId title status publishedAt images')
        .sort({ publishedAt: -1 })
        .limit(5)
        .lean({ virtuals: true }),
    ]);
    const byStatus = Object.fromEntries(counts.map((item: any) => [item._id, item.count]));
    return {
      businessName: vendor.businessName,
      totalProducts: counts.reduce((sum: number, item: any) => sum + item.count, 0),
      drafts: byStatus[ProductSubmissionStatus.DRAFT] || 0,
      submitted: (byStatus[ProductSubmissionStatus.SUBMITTED] || 0) + (byStatus[ProductSubmissionStatus.IN_REVIEW] || 0),
      changesRequested: byStatus[ProductSubmissionStatus.CHANGES_REQUESTED] || 0,
      rejected: byStatus[ProductSubmissionStatus.REJECTED] || 0,
      published,
      paused,
      recentPublished: recent,
    };
  }

  async list(accountId: string, query: Record<string, unknown>) {
    const vendor = await vendorFor(accountId);
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);
    const filter: Record<string, any> = { marketVendorId: vendor._id.toString(), createdBy: 'vendor', deletedAt: { $exists: false } };
    if (query.status && Object.values(ProductSubmissionStatus).includes(query.status as ProductSubmissionStatus)) filter.status = query.status;
    if (query.cursor) filter._id = { $lt: query.cursor };
    const rows = await ProductSubmission.find(filter).sort({ _id: -1 }).limit(limit + 1).lean({ virtuals: true });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const products = await Product.find({ _id: { $in: page.map((row: any) => row.productId).filter(Boolean) } })
      .select('publicId status availabilityStatus images')
      .lean({ virtuals: true });
    const productById = new Map(products.map((product: any) => [String(product._id), product]));
    const mediaIds = [...new Set(page.flatMap((row: any) => row.mediaIds || []).map(String))];
    const media = mediaIds.length ? await CatalogMediaAsset.find({ publicId: { $in: mediaIds }, status: 'ready' }).lean({ virtuals: true }) : [];
    const mediaService = new CatalogMediaService();
    const urlById = new Map(media.map((asset: any) => [asset.publicId, asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset)]));
    return {
      data: page.map((row: any) => {
        const product: any = row.productId ? productById.get(String(row.productId)) : undefined;
        return present(row, {
          imageUrl: urlById.get(row.mediaViews?.front || row.mediaIds?.[0]) || product?.images?.[0],
          product: product ? { publicId: product.publicId, status: product.status, availabilityStatus: product.availabilityStatus } : null,
        });
      }),
      nextCursor: hasMore && page.length ? String((page[page.length - 1] as any)._id) : null,
      hasMore,
    };
  }

  private async own(accountId: string, identifier: string) {
    const vendor = await vendorFor(accountId);
    const submission = await ProductSubmission.findOne({
      ...identifierQuery(identifier),
      marketVendorId: vendor._id.toString(),
      createdBy: 'vendor',
      deletedAt: { $exists: false },
    }).lean({ virtuals: true });
    if (!submission) throw new HttpError(404, 'Product not found', undefined, 'NOT_FOUND');
    return { vendor, submission: submission as any };
  }

  async detail(accountId: string, identifier: string) {
    const { submission } = await this.own(accountId, identifier);
    const media = await CatalogMediaAsset.find({
      $or: [{ publicId: { $in: submission.mediaIds } }, { _id: { $in: submission.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } }],
      status: 'ready',
    }).lean({ virtuals: true });
    const mediaService = new CatalogMediaService();
    const product: any = submission.productId ? await Product.findById(submission.productId).select('publicId status availabilityStatus').lean({ virtuals: true }) : null;
    // A submission keeps its market and category by internal id, but the form lists and matches them by public id. Without
    // translating, the product page shows "—" for both and an edited draft opens with no category chosen.
    const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
    const [market, categoryRecord]: any[] = await Promise.all([
      isId(submission.marketId) ? Market.findById(submission.marketId).select('publicId').lean({ virtuals: true }) : null,
      isId(submission.categorySuggestionId) ? Category.findById(submission.categorySuggestionId).select('publicId').lean({ virtuals: true }) : null,
    ]);
    return present(submission, {
      marketId: market?.publicId || submission.marketId,
      categorySuggestionId: categoryRecord?.publicId || submission.categorySuggestionId,
      media: media.map((asset: any) => ({ ...asset, deliveryUrl: asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset) })),
      product: product ? { publicId: product.publicId, status: product.status, availabilityStatus: product.availabilityStatus } : null,
    });
  }

  async create(accountId: string, input: SubmissionInput) {
    const vendor = await vendorFor(accountId);
    const market: any = await Market.findById(vendor.marketId).lean({ virtuals: true });
    if (!market || market.status !== 'active') throw new HttpError(409, 'Your market is not active right now', undefined, 'MARKET_INACTIVE');
    const categoryRecord = await assignableCategory(input.categorySuggestionId);
    const photos = canonicalSubmissionMedia(input.mediaIds, input.mediaViews);
    const submission = await ProductSubmission.create({
      publicId: await nextPublicId('submission'),
      createdBy: 'vendor',
      marketId: market._id.toString(),
      marketVendorId: vendor._id.toString(),
      sourceStateId: market.stateId,
      categorySuggestionId: categoryRecord._id.toString(),
      basicTitle: input.basicTitle,
      notes: input.notes,
      mediaIds: photos.mediaIds,
      mediaViews: photos.mediaViews,
      captureChecklistConfirmed: input.captureChecklistConfirmed,
      basePriceMinor: input.basePriceMinor,
      currency: input.currency,
      variants: input.variants,
      availabilityStatus: input.availabilityStatus,
      availabilityNote: input.availabilityNote,
      internalSellerReference: sellerReferenceFor(vendor),
      status: ProductSubmissionStatus.DRAFT,
      version: 1,
    } as any);
    await claimMedia(accountId, submission.id, photos.mediaIds);
    return submission.toJSON();
  }

  async update(accountId: string, identifier: string, input: SubmissionInput) {
    const { vendor, submission: current } = await this.own(accountId, identifier);
    if (!EDITABLE.includes(current.status)) throw new HttpError(409, 'This product cannot be edited right now', undefined, 'SUBMISSION_STATE_CONFLICT');
    if (input.version !== current.version) throw new HttpError(409, 'This product was updated elsewhere', undefined, 'STALE_VERSION');
    const categoryRecord = await assignableCategory(input.categorySuggestionId);
    const photos = canonicalSubmissionMedia(input.mediaIds, input.mediaViews);
    const updated = await ProductSubmission.findOneAndUpdate(
      { _id: current._id, version: current.version },
      {
        $set: {
          categorySuggestionId: categoryRecord._id.toString(),
          basicTitle: input.basicTitle,
          notes: input.notes,
          mediaIds: photos.mediaIds,
          mediaViews: photos.mediaViews,
          captureChecklistConfirmed: input.captureChecklistConfirmed,
          basePriceMinor: input.basePriceMinor,
          currency: input.currency,
          variants: input.variants,
          availabilityStatus: input.availabilityStatus,
          availabilityNote: input.availabilityNote,
          internalSellerReference: sellerReferenceFor(vendor),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This product was updated elsewhere', undefined, 'STALE_VERSION');
    await claimMedia(accountId, String(current._id), photos.mediaIds);
    return updated as any;
  }

  async deleteDraft(accountId: string, identifier: string) {
    const { submission: current } = await this.own(accountId, identifier);
    if (current.status !== ProductSubmissionStatus.DRAFT) throw new HttpError(409, 'Only drafts can be deleted', undefined, 'SUBMISSION_STATE_CONFLICT');
    const result = await ProductSubmission.updateOne(
      { _id: current._id, status: ProductSubmissionStatus.DRAFT, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() }, $inc: { version: 1 } },
    );
    if (!result.modifiedCount) throw new HttpError(409, 'This product was updated elsewhere', undefined, 'STALE_VERSION');
    return current;
  }

  async submit(accountId: string, identifier: string, version: number) {
    const { submission: current } = await this.own(accountId, identifier);
    if (!EDITABLE.includes(current.status)) throw new HttpError(409, 'This product cannot be submitted right now', undefined, 'SUBMISSION_STATE_CONFLICT');
    if (current.version !== version) throw new HttpError(409, 'This product was updated elsewhere', undefined, 'STALE_VERSION');
    const categoryRecord = await assignableCategory(current.categorySuggestionId);
    await categoryService.validateVariants(categoryRecord, (current.variants || []).filter((item: SubmissionVariant) => item.active));
    const mediaCount = await CatalogMediaAsset.countDocuments({
      $or: [{ publicId: { $in: current.mediaIds } }, { _id: { $in: current.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } }],
      uploaderAccountId: accountId,
      ownerId: String(current._id),
      status: 'ready',
    });
    // The vendor attests the item is in stock, so an unavailable one cannot be sent for review.
    validateSubmissionReady(current, mediaCount, { requireConfirmed: true });
    const now = new Date();
    const updated: any = await ProductSubmission.findOneAndUpdate(
      { _id: current._id, version, status: current.status },
      {
        $set: { status: ProductSubmissionStatus.SUBMITTED, submittedAt: now, availabilityVerifiedAt: now },
        $push: { reviewNotes: { action: 'submitted', actorId: accountId, createdAt: now } },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This product changed before it could be submitted', undefined, 'SUBMISSION_STATE_CONFLICT');
    await notifyStaffByPermission({
      permission: 'catalog.submission.review',
      stateId: updated.sourceStateId,
      eventKeyPrefix: `submission:${updated.publicId}:submitted`,
      title: 'New submission for review',
      body: `${updated.basicTitle || 'A product'} was submitted by ${current.internalSellerReference || 'a vendor'}`,
      type: 'order_updated',
      data: { submissionId: updated.publicId, href: `/dashboard/catalog/submissions/${updated.publicId}` },
    });
    adminReviewCache.clear();
    return updated;
  }

  /**
   * Quick availability switch for a live product, so a vendor can mark an item out of stock without a review.
   *
   * Out of stock takes the product off sale at once (customers no longer see it anywhere), tells every open app and admin
   * screen, and flags it for Hook to recheck on the market. Back in stock puts it straight back on sale while the market
   * confirmation it had is still valid; once that has run out it waits, hidden, for a recheck instead of going live on the
   * vendor's word alone.
   */
  async setAvailability(accountId: string, productIdentifier: string, availability: ProductAvailabilityStatus) {
    const vendor = await vendorFor(accountId);
    const product: any = await Product.findOne({
      $or: [{ publicId: productIdentifier }, { hookId: productIdentifier }],
      sourceMarketVendorId: vendor._id.toString(),
      deletedAt: { $exists: false },
    });
    if (!product) throw new HttpError(404, 'Product not found', undefined, 'NOT_FOUND');

    const now = new Date();
    const wantsOut = availability === ProductAvailabilityStatus.UNAVAILABLE;
    const isOut = product.status === ProductStatus.SOLD_OUT;
    // Only live products (or ones already waiting on a recheck) can change; a draft or paused product is not on sale either way.
    if (![ProductStatus.PUBLISHED, ProductStatus.SOLD_OUT, ProductStatus.AVAILABILITY_UNCONFIRMED].includes(product.status)) {
      throw new HttpError(409, 'Only a live product can be marked in or out of stock', undefined, 'INVALID_STATE_TRANSITION');
    }

    let set: Record<string, unknown>;
    let unset: Record<string, 1> = {};
    let needsConfirmation = false;
    if (wantsOut) {
      if (isOut) return this.availabilityResult(product, false);
      set = {
        status: ProductStatus.SOLD_OUT,
        availabilityStatus: ProductAvailabilityStatus.UNAVAILABLE,
        availabilityCheckRequestedAt: now,
        availabilityCheckRequestedBy: accountId,
        availabilityCheckNote: 'Marked out of stock by the vendor. Confirm on the market before it goes back on sale.',
        customerAvailabilityNote: 'Currently out of stock.',
      };
    } else {
      if (product.status === ProductStatus.PUBLISHED && product.availabilityStatus !== ProductAvailabilityStatus.UNAVAILABLE) return this.availabilityResult(product, false);
      const stillConfirmed = product.availabilityValidUntil && new Date(product.availabilityValidUntil).getTime() > now.getTime();
      if (stillConfirmed) {
        set = { status: ProductStatus.PUBLISHED, availabilityStatus: ProductAvailabilityStatus.AVAILABLE, customerAvailabilityNote: 'Available from a verified Hook Market.' };
        unset = { availabilityCheckRequestedAt: 1, availabilityCheckRequestedBy: 1, availabilityCheckNote: 1, availabilityCheckDueAt: 1 };
      } else {
        // Its market confirmation ran out while it was away, so a Market Associate has to confirm it before customers see it.
        needsConfirmation = true;
        set = {
          status: ProductStatus.AVAILABILITY_UNCONFIRMED,
          availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
          availabilityPreviousStatus: ProductStatus.PUBLISHED,
          availabilityCheckRequestedAt: now,
          availabilityCheckRequestedBy: accountId,
          availabilityCheckNote: 'The vendor says this is back in stock. Confirm on the market before it goes back on sale.',
          customerAvailabilityNote: 'Temporarily unavailable while availability is being confirmed.',
        };
      }
    }

    const updated: any = await Product.findOneAndUpdate(
      { _id: product._id, status: product.status },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { catalogVersion: 1 } },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This product changed a moment ago. Refresh and try again.', undefined, 'STALE_VERSION');

    // Everything that shows this product refreshes now: the customer app's lists, home and product page, and the admin screens.
    const event = { entityId: updated.publicId, version: Number(updated.catalogVersion || 1), scope: updated.sourceStateId ? { stateId: String(updated.sourceStateId) } : undefined };
    publishRealtime({ type: 'catalog.updated', entityType: 'product', ...event }, { public: true, admin: true });
    publishRealtime({ type: 'home.updated', entityType: 'product', ...event }, { public: true, admin: true });
    publishRealtime({ type: 'admin.dashboard.updated', ...event }, { admin: true });
    // A product that left sale takes its negotiations and locked prices with it, and customers' carts are re-checked.
    reconcileProductInBackground(updated._id?.toString());
    adminProductStatsCache.clear();

    if (wantsOut || needsConfirmation) {
      await notifyStaffByPermission({
        permission: 'catalog.availability.manage',
        stateId: updated.sourceStateId,
        eventKeyPrefix: `product:${updated.publicId}:vendor-stock:${now.getTime()}`,
        title: wantsOut ? 'Product marked out of stock' : 'Product back in stock, needs a recheck',
        body: `${updated.title || 'A product'} from ${vendor.businessName || 'a vendor'} ${wantsOut ? 'was marked out of stock' : 'was marked back in stock'}. Recheck it on the market.`,
        type: 'order_updated',
        data: { productId: updated.publicId, href: `/dashboard/products/${updated.publicId}` },
      }).catch((error) => console.warn('[vendor] stock notification failed', error instanceof Error ? error.message : error));
    }
    return this.availabilityResult(updated, needsConfirmation);
  }

  private availabilityResult(product: any, needsConfirmation: boolean) {
    return {
      publicId: product.publicId,
      status: product.status,
      availabilityStatus: product.availabilityStatus,
      outOfStock: product.status === ProductStatus.SOLD_OUT,
      needsConfirmation,
    };
  }
}
