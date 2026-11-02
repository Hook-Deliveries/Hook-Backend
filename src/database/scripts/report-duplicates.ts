import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';

/**
 * Read-only. Finds rows that would violate a unique key we rely on (or intend
 * to add) so they can be resolved by hand BEFORE the index is built; a unique
 * index cannot be created over duplicates. Run against a copy or a secondary
 * first on large collections.
 */
const CHECKS: Array<{ label: string; collection: string; match?: Record<string, unknown>; key: Record<string, string> }> = [
  { label: 'Payment.transactionRef', collection: 'payments', key: { ref: '$transactionRef' } },
  { label: 'Payment per order without a fulfilment group', collection: 'payments', match: { fulfilmentGroupId: { $exists: false }, orderId: { $exists: true } }, key: { orderId: '$orderId' } },
  { label: 'Payment.providerEventId', collection: 'payments', match: { providerEventId: { $exists: true, $ne: null } }, key: { id: '$providerEventId' } },
  { label: 'CreditLedger.idempotencyKey', collection: 'creditledgers', key: { key: '$idempotencyKey' } },
  { label: 'CouponRedemption.idempotencyKey', collection: 'couponredemptions', key: { key: '$idempotencyKey' } },
  { label: 'Order.idempotencyKey', collection: 'orders', match: { idempotencyKey: { $exists: true, $ne: null } }, key: { key: '$idempotencyKey' } },
  { label: 'Notification.eventKey', collection: 'notifications', match: { eventKey: { $exists: true, $ne: null } }, key: { key: '$eventKey' } },
  { label: 'FulfilmentTask (orderId, marketId)', collection: 'fulfilmenttasks', key: { orderId: '$orderId', marketId: '$marketId' } },
  { label: 'Open IntegrationException per (provider, reference, type)', collection: 'integrationexceptions', match: { status: 'open' }, key: { provider: '$provider', reference: '$reference', type: '$type' } },
  { label: 'MarketVendor (marketId, normalizedPhone), not deleted', collection: 'marketvendors', match: { deletedAt: null }, key: { m: '$marketId', p: '$normalizedPhone' } },
  { label: 'MarketVendor (marketId, email), not deleted', collection: 'marketvendors', match: { deletedAt: null, email: { $type: 'string' } }, key: { m: '$marketId', e: '$email' } },
  { label: 'Referral.refereeUserId', collection: 'referrals', key: { user: '$refereeUserId' } },
];

async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  let problems = 0;
  for (const check of CHECKS) {
    const rows = await db.collection(check.collection).aggregate([
      ...(check.match ? [{ $match: check.match }] : []),
      { $group: { _id: check.key, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 25 },
    ]).toArray();
    if (rows.length) {
      problems += rows.length;
      console.log(`DUPLICATES  ${check.label}: ${rows.length}+ group(s)`);
      for (const row of rows.slice(0, 5)) console.log(`   ${JSON.stringify(row._id)} x${row.count}  ids=${row.ids.slice(0, 4).join(',')}`);
    } else {
      console.log(`ok          ${check.label}`);
    }
  }
  await disconnectDatabase();
  process.exit(problems ? 1 : 0);
}

void main();
