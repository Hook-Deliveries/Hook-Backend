import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { Market } from '@models/platform/network.model';
import { Product } from '@models/products/product.model';
import { CATEGORY_PRODUCT_CATALOG } from '../seeds/category-product-catalog';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** Spreads the seeded catalogue evenly across every active Market in a stable order, so re-running gives the same assignment. */
async function main() {
  await connectDatabase();
  const markets = await Market.find({ status: 'active', deletedAt: { $exists: false } }).sort({ createdAt: 1 }).select('name stateId').lean();
  if (!markets.length) throw new Error('No active markets found');
  const vendors = await MarketVendor.find({ marketId: { $in: markets.map((m) => String(m._id)) }, status: { $in: ['active', 'pending'] }, deletedAt: { $exists: false } }).select('marketId').lean();
  const vendorByMarket = new Map<string, string>();
  for (const vendor of vendors) if (!vendorByMarket.has(String(vendor.marketId))) vendorByMarket.set(String(vendor.marketId), String(vendor._id));

  const slugs = CATEGORY_PRODUCT_CATALOG.map((item) => slugify(item.title));
  const products = await Product.find({ slug: { $in: slugs } }).select('slug title').lean();
  const bySlug = new Map(products.map((product) => [product.slug, product]));
  const counts = new Map<string, number>();
  let index = 0;
  for (const slug of slugs) {
    const product = bySlug.get(slug);
    if (!product) continue;
    const market = markets[index % markets.length];
    index += 1;
    counts.set(market.name, (counts.get(market.name) || 0) + 1);
    if (!execute) continue;
    const vendorId = vendorByMarket.get(String(market._id));
    await Product.updateOne(
      { _id: product._id },
      { $set: { marketId: String(market._id), sourceStateId: market.stateId, ...(vendorId ? { sourceMarketVendorId: vendorId } : {}) }, ...(vendorId ? {} : { $unset: { sourceMarketVendorId: '' } }) },
    );
  }
  console.log(`${execute ? 'Moved' : 'Would move'} ${index} product(s) across ${markets.length} market(s)`);
  for (const [name, count] of counts) console.log(`  ${name}: ${count}`);
  if (!execute) console.log('Dry run. Re-run with --execute to apply.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
