import { Category } from '@models/categories/category.model';
import { Market } from '@models/platform/network.model';
import { OperationState } from '@models/platform/geography.model';
import { MarketAssociateProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { CatalogMediaAsset } from '@models/catalog/catalog.model';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { Product } from '@models/products/product.model';
import { CatalogMediaService } from '@modules/catalog/catalog-media.service';

const isObjectId = (value: string) => /^[a-f\d]{24}$/i.test(value);

/** Every distinct, non-empty id a set of records carries for one field, as strings. */
function idsOf(records: any[], pick: (record: any) => unknown): string[] {
  const values = records.map(pick).filter((value) => value !== undefined && value !== null && value !== '');
  return [...new Set(values.map(String))];
}

/** A lookup by both internal id and publicId, so either form of reference resolves. */
function keyBy<T extends { _id?: unknown; publicId?: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (row._id !== undefined) map.set(String(row._id), row);
    if (row.publicId) map.set(row.publicId, row);
  }
  return map;
}

function findByEitherId<T extends { _id?: unknown; publicId?: string }>(model: { find: (query: object) => { select: (fields: string) => { lean: (options: object) => Promise<T[]> } } }, ids: string[], fields: string) {
  if (!ids.length) return Promise.resolve([] as T[]);
  return model.find({
    $or: [
      { publicId: { $in: ids } },
      ...(ids.some(isObjectId) ? [{ _id: { $in: ids.filter(isObjectId) } } as never] : []),
    ],
  }).select(fields).lean({ virtuals: true }) as Promise<T[]>;
}

/** Market Associate name for one record — profile then account, unbatched. Used for single-record reads. */
async function marketAssociateName(record: any) {
  if (record.marketAssociate?.publicId) return record.marketAssociate;
  if (!record.marketAssociateId) return null;
  const profile = await MarketAssociateProfile.findById(record.marketAssociateId).select('publicId accountId').lean({ virtuals: true });
  if (!profile) return null;
  const account = await User.findById(profile.accountId).select('firstName lastName').lean();
  const name = [account?.firstName, account?.lastName].filter(Boolean).join(' ').trim();
  return { publicId: profile.publicId, name: name || undefined };
}

/** Market Associate name, by internal id or publicId — profile and account, batched. Used for list reads. */
async function loadMarketAssociateNames(marketAssociateIds: string[]): Promise<Map<string, { publicId: string; name?: string }>> {
  if (!marketAssociateIds.length) return new Map();
  const profiles = await findByEitherId<{ _id: unknown; publicId: string; accountId: string }>(MarketAssociateProfile as never, marketAssociateIds, 'publicId accountId');
  const accountIds = [...new Set(profiles.map((profile) => String(profile.accountId)))];
  const accounts = accountIds.length
    ? await User.find({ _id: { $in: accountIds } }).select('firstName lastName').lean()
    : [];
  const accountById = new Map(accounts.map((account: any) => [String(account._id), account]));
  const byKey = new Map<string, { publicId: string; name?: string }>();
  for (const profile of profiles) {
    const account = accountById.get(String(profile.accountId));
    const name = [account?.firstName, account?.lastName].filter(Boolean).join(' ').trim();
    const value = { publicId: profile.publicId, name: name || undefined };
    byKey.set(String(profile._id), value);
    if (profile.publicId) byKey.set(profile.publicId, value);
  }
  return byKey;
}

type Resolved = {
  market: any;
  category: any;
  state: any;
  marketAssociate: { publicId: string; name?: string } | null;
  media: any[];
  product: any;
  marketVendor: any;
};

