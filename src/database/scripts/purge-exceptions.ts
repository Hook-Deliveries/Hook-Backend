import { connectDatabase, disconnectDatabase } from '@config/data-source';
import mongoose from 'mongoose';

const execute = process.argv.includes('--execute');

/**
 * Removes the retired Operational Exceptions feature from the database.
 *
 * Resolving an exception only ever marked a row — it never unblocked the task,
 * package or order it referenced — so the feature made blocked work look
 * actionable when it was not. Blocking now lives on the task itself, admin
 * unblocks it directly, and escalation goes to the support email.
 *
 * Three kinds of residue:
 *   1. the fulfilmentexceptions collection
 *   2. the orphaned `fulfilment.resolve` Permission document
 *   3. that key left on seeded Role documents ($setOnInsert never removes it)
 */
async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  const exceptions = db.collection('fulfilmentexceptions');
  const permissions = db.collection('permissions');
  const roles = db.collection('roles');

  const excCount = await exceptions.countDocuments({});
  const permCount = await permissions.countDocuments({ key: 'fulfilment.resolve' });
  const roleCount = await roles.countDocuments({ permissionKeys: 'fulfilment.resolve' });

  console.log(`${execute ? 'Purging' : 'Would purge'}:`);
  console.log(`  ${excCount} exception row(s)`);
  console.log(`  ${permCount} orphaned permission record(s)`);
  console.log(`  fulfilment.resolve on ${roleCount} role(s)`);

  if (!execute) {
    console.log('\nNo data changed. Run with --execute to apply.');
    return;
  }

  const dropped = await exceptions.drop().then(() => true).catch(() => false);
  const perms = await permissions.deleteMany({ key: 'fulfilment.resolve' });
  const rolesUpdated = await roles.updateMany(
    { permissionKeys: 'fulfilment.resolve' },
    { $pull: { permissionKeys: 'fulfilment.resolve' } } as never,
  );

  console.log(`Collection ${dropped ? 'dropped' : 'already absent'}; removed ${perms.deletedCount} permission(s) and cleaned ${rolesUpdated.modifiedCount} role(s).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
