import mongoose from 'mongoose';
import { CommerceSettings } from '@models/commerce/commerce.model';
import {
  ProductAvailabilityStatus,
  ProductStatus,
  ProductSubmissionStatus,
} from '@lib/constants';
import { Category } from '@models/categories/category.model';
import {
  CatalogMediaAsset,
  ProductSubmission,
  ProductVariant,
  SubmissionVariant,
} from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { Market } from '@models/platform/network.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { hookIdFromPublicId, nextPublicId } from '@modules/platform';
import { CatalogMediaService } from '@modules/catalog/catalog-media.service';
import { createCommerceNotification } from '@modules/notifications';
import { EmailService } from '@emails/email.service';
import { HttpError } from '@utils/http';
import { categoryService } from '@modules/catalog/category.service';
import { adminReviewCache } from '@lib/ttl-cache';
import { defaultNegotiationRules } from '@lib/negotiation-defaults';
import { notifyStaffByPermission } from '@modules/notifications';

type SubmissionInput = {
  marketId: string;
  marketVendorId: string;
  categorySuggestionId: string;
  basicTitle: string;
  notes?: string;
  mediaIds: string[];
  mediaViews: { front?: string; side?: string; back?: string };
  captureChecklistConfirmed: boolean;
  basePriceMinor: number;
  currency: string;
  variants: SubmissionVariant[];
  availabilityStatus: ProductAvailabilityStatus;
  availabilityNote?: string;
  internalSellerReference?: string;
  version?: number;
};

// Mirrors submissionApproveAsProductSchema; reason/fields stay optional since completing product info doesn't require a review note.
type ApproveAsProductInput = {
  title: string;
  description?: string;
  costPrice: number;
  sellingPrice: number;
  discountedPrice?: number;
  minAcceptablePrice: number;
  quantity: number;
  categoryId: string;
  marketId: string;
  images: string[];
  colors?: string[];
  sizes?: string[];
  status: ProductStatus.DRAFT | ProductStatus.PUBLISHED;
  version: number;
  reason?: string;
  fields?: string[];
};

function identifierQuery(identifier: string) {
  return /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
}

export async function byIdentifier<T>(model: any, identifier: string, select?: string): Promise<T> {
  const query = model.findOne(identifierQuery(identifier));
  if (select) query.select(select);
  const record = await query.lean({ virtuals: true });
  if (!record) throw new HttpError(404, 'Record not found', undefined, 'NOT_FOUND');
  return record as T;
}

/**
 * byIdentifier() above only matches _id/publicId — it doesn't know about
 * hookId, so it 404s on the exact identifier the admin UI actually uses
 * everywhere else for Products. Product Inventory's own list/detail/edit
 * routes go through adminRepos.products(), whose MongoRepository wrapper
 * already resolves _id/publicId/hookId per-model; this mirrors that so every
 * Product-specific service (lifecycle, negotiation rules, availability
 * checks) accepts the same identifier the rest of the product screen does.
 */
export async function byProductIdentifier<T>(identifier: string, select?: string): Promise<T> {
  const isObjectId = /^[a-f\d]{24}$/i.test(identifier);
  const query = Product.findOne(
    isObjectId
      ? { $or: [{ _id: identifier }, { publicId: identifier }, { hookId: identifier }] }
      : { $or: [{ publicId: identifier }, { hookId: identifier }] },
  );
  if (select) query.select(select);
  const record = await query.lean({ virtuals: true });
  if (!record) throw new HttpError(404, 'Product not found', undefined, 'NOT_FOUND');
  return record as T;
}

function slugify(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-');
}

async function marketAssociateContext(accountId: string, marketIdentifier?: string) {
  const marketAssociate = await MarketAssociateProfile.findOne({ accountId, status: 'active' }).lean({ virtuals: true });
  if (!marketAssociate) throw new HttpError(403, 'Active Market Associate profile required', undefined, 'ACCESS_DENIED');
  if (!marketIdentifier) return { marketAssociate };
  const market = await byIdentifier<any>(Market, marketIdentifier);
  if (market.status !== 'active') throw new HttpError(409, 'The selected Market is inactive', undefined, 'MARKET_INACTIVE');
  const assignment = await MarketAssociateMarketAssignment.findOne({
    marketAssociateId: marketAssociate._id.toString(),
    marketId: market._id.toString(),
    status: 'active',
    activeFrom: { $lte: new Date() },
    $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }],
  }).lean({ virtuals: true });
  if (!assignment) {
    throw new HttpError(403, 'An active Market assignment is required', undefined, 'RUNNER_MARKET_ASSIGNMENT_REQUIRED');
  }
  return { marketAssociate, market, assignment };
}

