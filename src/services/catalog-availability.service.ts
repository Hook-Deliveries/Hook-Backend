import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { Product } from '@models/products/product.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { byProductIdentifier } from '@services/catalog.service';
import { MarketVendorService } from '@services/market-vendor.service';
import { publishRealtime } from '@modules/platform/realtime.service';
import { HttpError } from '@utils/http';

function versionFilter(product: any, version: number) {
  const currentVersion = Number(product.catalogVersion || 1);
  if (currentVersion !== version) throw new HttpError(409, 'This product was updated elsewhere', undefined, 'STALE_VERSION');
  return product.catalogVersion === undefined
    ? { _id: product._id, $or: [{ catalogVersion: { $exists: false } }, { catalogVersion: version }] }
    : { _id: product._id, catalogVersion: version };
}

function publishUpdate(product: any) {
  const event = { entityId: product.publicId || product._id?.toString(), version: Number(product.catalogVersion || 1), scope: product.sourceStateId ? { stateId: String(product.sourceStateId) } : undefined };
  publishRealtime({ type: 'catalog.updated', entityType: 'product', ...event }, { public: true, admin: true });
  publishRealtime({ type: 'home.updated', entityType: 'product', ...event }, { public: true, admin: true });
  publishRealtime({ type: 'admin.dashboard.updated', ...event }, { admin: true });
}

async function marketAssociateForProduct(accountId: string, identifier: string) {
  const marketAssociate = await MarketAssociateProfile.findOne({ accountId, status: 'active' }).lean();
  if (!marketAssociate) throw new HttpError(403, 'Active Market Associate profile required', undefined, 'ACCESS_DENIED');
  const product = await byProductIdentifier<any>(identifier);
  const marketAssociateId = product.sourceMarketAssociateId || product.commercialApproval?.sourceMarketAssociateId;
  const assignment = await MarketAssociateMarketAssignment.findOne({ marketAssociateId: marketAssociate._id.toString(), marketId: product.marketId, status: 'active', activeFrom: { $lte: new Date() }, $or: [{ activeTo: { $exists: false } }, { activeTo: null }, { activeTo: { $gt: new Date() } }] }).lean();
  if (!assignment) throw new HttpError(403, 'An active Market assignment is required', undefined, 'RUNNER_MARKET_ASSIGNMENT_REQUIRED');
  if (marketAssociateId && marketAssociateId !== marketAssociate._id.toString()) {
    const sourceMarketAssociate = await MarketAssociateProfile.findById(marketAssociateId).select('status').lean();
    if (sourceMarketAssociate?.status === 'active') throw new HttpError(403, 'This availability check belongs to another Market Associate', undefined, 'SCOPE_DENIED');
  }
  if (product.availabilityStatus !== ProductAvailabilityStatus.UNCONFIRMED) throw new HttpError(409, 'This Product has no pending availability check', undefined, 'AVAILABILITY_CHECK_NOT_PENDING');
  return { marketAssociate, product };
}

