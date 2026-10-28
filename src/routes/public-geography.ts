import { publicBanners } from '@controllers/admin/banners.controller';
import { Router } from 'express';
import { categoryService } from '@modules/catalog/category.service';
import { isValidObjectId } from 'mongoose';
import { OperationCity, OperationLocalGovernment, OperationState } from '@models/platform/geography.model';
import { Market } from '@models/platform/network.model';
import { Category } from '@models/categories/category.model';
import { Product } from '@models/products/product.model';
import { ProductStatus } from '@lib/constants';
import { presentMarketRecords } from '@modules/platform/platform-presentation.service';
import { asyncHandler, HttpError, sendSuccess } from '@utils/http';
import { PublicCatalogController } from '@controllers/public-catalog.controller';
import { PublicController } from '@controllers/public.controller';
import { sharedCache } from '@modules/platform/cache.service';

async function resolveId(model: any, identifier: unknown, extraField?: string) {
  const value = String(identifier || '').trim();
  if (!value) return undefined;
  const clauses: Record<string, unknown>[] = [{ publicId: value }];
  if (extraField) clauses.push({ [extraField]: value.toUpperCase() });
  if (isValidObjectId(value)) clauses.push({ _id: value });
  const record = await model.findOne({ $or: clauses }).select('_id').lean();
  if (!record) throw new HttpError(404, 'Geography filter not found', undefined, 'NOT_FOUND');
  return record._id.toString();
}

function safeMarket(market: any) {
  return {
    publicId: market.publicId,
    name: market.name,
    shortDisplayName: market.shortDisplayName || market.name,
    address: market.address || null,
    imageUrl: market.imageUrl || null,
    discoveryColor: market.discoveryColor || '#FF8A62',
    isFeatured: Boolean(market.isFeatured),
    displayPriority: market.displayPriority ?? 100,
    coordinates: market.coordinates || null,
    operatingHours: market.operatingHours || null,
    state: market.state,
    city: market.city,
    zone: market.zone,
  };
}

