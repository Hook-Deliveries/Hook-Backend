import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { OrderFulfilmentGroup } from '@models/orders/order-fulfilment-group.model';
import { Consolidation, Shipment } from '@models/fulfilment/fulfilment.model';

const execute = process.argv.includes('--execute');

/**
 * Splitting an order into several deliveries was physically impossible: a
 * unique index on { orderId, sourceStateId } existed on three collections, so
 * a second group, consolidation or shipment in the same state was rejected by
 * the database itself.
 *
 * This migration retires those three indexes:
 *  - orderfulfilmentgroups: dropped outright. The group's own publicId is
 *    already unique, so the compound one added nothing but the restriction.
 *    A non-unique replacement keeps the per-state lookups fast.
 *  - consolidations / shipments: pivoted to { orderId, fulfilmentGroupId },
 *    unique and sparse. Both already write fulfilmentGroupId at creation, and
 *    sparse keeps legacy rows that predate the field from colliding on null.
 *
 * Mongoose only creates indexes; it never drops the ones it no longer
 * declares, so this has to be done explicitly against the live collections.
 */

const OLD_KEY = { orderId: 1, sourceStateId: 1 };

type Target = {
  label: string;
  model: { collection: { indexes(): Promise<any[]>; dropIndex(name: string): Promise<unknown>; createIndex(spec: any, options?: any): Promise<unknown> } };
  /** undefined means the unique constraint is retired rather than replaced. */
  replacement?: { spec: Record<string, number>; options: Record<string, unknown> };
};

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k, i) => bk[i] === k && String(a[k]) === String(b[k]));
}

async function migrate(target: Target) {
  const indexes = await target.model.collection.indexes();
  const stale = indexes.find((index) => sameKey(index.key, OLD_KEY) && index.unique);

  if (!stale) {
    console.log(`  ${target.label}: no unique { orderId, sourceStateId } index present — already migrated.`);
  } else if (execute) {
    await target.model.collection.dropIndex(stale.name);
    console.log(`  ${target.label}: dropped unique index "${stale.name}".`);
  } else {
    console.log(`  ${target.label}: would drop unique index "${stale.name}".`);
  }

  // The non-unique lookup index and, where applicable, the pivoted unique one.
  const wanted: Array<{ spec: Record<string, number>; options: Record<string, unknown> }> = [
    { spec: { ...OLD_KEY }, options: {} },
    ...(target.replacement ? [target.replacement] : []),
  ];

  for (const index of wanted) {
    const exists = indexes.some(
      (candidate) => sameKey(candidate.key, index.spec) && Boolean(candidate.unique) === Boolean(index.options.unique),
    );
    if (exists) {
      console.log(`  ${target.label}: ${JSON.stringify(index.spec)} already present.`);
      continue;
    }
    if (execute) {
      await target.model.collection.createIndex(index.spec, index.options);
      console.log(`  ${target.label}: created ${JSON.stringify(index.spec)} ${JSON.stringify(index.options)}.`);
    } else {
      console.log(`  ${target.label}: would create ${JSON.stringify(index.spec)} ${JSON.stringify(index.options)}.`);
    }
  }
}

/**
 * Creating a unique index fails outright if the existing data already violates
 * it, so report any conflict before attempting the change rather than letting
 * the migration die halfway through.
 */
async function reportConflicts(label: string, model: any) {
  const clashes = await model.aggregate([
    { $match: { fulfilmentGroupId: { $ne: null }, deletedAt: { $exists: false } } },
    { $group: { _id: { orderId: '$orderId', fulfilmentGroupId: '$fulfilmentGroupId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (clashes.length) {
    console.log(`  ${label}: ${clashes.length} duplicate (orderId, fulfilmentGroupId) pair(s) — the unique index cannot be created until these are resolved:`);
    for (const clash of clashes.slice(0, 10)) console.log(`    ${JSON.stringify(clash._id)} x${clash.count}`);
  }
  return clashes.length;
}

async function main() {
  await connectDatabase();
  console.log(execute ? 'Migrating fulfilment indexes.' : 'Dry run — no indexes will be changed.');

  const conflicts =
    (await reportConflicts('consolidations', Consolidation)) + (await reportConflicts('shipments', Shipment));
  if (conflicts && execute) {
    console.error('Aborting: resolve the duplicates above before running with --execute.');
    process.exitCode = 1;
    return;
  }

  const targets: Target[] = [
    { label: 'orderfulfilmentgroups', model: OrderFulfilmentGroup as any },
    {
      label: 'consolidations',
      model: Consolidation as any,
      replacement: { spec: { orderId: 1, fulfilmentGroupId: 1 }, options: { unique: true, sparse: true } },
    },
    {
      label: 'shipments',
      model: Shipment as any,
      replacement: { spec: { orderId: 1, fulfilmentGroupId: 1 }, options: { unique: true, sparse: true } },
    },
  ];

  for (const target of targets) await migrate(target);

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