export class CatalogAvailabilityService {
  async request(identifier: string, input: { reason: string; version: number }, actorId: string, stateIds?: string[]) {
    const product = await byProductIdentifier<any>(identifier);
    if (stateIds?.length && (!product.sourceStateId || !stateIds.includes(product.sourceStateId))) throw new HttpError(404, 'Product not found', undefined, 'NOT_FOUND');
    if (![ProductStatus.PUBLISHED, ProductStatus.PAUSED, ProductStatus.AVAILABILITY_UNCONFIRMED].includes(product.status)) throw new HttpError(409, 'This Product cannot enter an availability check', undefined, 'INVALID_STATE_TRANSITION');
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).lean();
    const days = Math.min(Math.max(Number(settings?.catalogAvailabilityCheckDays || 4), 1), 30);
    const now = new Date();
    const updated = await Product.findOneAndUpdate(
      versionFilter(product, input.version),
      {
        $set: {
          status: ProductStatus.AVAILABILITY_UNCONFIRMED,
          availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
          availabilityPreviousStatus: product.status === ProductStatus.AVAILABILITY_UNCONFIRMED ? product.availabilityPreviousStatus || ProductStatus.PUBLISHED : product.status,
          availabilityCheckRequestedAt: now,
          availabilityCheckDueAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
          availabilityCheckRequestedBy: actorId,
          availabilityCheckNote: input.reason,
          customerAvailabilityNote: 'Temporarily unavailable while availability is being confirmed.',
        },
        $unset: { availabilityEscalatedAt: 1, availabilityValidUntil: 1 },
        $inc: { catalogVersion: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This Product was updated elsewhere', undefined, 'STALE_VERSION');
    await new MarketVendorService().notifyAvailability(actorId, updated);
    publishUpdate(updated);
    return updated;
  }

  async confirm(accountId: string, identifier: string, input: { status: 'available' | 'limited'; note?: string; version: number }) {
    const { product } = await marketAssociateForProduct(accountId, identifier);
    const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('catalogAvailabilityCheckDays').lean();
    const days = Math.min(Math.max(Number(settings?.catalogAvailabilityCheckDays || 4), 1), 30);
    const confirmedAt = new Date();
    const nextStatus = product.availabilityPreviousStatus === ProductStatus.PUBLISHED && product.commercialApproval?.approved === true ? ProductStatus.PUBLISHED : product.status === ProductStatus.AVAILABILITY_UNCONFIRMED ? ProductStatus.DRAFT : product.status;
    const updated = await Product.findOneAndUpdate(
      versionFilter(product, input.version),
      {
        $set: {
          status: nextStatus,
          availabilityStatus: input.status === 'available' ? ProductAvailabilityStatus.AVAILABLE : ProductAvailabilityStatus.LIMITED,
          availabilityCheckNote: input.note,
          customerAvailabilityNote: input.status === 'limited'
            ? 'Limited availability. Order while it is still available.'
            : 'Available from a verified Hook Market.',
          lastAvailabilityConfirmedAt: confirmedAt,
          availabilityValidUntil: new Date(confirmedAt.getTime() + days * 24 * 60 * 60 * 1000),
        },
        $unset: { availabilityPreviousStatus: 1, availabilityCheckDueAt: 1, availabilityEscalatedAt: 1 },
        $inc: { catalogVersion: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This Product was updated elsewhere', undefined, 'STALE_VERSION');
    publishUpdate(updated);
    return updated;
  }

  async report(accountId: string, identifier: string, input: { note: string; version: number }) {
    const { product } = await marketAssociateForProduct(accountId, identifier);
    const updated = await Product.findOneAndUpdate(
      versionFilter(product, input.version),
      {
        $set: {
          status: ProductStatus.PAUSED,
          availabilityStatus: ProductAvailabilityStatus.UNAVAILABLE,
          availabilityCheckNote: input.note,
          customerAvailabilityNote: 'This Product is currently unavailable.',
        },
        $unset: { availabilityCheckDueAt: 1, availabilityValidUntil: 1 },
        $inc: { catalogVersion: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) throw new HttpError(409, 'This Product was updated elsewhere', undefined, 'STALE_VERSION');
    publishUpdate(updated);
    return updated;
  }
}

export async function escalateOverdueAvailabilityChecks() {
  const now = new Date();
  const expired = await Product.find({
    status: ProductStatus.PUBLISHED,
    availabilityStatus: { $in: [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED] },
    availabilityValidUntil: { $lte: now },
    deletedAt: { $exists: false },
  }).select('_id publicId title marketId sourceStateId status catalogVersion').limit(100).lean({ virtuals: true });
  const notifier = new MarketVendorService();
  for (const product of expired) {
    const updated = await Product.findOneAndUpdate(
      {
        _id: product._id,
        status: ProductStatus.PUBLISHED,
        availabilityValidUntil: { $lte: now },
      },
      {
        $set: {
          status: ProductStatus.AVAILABILITY_UNCONFIRMED,
          availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
          availabilityPreviousStatus: ProductStatus.PUBLISHED,
          availabilityCheckRequestedAt: now,
          availabilityCheckDueAt: now,
          availabilityEscalatedAt: now,
          availabilityCheckNote: 'Market Associate confirmation required before this Product can return to sale.',
          customerAvailabilityNote: 'Temporarily unavailable while availability is being confirmed.',
        },
        $unset: { availabilityValidUntil: 1 },
        $inc: { catalogVersion: 1 },
      },
      { returnDocument: 'after' },
    ).lean({ virtuals: true });
    if (!updated) continue;
    await notifier.notifyAvailability('system', updated);
    publishUpdate(updated);
  }
  const products = await Product.find({
    availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED,
    availabilityCheckDueAt: { $lt: new Date() },
    availabilityEscalatedAt: { $exists: false },
    deletedAt: { $exists: false },
  }).select('publicId title marketId sourceStateId availabilityCheckDueAt catalogVersion').limit(100).lean({ virtuals: true });
  let escalated = 0;
  for (const product of products) {
    const recipients = await notifier.notifyAvailabilityOverdue(product);
    if (!recipients) continue;
    const result = await Product.updateOne(
      { _id: product._id, availabilityEscalatedAt: { $exists: false } },
      { $set: { availabilityEscalatedAt: new Date() } },
    );
    if (result.modifiedCount) escalated += 1;
  }
  return escalated;
}
