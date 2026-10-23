import { Request, Response } from 'express';
import { categoryService } from '@modules/catalog/category.service';
import { ProductStatus } from '@lib/constants';
import { getPagination, paginated } from '@lib/api-utils';
import { Category } from '@models/categories/category.model';
import { OperationState } from '@models/platform/geography.model';
import { LegalContent } from '@models/platform/legal-content.model';
import { Product } from '@models/products/product.model';
import { sendSuccess } from '@utils/http';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { publicProduct } from '@lib/public-resource';
import { DEFAULT_RETURNS_POLICY_HTML } from '@lib/legal-defaults';
import { WaitlistService } from '@modules/notifications/waitlist.service';
import { getEmailSettings } from '@modules/notifications/email-settings.service';
import { Faq } from '@models/platform/faq.model';

const routeParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value || '';

const PRODUCT_FIELDS = 'publicId hookId title slug description costPrice sellingPrice discountedPrice minAcceptablePrice sellingPriceMinor discountMinor currency quantity reservedQuantity colors sizes images status categoryId createdAt updatedAt';

function safeProduct(product: any) {
  if (!product) return product;
  const { _id, ...safe } = product;
  if (safe.category) {
    const { _id: categoryId, ...category } = safe.category;
    safe.category = { ...category, id: category.publicId || category.id || categoryId?.toString?.() };
  }
  return publicProduct(safe);
}