/** The shared submission shape both the single-record and batched presenters return. */
function format(record: any, resolved: Resolved, mediaService: CatalogMediaService) {
  const { market, category, state, marketAssociate, product, marketVendor } = resolved;
  const media = resolved.media.map((asset: any) => ({
    ...asset,
    deliveryUrl: asset.deliveryUrl
      || (asset.deliveryType === 'external' ? asset.secureUrl : mediaService.deliveryUrl(asset)),
  }));
  return {
    id: record.publicId,
    publicId: record.publicId,
    marketAssociate: marketAssociate ? { publicId: marketAssociate.publicId, name: marketAssociate.name } : null,
    marketId: market?.publicId,
    market: market ? { publicId: market.publicId, name: market.name } : null,
    sourceStateId: state?.publicId,
    sourceState: state ? { publicId: state.publicId, name: state.name, code: state.code } : null,
    categorySuggestionId: category?.publicId,
    category: category ? { publicId: category.publicId, name: category.name, slug: category.slug } : null,
    marketVendorId: marketVendor?.publicId || record.marketVendorId,
    marketVendor: marketVendor ? { publicId: marketVendor.publicId, businessName: marketVendor.businessName, contactName: marketVendor.contactName } : null,
    internalSellerReference: record.internalSellerReference,
    basicTitle: record.basicTitle,
    notes: record.notes,
    mediaIds: media.map((asset: any) => asset.publicId),
    media: media.map((asset: any) => ({
      publicId: asset.publicId,
      deliveryUrl: asset.deliveryUrl,
      width: asset.width,
      height: asset.height,
      format: asset.format,
    })),
    imageUrl: media[0]?.deliveryUrl,
    basePriceMinor: record.basePriceMinor,
    currency: record.currency,
    variants: record.variants || [],
    availabilityStatus: record.availabilityStatus,
    availabilityNote: record.availabilityNote,
    status: record.status,
    reviewNotes: record.reviewNotes || [],
    submittedAt: record.submittedAt,
    reviewStartedAt: record.reviewStartedAt,
    reviewedAt: record.reviewedAt,
    productId: product?.publicId,
    approvedProduct: product ? {
      publicId: product.publicId,
      sellingPriceMinor: product.sellingPriceMinor ?? Number(product.sellingPrice || 0) * 100,
      minimumPriceMinor: Number(product.minAcceptablePrice || 0) * 100,
      observedCostMinor: Number(product.costPrice || 0) * 100,
      currency: product.currency || record.currency,
      status: product.status,
      publishedAt: product.publishedAt,
    } : null,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** One submission, resolved with its own set of lookups. Used for single-record reads (e.g. detail views). */
export async function presentSubmission(record: any) {
  const [market, category, state, marketAssociate, rawMedia, product, marketVendor] = await Promise.all([
    record.market?.publicId
      ? record.market
      : Market.findById(record.marketId).select('publicId name').lean({ virtuals: true }),
    record.category?.publicId
      ? record.category
      : Category.findById(record.categorySuggestionId).select('publicId name slug').lean({ virtuals: true }),
    OperationState.findById(record.sourceStateId).select('publicId name code').lean({ virtuals: true }),
    marketAssociateName(record),
    record.media
      ? record.media
      : CatalogMediaAsset.find({
          $or: [
            { publicId: { $in: record.mediaIds || [] } },
            { _id: { $in: (record.mediaIds || []).filter((id: string) => isObjectId(id)) } },
          ],
          status: 'ready',
        }).sort({ order: 1 }).lean({ virtuals: true }),
    record.productId
      ? Product.findById(record.productId).select('publicId sellingPriceMinor minAcceptablePrice sellingPrice costPrice currency status publishedAt').lean({ virtuals: true })
      : null,
    record.marketVendorId
      ? MarketVendor.findOne({ $or: [{ publicId: record.marketVendorId }, { _id: record.marketVendorId }] }).select('publicId businessName contactName').lean({ virtuals: true })
      : null,
  ]);
  return format(record, { market, category, state, marketAssociate, media: rawMedia, product, marketVendor }, new CatalogMediaService());
}

/**
 * A page of submissions, resolved together: one batched query per related collection instead of up to 7 per row.
 * Produces exactly the shape `presentSubmission` returns for each record — see `format` above, defined once and
 * shared by both paths so a list and a detail view can never drift apart.
 */
export async function presentSubmissions(records: any[]) {
  if (!records.length) return [];

  const marketIds = idsOf(records, (record) => (record.market?.publicId ? null : record.marketId));
  const categoryIds = idsOf(records, (record) => (record.category?.publicId ? null : record.categorySuggestionId));
  const stateIds = idsOf(records, (record) => record.sourceStateId);
  const marketAssociateIds = idsOf(records, (record) => (record.marketAssociate?.publicId ? null : record.marketAssociateId));
  const productIds = idsOf(records, (record) => record.productId);
  const marketVendorIds = idsOf(records, (record) => record.marketVendorId);
  const uniqueMediaIds = [...new Set(records.flatMap((record) => (record.media ? [] : record.mediaIds || [])).map(String))];

  const [markets, categories, states, mediaAssets, products, marketVendors, marketAssociateByKey] = await Promise.all([
    findByEitherId(Market as never, marketIds, 'publicId name'),
    findByEitherId(Category as never, categoryIds, 'publicId name slug'),
    findByEitherId(OperationState as never, stateIds, 'publicId name code'),
    uniqueMediaIds.length
      ? CatalogMediaAsset.find({
          $or: [
            { publicId: { $in: uniqueMediaIds } },
            { _id: { $in: uniqueMediaIds.filter(isObjectId) } },
          ],
          status: 'ready',
        }).sort({ order: 1 }).lean({ virtuals: true })
      : Promise.resolve([]),
    findByEitherId(Product as never, productIds, 'publicId sellingPriceMinor minAcceptablePrice sellingPrice costPrice currency status publishedAt'),
    findByEitherId(MarketVendor as never, marketVendorIds, 'publicId businessName contactName'),
    loadMarketAssociateNames(marketAssociateIds),
  ]);

  const marketByKey = keyBy(markets);
  const categoryByKey = keyBy(categories);
  const stateByKey = keyBy(states);
  const productByKey = keyBy(products);
  const marketVendorByKey = keyBy(marketVendors);
  const mediaService = new CatalogMediaService();

  return records.map((record) => {
    const market = record.market?.publicId ? record.market : marketByKey.get(String(record.marketId));
    const category = record.category?.publicId ? record.category : categoryByKey.get(String(record.categorySuggestionId));
    const state = stateByKey.get(String(record.sourceStateId));
    const marketAssociate = record.marketAssociate?.publicId ? record.marketAssociate : marketAssociateByKey.get(String(record.marketAssociateId)) ?? null;
    const product = record.productId ? productByKey.get(String(record.productId)) : null;
    const marketVendor = record.marketVendorId ? marketVendorByKey.get(String(record.marketVendorId)) : null;
    // The global media fetch is sorted by `order`; filtering to this record's own ids keeps that same relative order.
    const idSet = new Set((record.mediaIds || []).map(String));
    const media = record.media
      ? record.media
      : mediaAssets.filter((asset: any) => idSet.has(asset.publicId) || idSet.has(String(asset._id)));
    return format(record, { market, category, state, marketAssociate, media, product, marketVendor }, mediaService);
  });
}

export function presentCommercialSummary(record: any) {
  return {
    id: record.publicId,
    publicId: record.publicId,
    title: record.title,
    slug: record.slug,
    description: record.description,
    status: record.status,
    catalogVersion: record.catalogVersion,
    pricing: record.pricing,
    negotiationRules: record.negotiationRules,
    availabilityStatus: record.availabilityStatus,
    customerAvailabilityNote: record.customerAvailabilityNote,
    category: record.category ? {
      publicId: record.category.publicId,
      name: record.category.name,
      slug: record.category.slug,
    } : null,
    market: record.market ? {
      publicId: record.market.publicId,
      name: record.market.name,
    } : null,
    variants: (record.variants || []).map((variant: any) => ({
      publicId: variant.publicId,
      size: variant.size,
      colour: variant.colour,
      attributes: variant.attributes || {},
      active: variant.active,
    })),
    media: (record.media || []).map((asset: any) => ({
      publicId: asset.publicId,
      deliveryUrl: asset.deliveryUrl,
      secureUrl: asset.secureUrl,
      width: asset.width,
      height: asset.height,
      format: asset.format,
    })),
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
  };
}