async function ensureMarketVendor(identifier: string, marketId: string) {
  const filter = /^[a-f\d]{24}$/i.test(identifier)
    ? { $or: [{ _id: identifier }, { publicId: identifier }] }
    : { publicId: identifier };
  const vendor = await MarketVendor.findOne({
    ...filter,
    marketId,
    status: { $in: ['pending', 'active'] },
    deletedAt: { $exists: false },
  }).lean({ virtuals: true });
  if (!vendor) {
    throw new HttpError(409, 'Select an active vendor from this Market', undefined, 'MARKET_VENDOR_INVALID');
  }
  return vendor;
}

async function category(identifier: string) {
  // Only an active leaf may hold products: a parent with sub-categories is refused.
  return categoryService.assertAssignable(identifier) as Promise<any>;
}

async function activeMarket(identifier: string) {
  const result = await byIdentifier<any>(Market, identifier);
  if (result.status !== 'active') throw new HttpError(409, 'The selected Market is inactive', undefined, 'CONFLICT');
  return result;
}

function assertSubmissionPublishReady(product: Record<string, any>) {
  const missing: string[] = [];
  if (!String(product.description || '').trim() || String(product.description).trim().length < 20) missing.push('description');
  if (!Array.isArray(product.images) || !product.images.length) missing.push('images');
  if (Number(product.quantity || 0) < 1) missing.push('quantity');
  if (Number(product.costPrice || 0) <= 0) missing.push('costPrice');
  if (Number(product.sellingPrice || 0) <= 0) missing.push('sellingPrice');
  if (missing.length) {
    throw new HttpError(409, 'Complete the required product information before activation', { fields: missing }, 'CONFLICT');
  }
}

async function claimMedia(accountId: string, submissionId: string, mediaIds: string[]) {
  if (!mediaIds.length) return [];
  const assets = await CatalogMediaAsset.find({
    $and: [
      { $or: [{ publicId: { $in: mediaIds } }, { _id: { $in: mediaIds.filter((id) => /^[a-f\d]{24}$/i.test(id)) } }] },
      { $or: [{ ownerId: { $exists: false } }, { ownerId: submissionId }] },
    ],
    uploaderAccountId: accountId,
    status: 'ready',
  }).lean({ virtuals: true });
  if (assets.length !== new Set(mediaIds).size) {
    throw new HttpError(400, 'One or more images are invalid or belong to another record', undefined, 'SUBMISSION_VALIDATION_FAILED');
  }
  await CatalogMediaAsset.updateMany(
    { _id: { $in: assets.map((asset) => asset._id) }, $or: [{ ownerId: { $exists: false } }, { ownerId: submissionId }] },
    { $set: { ownerType: 'submission', ownerId: submissionId } },
  );
  return assets;
}

function validateSubmissionReady(submission: any, mediaCount: number) {
  const fields: string[] = [];
  if (!submission.basicTitle?.trim()) fields.push('basicTitle');
  if (!submission.categorySuggestionId) fields.push('categorySuggestionId');
  if (!Number.isSafeInteger(submission.basePriceMinor) || submission.basePriceMinor <= 0) fields.push('basePriceMinor');
  if (!submission.variants?.some((item: SubmissionVariant) => item.active)) fields.push('variants');
  const requiredViews = ['front', 'side', 'back'] as const;
  const viewIds = requiredViews.map((view) => submission.mediaViews?.[view]).filter(Boolean);
  if (mediaCount < 3 || viewIds.length !== 3 || new Set(viewIds).size !== 3) fields.push('frontSideBackPhotos');
  if (!submission.captureChecklistConfirmed) fields.push('captureChecklistConfirmed');
  if (fields.length) {
    throw new HttpError(400, 'Complete the required submission fields before submitting', { fields }, 'SUBMISSION_VALIDATION_FAILED');
  }
}