async function attachCategories(products: any[]) {
  if (!products.length) return products;
  const categoryIds = [...new Set(products.map((product) => String(product.categoryId || '')).filter(Boolean))];
  const objectIds = categoryIds.filter((value) => /^[a-f\d]{24}$/i.test(value));
  const categories = await Category.find({
    $or: [
      { publicId: { $in: categoryIds } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  }).select('publicId name slug iconUrl').lean({ virtuals: true });
  const map = new Map<string, any>();
  (categories as any[]).forEach((category) => {
    const { _id, ...safeCategory } = category;
    const value = { ...safeCategory, id: safeCategory.publicId || safeCategory.id || _id?.toString?.() };
    map.set(String(_id), value);
    if (category.publicId) map.set(String(category.publicId), value);
  });
  return products.map((product) => ({ ...product, category: map.get(String(product.categoryId)) }));
}

function searchExpression(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

const LEGAL_DEFAULT_TITLES: Record<string, string> = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  returns: 'Returns Policy',
};

export class PublicController {
  private readonly waitlist = new WaitlistService();

  joinWaitlist = async (req: Request, res: Response) => {
    const result = await this.waitlist.join(req.body);
    sendSuccess(res, result);
  };

  /** Clicked directly from an email, so this renders a plain confirmation page rather than JSON. */
  unsubscribeWaitlist = async (req: Request, res: Response) => {
    const { unsubscribed } = await this.waitlist.unsubscribe(routeParam(req.params.token));
    res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#FAFAF8;color:#17140f;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#6b6355;line-height:1.6}</style></head><body><main><h1>${unsubscribed ? "You're unsubscribed" : 'Link not recognized'}</h1><p>${unsubscribed ? "You won't receive any more emails from Hook's waitlist. If you already have a Hook account, this doesn't affect it." : 'This unsubscribe link is invalid or has already been used.'}</p></main></body></html>`);
  };

  getLegalContent = async (req: Request, res: Response) => {
    const type = routeParam(req.params.type);
    if (type !== 'terms' && type !== 'privacy' && type !== 'returns') {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown legal document type' } });
      return;
    }
    const doc = await LegalContent.findOne({ type }).lean();
    sendSuccess(res, {
      type,
      title: doc?.title || LEGAL_DEFAULT_TITLES[type],
      bodyHtml: doc?.bodyHtml || (type === 'returns' ? DEFAULT_RETURNS_POLICY_HTML : ''),
      version: doc?.version || 0,
      effectiveDate: doc?.effectiveDate || null,
    });
  };

  getProducts = async (req: Request, res: Response) => {
    const { page, limit, skip } = getPagination(req.query);
    const where: Record<string, any> = { status: ProductStatus.APPROVED };
    if (typeof req.query.categoryId === 'string') where.categoryId = { $in: await categoryService.descendantIds(req.query.categoryId) };
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const minPrice = typeof req.query.minPrice === 'string' ? Number(req.query.minPrice) : undefined;
    const maxPrice = typeof req.query.maxPrice === 'string' ? Number(req.query.maxPrice) : undefined;
    if (q) where.$or = [{ title: searchExpression(q) }, { description: searchExpression(q) }];
    if (Number.isFinite(minPrice)) where.sellingPrice = { ...(where.sellingPrice || {}), $gte: minPrice };
    if (Number.isFinite(maxPrice)) where.sellingPrice = { ...(where.sellingPrice || {}), $lte: maxPrice };
    const [rows, total] = await Promise.all([
      Product.find(where).select(PRODUCT_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean({ virtuals: true }),
      Product.countDocuments(where),
    ]);
    const products = await attachCategories(rows as any[]);
    sendSuccess(res, paginated(products.map(safeProduct), total, page, limit));
  };

  getProduct = async (req: Request, res: Response) => {
    const identifier = routeParam(req.params.id);
    const identity = /^[a-f\d]{24}$/i.test(identifier)
      ? { $or: [{ _id: identifier }, { publicId: identifier }, { hookId: identifier }, { slug: identifier }] }
      : { $or: [{ publicId: identifier }, { hookId: identifier }, { slug: identifier }] };
    const product = await Product.findOne(identity).select(PRODUCT_FIELDS).lean({ virtuals: true });
    const [withCategory] = await attachCategories(product ? [product] : []);
    sendSuccess(res, safeProduct(withCategory));
  };

  getCategories = async (_req: Request, res: Response) => {
    const categories = await Category.find({ isActive: true, deletedAt: { $exists: false } })
      .select('publicId name slug iconUrl description sortOrder isActive parentId')
      .sort({ name: 1 })
      .lean({ virtuals: true });
    sendSuccess(res, categories.map((category: any) => safeProduct(category)));
  };

  getCategoryTree = async (_req: Request, res: Response) => {
    const categories = await Category.find({ isActive: true, deletedAt: { $exists: false } })
      .select('publicId name slug iconUrl description sortOrder isActive parentId')
      .sort({ sortOrder: 1, name: 1 })
      .lean({ virtuals: true });
    const map = new Map<string, any>();
    const rows = (categories as any[]).map((category) => {
      const { _id, ...safe } = category;
      const value = { ...safe, id: safe.publicId || safe.id || _id?.toString?.(), children: [] };
      map.set(String(_id), value);
      if (category.publicId) map.set(String(category.publicId), value);
      return value;
    });
    rows.forEach((category) => {
      const parent = category.parentId ? map.get(String(category.parentId)) : undefined;
      if (parent) parent.children.push(category);
    });
    sendSuccess(res, rows.filter((category) => !category.parentId));
  };

  getCategory = async (req: Request, res: Response) => {
    const identifier = routeParam(req.params.id);
    const identity = /^[a-f\d]{24}$/i.test(identifier)
      ? { $or: [{ _id: identifier }, { publicId: identifier }, { slug: identifier }] }
      : { $or: [{ publicId: identifier }, { slug: identifier }] };
    const category = await Category.findOne(identity).select('publicId name slug iconUrl description sortOrder isActive parentId').lean({ virtuals: true });
    sendSuccess(res, safeProduct(category));
  };

  homeFeed = async (_req: Request, res: Response) => {
    const [featuredProducts, categories] = await Promise.all([
      Product.find({ status: ProductStatus.APPROVED }).select(PRODUCT_FIELDS).sort({ createdAt: -1 }).limit(12).lean({ virtuals: true }),
      Category.find({ isActive: true, deletedAt: { $exists: false } }).select('publicId name slug iconUrl sortOrder').sort({ sortOrder: 1, name: 1 }).limit(12).lean({ virtuals: true }),
    ]);
    const products = await attachCategories(featuredProducts as any[]);
    sendSuccess(res, { featuredProducts: products.map(safeProduct), categories: categories.map((category: any) => safeProduct(category)) });
  };

  /** What customers earn and are given in Hook credit, as the admin has set it. */
  // Single source of truth for "Help & Support" across every client, signed in or not.
  support = async (_req: Request, res: Response) => {
    const settings = await getEmailSettings();
    sendSuccess(res, { supportEmail: settings.supportEmail, supportUrl: settings.supportUrl, helpCenterUrl: settings.helpCenterUrl });
  };

  // Admin-managed questions shown on the /help page and in the app.
  faqs = async (_req: Request, res: Response) => {
    const data = await Faq.find({ isActive: true }).sort({ order: 1, createdAt: 1 }).select('publicId question answer').lean();
    sendSuccess(res, data.map((faq) => ({ id: faq.publicId, question: faq.question, answer: faq.answer })));
  };

  creditConfig = async (_req: Request, res: Response) => {
    const settings = await CommerceSettings.findOne({ key: 'commerce' })
      .select('orderEarnEnabled orderEarnPercent orderEarnMaxMinor creditSpendCapPercent welcomeBonusMinor referralSignupBonusMinor referralReferrerBonusMinor minimumCheckoutMinor')
      .lean();
    sendSuccess(res, {
      orderEarnEnabled: settings?.orderEarnEnabled ?? true,
      orderEarnPercent: settings?.orderEarnPercent ?? 1,
      orderEarnMaxMinor: settings?.orderEarnMaxMinor ?? 0,
      creditSpendCapPercent: settings?.creditSpendCapPercent ?? 20,
      welcomeBonusMinor: settings?.welcomeBonusMinor ?? 30000,
      referralSignupBonusMinor: settings?.referralSignupBonusMinor ?? 30000,
      referralReferrerBonusMinor: settings?.referralReferrerBonusMinor ?? 100000,
      // Guests need the minimum too: it is a cart rule, not an account one.
      minimumCheckoutMinor: settings?.minimumCheckoutMinor ?? 1800000,
    });
  };

  getOperatingStates = async (_req: Request, res: Response) => {
    const states = await OperationState.find({
      countryCode: 'NG',
      status: 'active',
      operationsEnabled: true,
    })
      .select('publicId code name capitalName operationsEnabled deliveryEnabled deliveryFeeMinor deliveryPromiseHours podEnabled podLimitMinor podMinimumOrderMinor')
      .sort({ name: 1 })
      .lean({ virtuals: true });
    sendSuccess(res, (states as any[]).map((state) => ({
      publicId: state.publicId,
      code: state.code,
      name: state.name,
      capitalName: state.capitalName,
      operationsEnabled: true,
      deliveryEnabled: state.deliveryEnabled !== false,
      deliveryFeeMinor: state.deliveryFeeMinor,
      deliveryPromiseHours: state.deliveryPromiseHours,
      podEnabled: state.podEnabled === true,
      podLimitMinor: state.podLimitMinor ?? null,
      podMinimumOrderMinor: state.podMinimumOrderMinor ?? null,
    })));
  };

  search = async (req: Request, res: Response) => {
    const q = String(req.query.q || req.query.query || '').trim();
    if (!q) return sendSuccess(res, { products: [] });
    const products = await Product.find({ status: ProductStatus.APPROVED, $or: [{ title: searchExpression(q) }, { description: searchExpression(q) }] })
      .select(PRODUCT_FIELDS)
      .sort({ createdAt: -1 })
      .limit(20)
      .lean({ virtuals: true });
    const withCategories = await attachCategories(products as any[]);
    return sendSuccess(res, {
      products: withCategories.map(safeProduct),
    });
  };

  suggestions = async (req: Request, res: Response) => {
    const q = String(req.query.q || req.query.query || '').trim();
    if (!q) return sendSuccess(res, []);

    const products = await Product.find({ status: ProductStatus.APPROVED, title: searchExpression(q) })
      .select('title')
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();
    return sendSuccess(res, products.map((product) => product.title));
  };
}
