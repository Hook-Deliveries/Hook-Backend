import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');

/**
 * Clears every order and everything that hangs off one (payments, fulfilment
 * tasks, hub packages, shipments, exceptions, order notifications) and puts
 * customer Hook credit back to what it was before any order touched it:
 * welcome bonuses, referral rewards and admin adjustments stay; order earn,
 * spend and refund entries go. Customers, products, categories, markets,
 * carts and negotiations are left alone.
 *
 * Dry run by default. With --execute a JSON backup of every removed document is
 * written to .backups/ first, so nothing is lost for good.
 */
const ORDER_COLLECTIONS = [
  'orders', 'orderitems', 'orderfulfilmentgroups', 'payments', 'paymentattempts', 'paymentlinks', 'paymentwebhookevents',
  'checkoutpreviews', 'checkoutevents', 'commerceoutboxevents', 'commerceimports', 'idempotencyrecords',
  'consolidations', 'fulfilmenttasks', 'fulfilmentexceptions', 'fulfilmentrefunds', 'hubpackages', 'runnerpackages', 'shipments',
  'pickupmanifests', 'partnercustodies', 'vendorfulfilments', 'vendorcollections', 'vendorpaymentrecords', 'itemresolutions',
  'refundrequests', 'returnrequests', 'settlements', 'escrowledgers', 'couponredemptions',
  'logisticswebhookevents', 'integrationexceptions', 'negotiatedquotes',
];
const ORDER_NOTIFICATION_TYPES = ['hub_qc_passed', 'hub_qc_failed', 'order_created', 'order_assigned', 'order_updated', 'payment_pending', 'payment_confirmed', 'order_shipped', 'order_delivered', 'order_cancelled', 'refund_processed', 'refund_requested', 'return_update'];
const ORDER_LEDGER_TYPES = ['order_earn', 'order_spend', 'order_refund'];

async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  const existing = new Set((await db.listCollections().toArray()).map((item) => item.name));
  const plan: Array<{ name: string; filter: Record<string, unknown>; count: number }> = [];
  for (const name of ORDER_COLLECTIONS.filter((item) => existing.has(item))) plan.push({ name, filter: {}, count: await db.collection(name).countDocuments({}) });
  plan.push({ name: 'notifications', filter: { type: { $in: ORDER_NOTIFICATION_TYPES } }, count: await db.collection('notifications').countDocuments({ type: { $in: ORDER_NOTIFICATION_TYPES } }) });
  plan.push({ name: 'creditledgers', filter: { type: { $in: ORDER_LEDGER_TYPES } }, count: await db.collection('creditledgers').countDocuments({ type: { $in: ORDER_LEDGER_TYPES } }) });

  console.log(`${execute ? 'Clearing' : 'Dry run:'}`);
  for (const item of plan) if (item.count) console.log(`  ${String(item.count).padStart(5)}  ${item.name}`);
  const reserved = await db.collection('products').countDocuments({ reservedQuantity: { $gt: 0 } });
  console.log(`  ${String(reserved).padStart(5)}  products with reserved stock to release`);
  if (!execute) { console.log('\nNothing changed. Re-run with --execute (a backup is written first).'); return; }

  const dir = path.join(process.cwd(), '.backups', `orders-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of plan) {
    if (!item.count) continue;
    const docs = await db.collection(item.name).find(item.filter).toArray();
    fs.writeFileSync(path.join(dir, `${item.name}.json`), JSON.stringify(docs));
  }
  console.log(`Backup written to ${dir}`);

  for (const item of plan) {
    if (!item.count) continue;
    const result = await db.collection(item.name).deleteMany(item.filter);
    console.log(`  removed ${result.deletedCount} from ${item.name}`);
  }
  await db.collection('products').updateMany({ reservedQuantity: { $gt: 0 } }, { $set: { reservedQuantity: 0 } });
  await db.collection('coupons').updateMany({}, { $set: { usedCount: 0 } });
  const balances = await db.collection('creditledgers').aggregate([{ $group: { _id: '$userId', balance: { $sum: '$amountMinor' } } }]).toArray();
  console.log(`Hook credit restored for ${balances.length} customer(s): ${balances.map((item) => `${item.balance / 100}`).join(', ')} NGN`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDatabase());