export class MarketAssociateCatalogService {
  async dashboard(accountId: string) {
    const { marketAssociate } = await marketAssociateContext(accountId);
    const marketAssociateId = marketAssociate._id.toString();
    const [assignmentRows, counts, recentPublished] = await Promise.all([
      MarketAssociateMarketAssignment.find({ marketAssociateId, status: 'active' }).select('marketId').lean(),
      ProductSubmission.aggregate([
        { $match: { marketAssociateId, deletedAt: { $exists: false } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Product.find({ 'commercialApproval.sourceMarketAssociateId': marketAssociateId, status: ProductStatus.PUBLISHED })
        .select('publicId title status publishedAt')
        .sort({ publishedAt: -1 })
        .limit(5)
        .lean({ virtuals: true }),
    ]);
    const byStatus = Object.fromEntries(counts.map((item) => [item._id, item.count]));
    // Mirrors GET /availability-checks: any unconfirmed Product in one of this
    // Market Associate's assigned markets is theirs to action, unless another
    // still-active Market Associate already owns that specific check.
    const marketIds = assignmentRows.map((assignment) => assignment.marketId);
    const dueProducts = marketIds.length
      ? await Product.find({
        marketId: { $in: marketIds },
        availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
        deletedAt: { $exists: false },
      }).select('sourceMarketAssociateId').lean()
      : [];
    const otherSourceIds = [...new Set(
      dueProducts.map((product) => product.sourceMarketAssociateId).filter((id): id is string => Boolean(id) && id !== marketAssociateId),
    )];
    const otherActiveSourceIds = otherSourceIds.length
      ? new Set((await MarketAssociateProfile.find({ _id: { $in: otherSourceIds }, status: 'active' }).select('_id').lean()).map((source) => source._id.toString()))
      : new Set<string>();
    const availabilityChecksDue = dueProducts.filter(
      (product) => !product.sourceMarketAssociateId || product.sourceMarketAssociateId === marketAssociateId || !otherActiveSourceIds.has(product.sourceMarketAssociateId),
    ).length;
    return {
      assignedMarkets: assignmentRows.length,
      drafts: byStatus[ProductSubmissionStatus.DRAFT] || 0,
      submitted: byStatus[ProductSubmissionStatus.SUBMITTED] || 0,
      changesRequested: byStatus[ProductSubmissionStatus.CHANGES_REQUESTED] || 0,
      approved: byStatus[ProductSubmissionStatus.APPROVED] || 0,
      availabilityChecksDue,
      recentPublished,
    };
  }

  async list(accountId: string, query: Record<string, unknown>) {
    const { marketAssociate } = await marketAssociateContext(accountId);
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);
    const filter: Record<string, any> = { marketAssociateId: marketAssociate._id.toString(), deletedAt: { $exists: false } };
    if (query.status && Object.values(ProductSubmissionStatus).includes(query.status as ProductSubmissionStatus)) {
      filter.status = query.status;
    }
    if (query.cursor) filter._id = { $lt: query.cursor };
    const data = await ProductSubmission.find(filter).sort({ _id: -1 }).limit(limit + 1).lean({ virtuals: true });
    const hasMore = data.length > limit;
    const page = data.slice(0, limit);
    const productIds = [...new Set(page.map((item) => item.productId).filter(Boolean).map(String))];
    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds } }).select('_id images').lean()
      : [];
    const submissionMediaIds = [...new Set(page.flatMap((item) => item.mediaIds || []).map(String))];
    const submissionMedia = submissionMediaIds.length
      ? await CatalogMediaAsset.find({ publicId: { $in: submissionMediaIds }, status: 'ready' }).lean({ virtuals: true })
      : [];
    const mediaService = new CatalogMediaService();
    const mediaUrlById = new Map(submissionMedia.map((asset) => [
      asset.publicId,
      asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset),
    ]));
    const imageByProductId = new Map(products.map((product) => [String(product._id), product.images?.[0]]));
    return {
      data: page.map((item) => ({
        ...item,
        imageUrl: mediaUrlById.get(item.mediaViews?.front || item.mediaIds?.[0])
          || (item.productId ? imageByProductId.get(String(item.productId)) : undefined),
      })),
      nextCursor: hasMore && page.length ? page[page.length - 1]._id.toString() : null,
      hasMore,
    };
  }

  async detail(accountId: string, identifier: string) {
    const { marketAssociate } = await marketAssociateContext(accountId);
    const submission = await ProductSubmission.findOne({
      ...identifierQuery(identifier),
      marketAssociateId: marketAssociate._id.toString(),
      deletedAt: { $exists: false },
    }).lean({ virtuals: true });
    if (!submission) throw new HttpError(404, 'Submission not found', undefined, 'NOT_FOUND');
    const media = await CatalogMediaAsset.find({
      $or: [
        { publicId: { $in: submission.mediaIds } },
        { _id: { $in: submission.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } },
      ],
      status: 'ready',
    }).lean({ virtuals: true });
    const mediaService = new CatalogMediaService();
    return {
      ...submission,
      media: media.map((asset) => ({
        ...asset,
        deliveryUrl: asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset),
      })),
    };
  }

  async create(accountId: string, input: SubmissionInput) {
    const [{ marketAssociate, market }] = await Promise.all([
      marketAssociateContext(accountId, input.marketId),
      category(input.categorySuggestionId),
    ]);
    const vendor = await ensureMarketVendor(input.marketVendorId, market._id.toString());
    const publicId = await nextPublicId('submission');
    const submission = await ProductSubmission.create({
      publicId,
      marketAssociateId: marketAssociate._id.toString(),
      marketId: market._id.toString(),
      marketVendorId: vendor._id.toString(),
      sourceStateId: market.stateId,
      categorySuggestionId: (await category(input.categorySuggestionId))._id.toString(),
      basicTitle: input.basicTitle,
      notes: input.notes,
      mediaIds: input.mediaIds,
      mediaViews: input.mediaViews,
      captureChecklistConfirmed: input.captureChecklistConfirmed,
      basePriceMinor: input.basePriceMinor,
      currency: input.currency,
      variants: input.variants,
      availabilityStatus: input.availabilityStatus,
      availabilityNote: input.availabilityNote,
      internalSellerReference: input.internalSellerReference,
      status: ProductSubmissionStatus.DRAFT,
      version: 1,
    });
    await claimMedia(accountId, submission.id, input.mediaIds);
    return submission.toJSON();
  }

  async update(accountId: string, identifier: string, input: SubmissionInput) {
    const current = await this.detail(accountId, identifier);
    if (![ProductSubmissionStatus.DRAFT, ProductSubmissionStatus.CHANGES_REQUESTED].includes(current.status)) {
      throw new HttpError(409, 'This submission cannot be edited in its current state', undefined, 'SUBMISSION_STATE_CONFLICT');
    }
    if (input.version !== current.version) throw new HttpError(409, 'This submission was updated elsewhere', undefined, 'STALE_VERSION');
    const [{ market }] = await Promise.all([
      marketAssociateContext(accountId, input.marketId),
      category(input.categorySuggestionId),
    ]);
    const vendor = await ensureMarketVendor(input.marketVendorId, market._id.toString());
    const updated = await ProductSubmission.findOneAndUpdate(
      { _id: current._id, version: current.version },
      {
        $set: {
          marketId: market._id.toString(),
          marketVendorId: vendor._id.toString(),
          sourceStateId: market.stateId,
          categorySuggestionId: (await category(input.categorySuggestionId))._id.toString(),
          basicTitle: input.basicTitle,
          notes: input.notes,
          mediaIds: input.mediaIds,
          mediaViews: input.mediaViews,
          captureChecklistConfirmed: input.captureChecklistConfirmed,
          basePriceMinor: input.basePriceMinor,
          currency: input.currency,
          variants: input.variants,
          availabilityStatus: input.availabilityStatus,
          availabilityNote: input.availabilityNote,
          internalSellerReference: input.internalSellerReference,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This submission was updated elsewhere', undefined, 'STALE_VERSION');
    await claimMedia(accountId, current._id.toString(), input.mediaIds);
    return updated;
  }

  async submit(accountId: string, identifier: string, version: number) {
    const current = await this.detail(accountId, identifier);
    if (![ProductSubmissionStatus.DRAFT, ProductSubmissionStatus.CHANGES_REQUESTED].includes(current.status)) {
      throw new HttpError(409, 'This submission cannot be submitted in its current state', undefined, 'SUBMISSION_STATE_CONFLICT');
    }
    if (current.version !== version) throw new HttpError(409, 'This submission was updated elsewhere', undefined, 'STALE_VERSION');
    await marketAssociateContext(accountId, current.marketId);
    const submissionCategory = await category(current.categorySuggestionId);
    await categoryService.validateVariants(submissionCategory, (current.variants || []).filter((item: SubmissionVariant) => item.active));
    const mediaCount = await CatalogMediaAsset.countDocuments({
      $or: [
        { publicId: { $in: current.mediaIds } },
        { _id: { $in: current.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } },
      ],
      uploaderAccountId: accountId,
      ownerId: current._id.toString(),
      status: 'ready',
    });
    validateSubmissionReady(current, mediaCount);
    const updated = await ProductSubmission.findOneAndUpdate(
      { _id: current._id, version, status: current.status },
      {
        $set: { status: ProductSubmissionStatus.SUBMITTED, submittedAt: new Date() },
        $push: {
          reviewNotes: {
            action: 'submitted',
            actorId: accountId,
            createdAt: new Date(),
          },
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'Submission state changed before this action completed', undefined, 'SUBMISSION_STATE_CONFLICT');
    await notifyStaffByPermission({
      permission: 'catalog.submission.review',
      stateId: updated.sourceStateId,
      eventKeyPrefix: `submission:${updated.publicId}:submitted`,
      title: 'New submission for review',
      body: `${updated.basicTitle || 'A product'} was submitted by a Market Associate`,
      type: 'order_updated',
      data: { submissionId: updated.publicId, href: `/dashboard/catalog/submissions/${updated.publicId}` },
    });
    return updated;
  }
}

export class CatalogReviewService {
  private readonly email = new EmailService();

  private async notifySubmissionDecision(submissionId: string, marketAssociateId: string | undefined, productTitle: string, decision: 'approved' | 'rejected' | 'changes_requested', reason?: string) {
    if (!marketAssociateId) return;
    const marketAssociate = await MarketAssociateProfile.findById(marketAssociateId).select('accountId').lean() as any;
    if (!marketAssociate?.accountId) return;
    await createCommerceNotification({
      // Each review round is its own event, so a second "changes requested" still notifies.
      eventKey: `submission:${submissionId}:${decision}:${Date.now()}`,
      userId: marketAssociate.accountId,
      title: decision === 'approved' ? 'Your submission was approved' : decision === 'rejected' ? 'Your submission was not approved' : 'Changes requested on your submission',
      body: decision === 'approved' ? `${productTitle} was approved and is now live on Hook.` : decision === 'rejected' ? `${productTitle} was not approved.` : `${productTitle} needs a few changes before it can go live.`,
      type: 'submission_decision',
      data: { decision, productTitle, submissionId },
    }).catch(() => undefined);
    const account = await User.findById(marketAssociate.accountId).select('email firstName').lean() as any;
    if (account?.email) {
      await this.email.sendSubmissionDecision({
        to: account.email,
        name: account.firstName,
        productTitle,
        decision,
        reason,
      }).catch(() => undefined);
    }
  }

  async dashboard(stateIds?: string[]) {
    const cacheKey = `review:${stateIds?.length ? [...stateIds].sort().join(',') : 'global'}`;
    const cached = adminReviewCache.get(cacheKey);
    if (cached) return cached;

    const stateFilter = stateIds?.length ? { sourceStateId: { $in: stateIds } } : {};
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [summary] = await ProductSubmission.aggregate([
      { $match: { ...stateFilter, deletedAt: { $exists: false } } },
      {
        $facet: {
          statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          approvedToday: [
            { $match: { status: ProductSubmissionStatus.APPROVED, reviewedAt: { $gte: today } } },
            { $count: 'count' },
          ],
          rejectedToday: [
            { $match: { status: ProductSubmissionStatus.REJECTED, reviewedAt: { $gte: today } } },
            { $count: 'count' },
          ],
          age: [
            { $match: { status: { $in: [ProductSubmissionStatus.SUBMITTED, ProductSubmissionStatus.IN_REVIEW] }, submittedAt: { $type: 'date' } } },
            { $group: { _id: null, averageMs: { $avg: { $subtract: [now, '$submittedAt'] } } } },
          ],
          byState: [{ $group: { _id: '$sourceStateId', count: { $sum: 1 } } }],
          byMarket: [{ $group: { _id: '$marketId', count: { $sum: 1 } } }],
        },
      },
    ]);
    const statusCounts = summary?.statusCounts || [];
    const counts = Object.fromEntries((statusCounts as any[]).map((item: any) => [item._id, item.count]));
    const result = {
      pending: counts.submitted || 0,
      inReview: counts.in_review || 0,
      changesRequested: counts.changes_requested || 0,
      approvedToday: summary?.approvedToday?.[0]?.count || 0,
      rejectedToday: summary?.rejectedToday?.[0]?.count || 0,
      averageReviewAgeHours: Number(((summary?.age?.[0]?.averageMs || 0) / 3_600_000).toFixed(1)),
      byState: summary?.byState || [],
      byMarket: summary?.byMarket || [],
    };
    adminReviewCache.set(cacheKey, result);
    return result;
  }

  async list(query: Record<string, unknown>, stateIds?: string[]) {
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);
    const filter: Record<string, any> = { deletedAt: { $exists: false } };
    if (stateIds?.length) filter.sourceStateId = { $in: stateIds };
    if (query.status) {
      const allowed = Object.values(ProductSubmissionStatus) as string[];
      if (!allowed.includes(String(query.status))) throw new HttpError(400, 'Unknown status', undefined, 'VALIDATION_ERROR');
      filter.status = query.status;
    }
    // A State filter can only narrow what the caller may already see, never widen it.
    if (query.stateId) filter.sourceStateId = stateIds?.length ? { $in: stateIds.filter((id) => id === String(query.stateId)) } : query.stateId;
    // Filters may arrive as public ids (what the admin lists show) or internal ids.
    const internal = async (value: unknown, model: { findOne: (q: object) => { select: (f: string) => { lean: () => Promise<{ _id: unknown } | null> } } }) => {
      const text = String(value);
      if (/^[a-f\d]{24}$/i.test(text)) return text;
      const found = await model.findOne({ publicId: text }).select('_id').lean();
      return found ? String(found._id) : '000000000000000000000000';
    };
    if (query.marketId) filter.marketId = await internal(query.marketId, Market as never);
    if (query.marketAssociateId) filter.marketAssociateId = await internal(query.marketAssociateId, MarketAssociateProfile as never);
    if (query.categoryId) filter.categorySuggestionId = { $in: await categoryService.descendantIds(String(query.categoryId)) };
    if (query.cursor) {
      if (!/^[a-f\d]{24}$/i.test(String(query.cursor))) throw new HttpError(400, 'Invalid cursor', undefined, 'VALIDATION_ERROR');
      filter._id = { [query.sort === 'oldest' ? '$gt' : '$lt']: query.cursor };
    }
    if (query.q) {
      const pattern = new RegExp(String(query.q).trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ basicTitle: pattern }, { publicId: pattern }];
    }
    const direction = query.sort === 'oldest' ? 1 : -1;
    const data = await ProductSubmission.find(filter).sort({ _id: direction }).limit(limit + 1).lean({ virtuals: true });
    const hasMore = data.length > limit;
    const page = data.slice(0, limit);
    const mediaIds = [...new Set(page.flatMap((item) => item.mediaIds || []).map(String))];
    const media = mediaIds.length
      ? await CatalogMediaAsset.find({ publicId: { $in: mediaIds }, status: 'ready' }).lean({ virtuals: true })
      : [];
    const mediaService = new CatalogMediaService();
    const mediaUrlById = new Map(media.map((asset) => [
      asset.publicId,
      asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset),
    ]));
    return {
      data: page.map((item) => ({
        ...item,
        imageUrl: mediaUrlById.get(item.mediaViews?.front || item.mediaIds?.[0]),
      })),
      nextCursor: hasMore && page.length ? page[page.length - 1]._id.toString() : null,
      hasMore,
    };
  }

  async detail(identifier: string, stateIds?: string[]) {
    const filter: Record<string, unknown> = { ...identifierQuery(identifier) };
    if (stateIds?.length) filter.sourceStateId = { $in: stateIds };
    const submission = await ProductSubmission.findOne(filter).lean({ virtuals: true });
    if (!submission) throw new HttpError(404, 'Submission not found', undefined, 'NOT_FOUND');
    const [marketAssociate, market, categoryRecord, media] = await Promise.all([
      MarketAssociateProfile.findById(submission.marketAssociateId).select('publicId accountId').lean({ virtuals: true }),
      Market.findById(submission.marketId).select('publicId name stateId cityId hubId').lean({ virtuals: true }),
      Category.findById(submission.categorySuggestionId).select('publicId name slug').lean({ virtuals: true }),
      CatalogMediaAsset.find({
        $or: [
          { publicId: { $in: submission.mediaIds } },
          { _id: { $in: submission.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } },
        ],
        status: 'ready',
      }).sort({ order: 1 }).lean({ virtuals: true }),
    ]);
    const mediaService = new CatalogMediaService();
    return {
      ...submission,
      marketAssociate,
      market,
      category: categoryRecord,
      media: media.map((asset) => ({
        ...asset,
        deliveryUrl: asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset),
      })),
    };
  }

  async start(identifier: string, actorId: string, actorPublicId: string | undefined, version: number, stateIds?: string[]) {
    const current = await this.detail(identifier, stateIds);
    if (current.status !== ProductSubmissionStatus.SUBMITTED) {
      throw new HttpError(409, 'Only submitted records can enter review', undefined, 'SUBMISSION_STATE_CONFLICT');
    }
    const updated = await ProductSubmission.findOneAndUpdate(
      { _id: current._id, version, status: ProductSubmissionStatus.SUBMITTED },
      {
        $set: { status: ProductSubmissionStatus.IN_REVIEW, reviewStartedAt: new Date(), reviewedBy: actorId },
        $push: { reviewNotes: { action: 'review_started', actorId, actorPublicId, createdAt: new Date() } },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'Another reviewer changed this submission', undefined, 'SUBMISSION_REVIEW_CONFLICT');
    return updated;
  }

  async decide(
    identifier: string,
    actorId: string,
    actorPublicId: string | undefined,
    action: 'changes_requested' | 'rejected',
    input: { reason: string; fields: string[]; version: number },
    stateIds?: string[],
  ): Promise<any>;
  async decide(
    identifier: string,
    actorId: string,
    actorPublicId: string | undefined,
    action: 'approved',
    input: ApproveAsProductInput,
    stateIds?: string[],
  ): Promise<any>;
  async decide(
    identifier: string,
    actorId: string,
    actorPublicId: string | undefined,
    action: 'changes_requested' | 'rejected' | 'approved',
    input: { reason: string; fields: string[]; version: number } | ApproveAsProductInput,
    stateIds?: string[],
  ) {
    const current = await this.detail(identifier, stateIds);
    if (current.status !== ProductSubmissionStatus.IN_REVIEW || current.reviewedBy !== actorId) {
      throw new HttpError(409, 'Start review before recording this decision', undefined, 'SUBMISSION_REVIEW_CONFLICT');
    }
    if (action !== 'approved') {
      const next = action === 'rejected' ? ProductSubmissionStatus.REJECTED : ProductSubmissionStatus.CHANGES_REQUESTED;
      const updated = await ProductSubmission.findOneAndUpdate(
        { _id: current._id, version: input.version, status: ProductSubmissionStatus.IN_REVIEW },
        {
          $set: { status: next, reviewedAt: new Date() },
          $push: {
            reviewNotes: {
              action,
              message: input.reason,
              fields: input.fields,
              actorId,
              actorPublicId,
              createdAt: new Date(),
            },
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after' },
      ).lean({ virtuals: true });
      if (!updated) throw new HttpError(409, 'Another reviewer changed this submission', undefined, 'SUBMISSION_REVIEW_CONFLICT');
      // A rejected capture is final, so its uploads are released instead of lingering unowned.
      if (action === 'rejected' && current.mediaIds?.length) {
        await CatalogMediaAsset.updateMany({ $or: [{ publicId: { $in: current.mediaIds } }, { _id: { $in: current.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } }] }, { $set: { status: 'removed' } });
      }
      await this.notifySubmissionDecision(current._id.toString(), current.marketAssociateId, current.basicTitle, action, input.reason);
      return updated;
    }

    const approveInput = input as ApproveAsProductInput;
    validateSubmissionReady(current, current.media.length);
    // The Market stays fixed to the submission — it is the Market Associate's
    // own assignment, not something an admin reassigns during review — so the
    // submission's own marketId always wins here regardless of what the
    // request body carries.
    const [resolvedCategory, resolvedMarket] = await Promise.all([
      category(approveInput.categoryId || current.categorySuggestionId),
      activeMarket(current.marketId),
    ]);
    await categoryService.validateVariants(resolvedCategory, (current.variants || []).filter((item: SubmissionVariant) => item.active));
    const isPublished = approveInput.status === ProductStatus.PUBLISHED;
    const costPrice = Number(approveInput.costPrice);
    const sellingPrice = Number(approveInput.sellingPrice);
    const minAcceptablePrice = Number(approveInput.minAcceptablePrice);
    const images = approveInput.images?.length ? approveInput.images : [];
    // Prices have to make sense before a product exists: the price cannot sit below cost, and the negotiation floor
    // has to fall between cost and the selling price.
    if (costPrice > 0 && sellingPrice > 0 && sellingPrice < costPrice) {
      throw new HttpError(400, 'The selling price cannot be lower than the cost price', undefined, 'VALIDATION_ERROR');
    }
    if (minAcceptablePrice > 0 && ((costPrice > 0 && minAcceptablePrice < costPrice) || (sellingPrice > 0 && minAcceptablePrice > sellingPrice))) {
      throw new HttpError(400, 'The lowest negotiable price must sit between the cost price and the selling price', undefined, 'VALIDATION_ERROR');
    }
    if (approveInput.discountedPrice && Number(approveInput.discountedPrice) >= sellingPrice) {
      throw new HttpError(400, 'The discounted price must be lower than the selling price', undefined, 'VALIDATION_ERROR');
    }
    // Going live with an item the Market Associate could not confirm would list something nobody can buy.
    if (isPublished && ![ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED].includes(current.availabilityStatus)) {
      throw new HttpError(409, 'The Market Associate has not confirmed this item is available. Approve it as a draft, or ask for a fresh availability check first.', undefined, 'CONFLICT');
    }
    const checkDays = Math.min(Math.max(Number((await CommerceSettings.findOne({ key: 'commerce' }).select('catalogAvailabilityCheckDays').lean())?.catalogAvailabilityCheckDays || 4), 1), 30);
    if (isPublished) {
      assertSubmissionPublishReady({
        description: approveInput.description,
        images,
        quantity: approveInput.quantity,
        costPrice,
        sellingPrice,
      });
    }
    // The product keeps only the uploads that made it into its final gallery; the rest are released.
    const submissionAssets = current.mediaIds?.length
      ? await CatalogMediaAsset.find({ $or: [{ publicId: { $in: current.mediaIds } }, { _id: { $in: current.mediaIds.filter((id: string) => /^[a-f\d]{24}$/i.test(id)) } }] }).lean({ virtuals: true })
      : [];
    const mediaDelivery = new CatalogMediaService();
    const urlOf = (asset: any) => (asset.deliveryType === 'external' ? asset.secureUrl : mediaDelivery.deliveryUrl(asset));
    const matched = images.length ? submissionAssets.filter((asset: any) => images.includes(urlOf(asset)) || images.includes(asset.secureUrl)) : [];
    // If no upload can be matched to the gallery (links pasted by hand), keep them all rather than release good files.
    const keptAssets = matched.length ? matched : submissionAssets;
    const keptIds = keptAssets.map((asset: any) => asset.publicId || String(asset._id));
    const releasedIds = submissionAssets.filter((asset: any) => !keptAssets.includes(asset)).map((asset: any) => String(asset._id));
    const negotiationRules = defaultNegotiationRules({
      sellingPriceMinor: Math.round(sellingPrice * 100),
      basePriceMinor: Math.round(costPrice * 100),
      minAcceptablePriceMinor: Math.round(minAcceptablePrice * 100),
    }) || { enabled: false, maximumCustomerOffers: 3, acceptedQuoteExpiryMinutes: 30 };
    const transaction = await mongoose.startSession();
    try {
      let result: any;
      await transaction.withTransaction(async () => {
        const productPublicId = await nextPublicId('product');
        const slug = `${slugify(approveInput.title || current.basicTitle)}-${productPublicId.toLowerCase()}`;
        const now = new Date();
        const product = await Product.create([{
          publicId: productPublicId,
          hookId: hookIdFromPublicId(productPublicId),
          sourceSubmissionId: current._id.toString(),
          sourceMarketVendorId: current.marketVendorId,
          sourceMarketAssociateId: current.marketAssociateId,
          marketId: resolvedMarket._id.toString(),
          sourceStateId: resolvedMarket.stateId,
          categoryId: resolvedCategory._id.toString(),
          title: approveInput.title || current.basicTitle,
          slug,
          description: approveInput.description || '',
          basePriceMinor: Math.round(costPrice * 100),
          sellingPriceMinor: Math.round(sellingPrice * 100),
          markupMinor: 0,
          discountMinor: approveInput.discountedPrice
            ? Math.max(0, Math.round((sellingPrice - Number(approveInput.discountedPrice)) * 100))
            : 0,
          currency: current.currency,
          mediaAssetIds: keptIds,
          images,
          colors: approveInput.colors || [],
          sizes: approveInput.sizes || [],
          quantity: Number(approveInput.quantity || 0),
          reservedQuantity: 0,
          costPrice,
          sellingPrice,
          minAcceptablePrice,
          status: approveInput.status,
          availabilityStatus: current.availabilityStatus,
          customerAvailabilityNote: current.availabilityNote,
          negotiationRules,
          commercialApproval: { approved: isPublished, approvedBy: isPublished ? actorId : undefined, approvedAt: isPublished ? now : undefined, sourceMarketAssociateId: current.marketAssociateId },
          source: 'admin',
          viewCount: 0,
          orderCount: 0,
          averageRating: 0,
          catalogMigrationVersion: 3,
          ...(isPublished ? {
            publishedAt: now,
            publishedBy: actorId,
            lastAvailabilityConfirmedAt: now,
            // Same rolling expiry every other publish path sets, so the availability job can escalate it.
            availabilityValidUntil: new Date(now.getTime() + checkDays * 86_400_000),
          } : {}),
        }], { session: transaction });
        for (let index = 0; index < current.variants.length; index += 1) {
          const item = current.variants[index];
          const publicId = await nextPublicId('variant');
          await ProductVariant.create([{
            publicId,
            productId: product[0].id,
            sku: `${productPublicId}-${String(index + 1).padStart(2, '0')}`,
            size: item.size,
            colour: item.colour,
            attributes: item.attributes || {},
            active: item.active !== false,
            mediaAssetIds: [],
          }], { session: transaction });
        }
        result = await ProductSubmission.findOneAndUpdate(
          { _id: current._id, version: approveInput.version, status: ProductSubmissionStatus.IN_REVIEW },
          {
            $set: {
              status: ProductSubmissionStatus.APPROVED,
              reviewedAt: new Date(),
              productId: product[0].id,
            },
            $push: {
              reviewNotes: {
                action: 'approved',
                message: approveInput.reason,
                fields: approveInput.fields || [],
                actorId,
                actorPublicId,
                createdAt: new Date(),
              },
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', session: transaction },
        ).lean({ virtuals: true });
        if (!result) throw new HttpError(409, 'Another reviewer changed this submission', undefined, 'SUBMISSION_REVIEW_CONFLICT');
        await CatalogMediaAsset.updateMany(
          { _id: { $in: keptAssets.map((asset: any) => asset._id) } },
          { $set: { ownerType: 'product', ownerId: product[0].id } },
          { session: transaction },
        );
        if (releasedIds.length) await CatalogMediaAsset.updateMany({ _id: { $in: releasedIds } }, { $set: { status: 'removed' } }, { session: transaction });
      });
      await this.notifySubmissionDecision(current._id.toString(), current.marketAssociateId, current.basicTitle, 'approved', approveInput.reason);
      return result;
    } finally {
      await transaction.endSession();
    }
  }
}
