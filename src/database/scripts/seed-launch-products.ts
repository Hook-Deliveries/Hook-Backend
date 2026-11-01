import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';
import { Category } from '@models/categories/category.model';
import { ProductVariant } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';
import { Market } from '@models/platform/network.model';
import { User } from '@models/users/user.model';
import { hookIdFromPublicId, nextPublicId } from '@modules/platform/public-id.service';
import { CATEGORY_PRODUCT_CATALOG, type CatalogSeed } from '../seeds/category-product-catalog';

/**
 * Seeds a small, honest launch catalogue: 2 published products in every category, spread across
 * every market so each market has stock. Curated catalogue items go first; real products from the
 * previous database (OLD_MONGODB_URI, read only) fill any category the catalogue does not cover.
 * Safe to re-run: products are matched by slug and never duplicated.
 *   npm run seed:launch-products               (dry run)
 *   npm run seed:launch-products -- --execute
 */
const execute = process.argv.includes('--execute');
const PER_CATEGORY = 2;
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const uniq = (values: Array<string | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

type Pick =
  | { kind: 'catalog'; item: CatalogSeed }
  | { kind: 'old'; doc: any; variants: any[] };

async function loadOldProducts() {
  const uri = process.env.OLD_MONGODB_URI;
  if (!uri) return { products: [] as any[], variants: new Map<string, any[]>() };
  const client = new mongoose.mongo.MongoClient(uri);
  await client.connect();
  try {
    const db = client.db('hook');
    const products = await db.collection('products').find({ status: 'published', deletedAt: { $exists: false } }).toArray();
    const variants = await db.collection('productvariants').find({ productId: { $in: products.map((p) => String(p._id)) }, active: true }).toArray();
    const byProduct = new Map<string, any[]>();
    for (const variant of variants) byProduct.set(variant.productId, [...(byProduct.get(variant.productId) || []), variant]);
    return { products, variants: byProduct };
  } finally {
    await client.close();
  }
}

async function main() {
  await connectDatabase();
  const admin = await User.findOne({ email: 'admin@gmail.com', isActive: true }).lean();
  if (!admin) throw new Error('Run npm run seed:super-admin first: admin@gmail.com was not found');
  const markets = await Market.find({ status: { $in: ['active', 'enabled'] } }).sort({ displayPriority: 1 }).lean();
  if (!markets.length) throw new Error('No active markets found');
  const categories = await Category.find({ isActive: true, deletedAt: { $exists: false } }).lean();
  const parentIds = new Set(categories.map((c: any) => String(c.parentId || '')).filter(Boolean));
  const leaves = categories.filter((c: any) => !parentIds.has(String(c._id)));
  const old = await loadOldProducts();

  const marketById = new Map(markets.map((m: any) => [String(m._id), m]));
  const load = new Map(markets.map((m: any) => [String(m._id), 0]));
  const plan: Array<{ leaf: any; pick: Pick; marketId: string }> = [];

  for (const leaf of leaves) {
    const picks: Pick[] = CATEGORY_PRODUCT_CATALOG.filter((item) => item.leaf === (leaf as any).slug && item.images.length > 0).map((item) => ({ kind: 'catalog' as const, item }));
    if (picks.length < PER_CATEGORY) {
      for (const doc of old.products.filter((p) => String(p.categoryId) === String((leaf as any)._id))) {
        if (picks.length >= PER_CATEGORY) break;
        picks.push({ kind: 'old', doc, variants: old.variants.get(String(doc._id)) || [] });
      }
    }
    const usedMarkets = new Set<string>();
    for (const pick of picks.slice(0, PER_CATEGORY)) {
      let marketId = pick.kind === 'old' && marketById.has(String(pick.doc.marketId)) ? String(pick.doc.marketId) : '';
      if (!marketId) {
        const ranked = [...load.entries()].sort((a, b) => a[1] - b[1]);
        marketId = (ranked.find(([id]) => !usedMarkets.has(id)) || ranked[0])[0];
      }
      usedMarkets.add(marketId);
      load.set(marketId, (load.get(marketId) || 0) + 1);
      plan.push({ leaf, pick, marketId });
    }
  }

  const perLeaf = new Map<string, number>();
  for (const row of plan) perLeaf.set(String(row.leaf._id), (perLeaf.get(String(row.leaf._id)) || 0) + 1);
  console.log(`${execute ? 'Creating' : 'Dry run for'} ${plan.length} products across ${leaves.length} categories and ${markets.length} markets\n`);
  for (const market of markets) console.log(`  ${(market as any).name.padEnd(18)} ${load.get(String(market._id))} products`);
  const short = leaves.filter((l: any) => (perLeaf.get(String(l._id)) || 0) < PER_CATEGORY);
  if (short.length) console.log(`\n  Categories with fewer than ${PER_CATEGORY}: ${short.map((l: any) => `${l.slug} (${perLeaf.get(String(l._id)) || 0})`).join(', ')}`);
  if (!execute) {
    console.log('\nNo data changed. Run with --execute to create these products.');
    return;
  }

  const now = new Date();
  let created = 0;
  let skipped = 0;
  for (const { leaf, pick, marketId } of plan) {
    const market: any = marketById.get(marketId);
    const title: string = pick.kind === 'catalog' ? pick.item.title : pick.doc.title;
    const slug = slugify(title);
    if (await Product.exists({ slug })) { skipped += 1; continue; }
    const productPublicId = await nextPublicId('product');
    const base = pick.kind === 'catalog'
      ? {
          title,
          description: pick.item.description,
          costPrice: pick.item.costPrice,
          sellingPrice: pick.item.sellingPrice,
          minAcceptablePrice: pick.item.floorPrice,
          quantity: pick.item.quantity,
          images: pick.item.images.map((image) => image.url),
          variants: pick.item.variants.map((v) => ({ size: v.size, colour: v.colour, attributes: v.attributes || {} })),
        }
      : {
          title,
          description: pick.doc.description,
          costPrice: pick.doc.costPrice,
          sellingPrice: pick.doc.sellingPrice,
          minAcceptablePrice: pick.doc.minAcceptablePrice,
          quantity: Math.max(Number(pick.doc.quantity) || 0, 5),
          images: pick.doc.images || [],
          variants: pick.variants.map((v) => ({ size: v.size, colour: v.colour, attributes: v.attributes || {} })),
        };
    const sellingMinor = Math.round(base.sellingPrice * 100);
    const floorMinor = Math.round(base.minAcceptablePrice * 100);
    const product = await Product.create({
      publicId: productPublicId,
      hookId: hookIdFromPublicId(productPublicId),
      title: base.title,
      slug,
      description: base.description,
      costPrice: base.costPrice,
      sellingPrice: base.sellingPrice,
      minAcceptablePrice: base.minAcceptablePrice,
      basePriceMinor: Math.round(base.costPrice * 100),
      sellingPriceMinor: sellingMinor,
      markupMinor: sellingMinor - Math.round(base.costPrice * 100),
      discountMinor: 0,
      currency: 'NGN',
      sourceStateId: String(market.stateId),
      marketId,
      categoryId: String(leaf._id),
      quantity: base.quantity,
      reservedQuantity: 0,
      colors: uniq(base.variants.map((v: any) => v.colour)),
      sizes: uniq(base.variants.map((v: any) => v.size)),
      images: base.images,
      mediaAssetIds: [],
      negotiationRules: { enabled: true, minimumNegotiablePriceMinor: floorMinor, maximumDiscountMinor: sellingMinor - floorMinor, maximumCustomerOffers: 3, acceptedQuoteExpiryMinutes: 30 },
      availabilityStatus: ProductAvailabilityStatus.AVAILABLE,
      customerAvailabilityNote: 'Available from a verified Hook Market supplier.',
      lastMarketVerifiedAt: now,
      lastPriceVerifiedAt: now,
      lastAvailabilityConfirmedAt: now,
      availabilityValidUntil: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
      publishedAt: now,
      publishedBy: String(admin._id),
      commercialApproval: { approved: true, approvedBy: String(admin._id), approvedAt: now },
      catalogMigrationVersion: 3,
      catalogVersion: 1,
      status: ProductStatus.PUBLISHED,
      viewCount: 0,
      orderCount: 0,
      averageRating: 0,
      source: 'field_agent',
    });
    const variantIds = await Promise.all(base.variants.map(() => nextPublicId('variant')));
    if (base.variants.length) {
      await ProductVariant.insertMany(base.variants.map((variant: any, index: number) => ({
        publicId: variantIds[index],
        productId: String(product._id),
        sku: `${product.hookId}-${String(index + 1).padStart(2, '0')}`,
        size: variant.size,
        colour: variant.colour,
        attributes: variant.attributes,
        active: true,
        mediaAssetIds: [],
      })));
    }
    created += 1;
    console.log(`  created ${(leaf as any).slug}: ${title} -> ${market.name}`);
  }
  console.log(`\n${created} products created, ${skipped} already existed.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => void disconnectDatabase());