export function createPublicGeographyRouter() {
  const router = Router();
  const catalog = new PublicCatalogController();
  const publicController = new PublicController();
  router.get('/home', asyncHandler(catalog.home));
  router.get('/discover', asyncHandler(catalog.discover));
  router.get('/products', asyncHandler(catalog.products));
  router.get('/products/status', asyncHandler(catalog.statuses));
  router.get('/products/:id', asyncHandler(catalog.product));
  router.get('/banners', asyncHandler(publicBanners));
  router.get('/categories', asyncHandler(catalog.categories));
  router.get('/categories/tree', asyncHandler(catalog.categories));
  router.get('/search', asyncHandler(catalog.search));
  router.get('/search/suggestions', asyncHandler(catalog.suggestions));
  router.get('/operating-states', asyncHandler(publicController.getOperatingStates));
  const deliveryStates = asyncHandler(async (_req, res) => {
    const cacheKey = 'public:states';
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const states = await OperationState.find({ countryCode: 'NG', status: 'active', deliveryEnabled: { $ne: false } })
      .select('publicId name capitalName code timezone currency deliveryPromiseHours payAtHubEnabled deliveryEnabled')
      .sort({ name: 1 }).lean({ virtuals: true });
    const response = states.map((state: any) => ({
      publicId: state.publicId,
      name: state.name,
      capitalName: state.capitalName,
      code: state.code,
      timezone: state.timezone,
      currency: state.currency,
      deliveryPromiseHours: state.deliveryPromiseHours,
      payAtHubEnabled: state.payAtHubEnabled,
      deliveryEnabled: state.deliveryEnabled !== false,
    }));
    await lookup.store(response);
    sendSuccess(res, response);
  });
  router.get('/delivery-states', deliveryStates);
  router.get('/states', deliveryStates);
  const deliveryLgas = asyncHandler(async (req, res) => {
    const cacheKey = `public:lgas:${req.params.stateId}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const state = await OperationState.findOne({
      _id: await resolveId(OperationState, req.params.stateId),
      countryCode: 'NG',
      status: 'active',
      deliveryEnabled: { $ne: false },
    }).select('_id publicId name capitalName code').lean({ virtuals: true });
    if (!state) throw new HttpError(404, 'Delivery State not found', undefined, 'NOT_FOUND');
    const rows = await OperationLocalGovernment.find({ stateId: String(state._id), status: 'active' })
      .select('publicId stateId name normalizedName')
      .sort({ name: 1 })
      .lean({ virtuals: true });
    const response = {
      state: { publicId: state.publicId, name: state.name, capitalName: state.capitalName, code: state.code },
      data: rows.map((row: any) => ({ publicId: row.publicId, stateId: state.publicId, name: row.name })),
    };
    await lookup.store(response);
    sendSuccess(res, response);
  });
  router.get('/delivery-states/:stateId/lgas', deliveryLgas);
  router.get('/states/:stateId/lgas', deliveryLgas);
  router.get('/cities', asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { status: 'active' };
    if (req.query.stateId) filter.stateId = req.query.stateId;
    sendSuccess(res, await OperationCity.find(filter).select('publicId stateId name code').sort({ name: 1 }).lean({ virtuals: true }));
  }));
  router.get('/markets', asyncHandler(async (req, res) => {
    const cacheKey = `public:markets:${String(req.query.stateCode || req.query.stateId || 'all')}:${String(req.query.cityId || 'all')}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const filter: Record<string, unknown> = { status: 'active' };
    const stateIdentifier = req.query.stateCode || req.query.stateId;
    const stateId = stateIdentifier ? await resolveId(OperationState, stateIdentifier, 'code') : undefined;
    const cityId = req.query.cityId ? await resolveId(OperationCity, req.query.cityId) : undefined;
    if (stateId) filter.stateId = stateId;
    if (cityId) filter.cityId = cityId;
    const markets = await Market.find(filter)
      .select('publicId name shortDisplayName stateId cityId zoneId address imageUrl discoveryColor isFeatured displayPriority coordinates operatingHours status')
      .sort({ isFeatured: -1, displayPriority: 1, name: 1 })
      .lean({ virtuals: true });
    const presented = await presentMarketRecords(markets);
    const response = presented.map(safeMarket);
    await lookup.store(response);
    sendSuccess(res, response);
  }));
  router.get('/markets/:id/categories', asyncHandler(async (req, res) => {
    const cacheKey = `public:market-categories:${req.params.id}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const marketId = await resolveId(Market, req.params.id);
    // One aggregate gives both which categories exist here and how many products each holds; the tree loads alongside it.
    const [counts, tree] = await Promise.all([
      Product.aggregate([
        { $match: { marketId, status: ProductStatus.PUBLISHED, publishedAt: { $lte: new Date() }, deletedAt: { $exists: false } } },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      ]),
      categoryService.tree(),
    ]);
    const categoryIds = counts.map((item: any) => item._id);
    const countMap = new Map(counts.map((item: any) => [String(item._id), item.count]));
    // Products sit in sub-categories, so show the top-level categories that
    // contain any, with the rolled-up count and the sub-categories present.
    const response = tree
      .map((root: any) => {
        const children = (root.children || [])
          .map((child: any) => ({ ...child, productCount: countMap.get(child.internalId) || 0 }))
          .filter((child: any) => child.productCount > 0);
        const own = countMap.get(root.internalId) || 0;
        return { root, children, productCount: own + children.reduce((sum: number, child: any) => sum + child.productCount, 0) };
      })
      .filter((entry: any) => entry.productCount > 0 && categoryIds.length)
      .map(({ root, children, productCount }: any) => ({
        publicId: root.publicId,
        name: root.name,
        slug: root.slug,
        iconUrl: root.iconUrl || null,
        description: root.description || '',
        productCount,
        children: children.map((child: any) => ({
          publicId: child.publicId,
          name: child.name,
          slug: child.slug,
          iconUrl: child.iconUrl || null,
          productCount: child.productCount,
        })),
      }));
    await lookup.store(response);
    sendSuccess(res, response);
  }));
  router.get('/markets/:id', asyncHandler(async (req, res) => {
    const cacheKey = `public:market:${req.params.id}`;
    const lookup = await sharedCache.lookup<any>("catalog", cacheKey);
    if (lookup.hit) {
      sendSuccess(res, lookup.value);
      return;
    }
    const marketId = await resolveId(Market, req.params.id);
    const market = await Market.findOne({ _id: marketId, status: 'active' })
      .select('publicId name shortDisplayName stateId cityId zoneId address imageUrl discoveryColor isFeatured displayPriority coordinates operatingHours status')
      .lean({ virtuals: true });
    if (!market) throw new HttpError(404, 'Market not found', undefined, 'NOT_FOUND');
    const response = safeMarket(await presentMarketRecords(market));
    await lookup.store(response, 30_000);
    sendSuccess(res, response);
  }));
  return router;
}
