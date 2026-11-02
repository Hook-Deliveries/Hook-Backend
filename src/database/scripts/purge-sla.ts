import { connectDatabase, disconnectDatabase } from '@config/data-source';
import mongoose from 'mongoose';

const execute = process.argv.includes('--execute');

/**
 * Removes every trace of the retired SLA system from the database.
 *
 * The code is already gone: deadlines were hardcoded at task creation
 * (15min/4h/6h/24h), never recomputed, and breaching them only ever inserted a
 * row — no notification, no reassignment, no escalation. What remains in Mongo
 * is dead weight the schema no longer declares:
 *
 *   1. SLA_BREACH exception rows       — noise in the control tower
 *   2. *DueAt fields on tasks          — Mongo keeps fields the schema dropped
 *   3. Indexes on those fields         — Mongoose never drops indexes it stops declaring
 */
const DEADLINE_FIELDS = ['acceptanceDueAt', 'sourcingDueAt', 'hubHandoverDueAt', 'resolutionDueAt'];

async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  const exceptions = db.collection('fulfilmentexceptions');
  const tasks = db.collection('fulfilmenttasks');

  const excCount = await exceptions.countDocuments({ type: 'SLA_BREACH' });
  const fieldFilter = { $or: DEADLINE_FIELDS.map((field) => ({ [field]: { $exists: true } })) };
  const taskCount = await tasks.countDocuments(fieldFilter);
  const staleIndexes = (await tasks.indexes()).filter((index: any) =>
    DEADLINE_FIELDS.some((field) => Object.keys(index.key).includes(field)),
  );

  console.log(`${execute ? 'Purging' : 'Would purge'}:`);
  console.log(`  ${excCount} SLA_BREACH exception row(s)`);
  console.log(`  deadline fields on ${taskCount} task(s)`);
  console.log(`  ${staleIndexes.length} stale index(es): ${staleIndexes.map((i: any) => i.name).join(', ') || 'none'}`);

  if (!execute) {
    console.log('\nNo data changed. Run with --execute to apply.');
    return;
  }

  const removed = await exceptions.deleteMany({ type: 'SLA_BREACH' });
  const unset = await tasks.updateMany(
    fieldFilter,
    { $unset: Object.fromEntries(DEADLINE_FIELDS.map((field) => [field, ''])) },
  );
  for (const index of staleIndexes) {
    // Never drop _id_, and tolerate an index another process already removed.
    if (index.name === '_id_') continue;
    await tasks.dropIndex(index.name).catch(() => undefined);
  }

  console.log(`Deleted ${removed.deletedCount} exception(s), cleaned ${unset.modifiedCount} task(s), dropped ${staleIndexes.length} index(es).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
