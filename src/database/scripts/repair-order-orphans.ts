import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';

dotenv.config({ quiet: true });
const execute = process.argv.includes('--execute');

/**
 * Repairs references left behind when orders were removed:
 *  - cart lines still holding a quoteId whose quote no longer exists (they would show a discounted price and then fail at checkout);
 *  - negotiations marked agreed/accepted whose quote is gone (stranded);
 *  - referrals pointing at a qualifying order that no longer exists.
 * Dry run by default; --execute applies.
 */
async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  const quoteIds = new Set((await db.collection('negotiatedquotes').find({}, { projection: { _id: 1 } }).toArray()).map((doc) => String(doc._id)));
  const lines = await db.collection('cartitems').find({ quoteId: { $exists: true, $nin: [null, ''] } }).project({ _id: 1, quoteId: 1 }).toArray();
  const orphanLines = lines.filter((line) => !quoteIds.has(String(line.quoteId)));
  console.log(`${orphanLines.length} cart line(s) with a missing quote`);

  const stuck = await db.collection('negotiations').find({ status: { $in: ['AGREED', 'ACCEPTED', 'agreed', 'accepted'] }, quoteId: { $exists: true, $nin: [null, ''] } }).project({ _id: 1, quoteId: 1, status: 1 }).toArray();
  const stranded = stuck.filter((item) => !quoteIds.has(String(item.quoteId)));
  console.log(`${stranded.length} negotiation(s) pointing at a missing quote`);

  const orderIds = new Set((await db.collection('orders').find({}, { projection: { _id: 1, publicId: 1 } }).toArray()).flatMap((doc) => [String(doc._id), String(doc.publicId)]));
  const referrals = await db.collection('referrals').find({ qualifyingOrderId: { $exists: true, $nin: [null, ''] } }).project({ _id: 1, qualifyingOrderId: 1 }).toArray();
  const badReferrals = referrals.filter((item) => !orderIds.has(String(item.qualifyingOrderId)));
  console.log(`${badReferrals.length} referral(s) pointing at a deleted order`);

  if (!execute) { console.log('\nDry run. Re-run with --execute.'); return; }
  if (orphanLines.length) await db.collection('cartitems').updateMany({ _id: { $in: orphanLines.map((line) => line._id) } }, { $unset: { quoteId: '', quoteVersion: '' } });
  if (stranded.length) await db.collection('negotiations').updateMany({ _id: { $in: stranded.map((item) => item._id) } }, { $unset: { quoteId: '' }, $set: { status: 'EXPIRED' } });
  if (badReferrals.length) await db.collection('referrals').updateMany({ _id: { $in: badReferrals.map((item) => item._id) } }, { $unset: { qualifyingOrderId: '' } });
  console.log('Repaired.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
