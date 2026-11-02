import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CartItem } from '@models/cart/cart-item.model';
import { Product } from '@models/products/product.model';
import { Market } from '@models/platform/network.model';

async function main() {
  await connectDatabase();
  const execute = process.argv.includes('--execute');
  const runId = randomUUID();
  const markets = await Market.find({}).select('_id publicId name').lean();
  const marketMap = new Map<string, (typeof markets)[number]>();
  for (const market of markets) { marketMap.set(market._id.toString(), market); marketMap.set(market.publicId, market); }
  const products = await Product.find({}).select('_id publicId hookId marketId sourceStateId').lean();
  const productMap = new Map<string, (typeof products)[number]>();
  for (const product of products) {
    for (const id of [product._id.toString(), product.publicId, product.hookId].filter(Boolean)) productMap.set(String(id), product);
  }
  const items = await CartItem.find({ deletedAt: null }).select('_id productId marketId stateId').lean();
  let repairs = 0; let updated = 0; let unresolved = 0;
  for (const item of items) {
    const product = productMap.get(item.productId);
    const market = product?.marketId ? marketMap.get(product.marketId) : undefined;
    if (!product || !market?.name) { unresolved++; continue; }
    const marketId = market._id.toString();
    const stateId = item.stateId || product.sourceStateId;
    if (item.marketId === marketId && item.stateId === stateId) continue;
    repairs++;
    if (!execute) continue;
    // Preserve original references before the scoped, compare-and-set repair.
    await mongoose.connection.collection('cart_market_repair_backups').insertOne({ runId, cartItemId: item._id, before: { marketId: item.marketId, stateId: item.stateId }, after: { marketId, stateId }, createdAt: new Date() });
    const result = await CartItem.updateOne({ _id: item._id, marketId: item.marketId ?? null, stateId: item.stateId ?? null }, { $set: { marketId, ...(stateId ? { stateId } : {}) } });
    updated += result.modifiedCount;
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', database: mongoose.connection.name, scanned: items.length, repairs, updated, unresolved, ...(execute ? { backupCollection: 'cart_market_repair_backups', runId } : {}) }));
}
main().catch(() => { console.error('Cart market repair failed; inspect database connectivity and retry.'); process.exitCode = 1; }).finally(disconnectDatabase);
