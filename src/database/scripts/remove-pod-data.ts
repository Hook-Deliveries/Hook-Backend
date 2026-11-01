import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '@config/data-source';

/**
 * Removes the leftovers of the retired Pay on Delivery feature from a database: settings and State fields,
 * per-customer flags, the two empty POD collections, and the commerce.pod.* permission keys.
 * It only touches those fields; nothing else is changed. Safe to re-run.
 *   npm run db:remove-pod               (preview: counts only)
 *   npm run db:remove-pod -- --execute
 */
const execute = process.argv.includes('--execute');
const unset = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, '']));

const FIELD_CLEANUPS: Array<{ collection: string; fields: string[] }> = [
  { collection: 'commercesettings', fields: ['podEnabled', 'defaultPodLimitMinor', 'podMinimumOrderMinor', 'podSurchargeType', 'podSurchargeValue', 'podAutoApproveEnabled', 'podRefusalSuspendCount'] },
  { collection: 'operationstates', fields: ['podEnabled', 'podLimitMinor', 'podMinimumOrderMinor', 'payAtHubEnabled', 'payAtHubLimitMinor'] },
  { collection: 'users', fields: ['podEligible', 'podDisabledReason', 'podEligibilityUpdatedAt', 'podRefusals'] },
  { collection: 'orders', fields: ['podReview', 'podFeeDueNowMinor', 'podFeePaid'] },
];
const POD_KEY = /^commerce\.pod(\.|$)/;

async function main() {
  await connectDatabase();
  const db = mongoose.connection.db!;
  console.log(`${execute ? 'Removing' : 'Preview of removing'} Pay on Delivery leftovers from "${db.databaseName}"\n`);

  for (const { collection, fields } of FIELD_CLEANUPS) {
    const filter = { $or: fields.map((field) => ({ [field]: { $exists: true } })) };
    const count = await db.collection(collection).countDocuments(filter);
    console.log(`  ${collection.padEnd(18)} ${count} document(s) carry POD fields`);
    if (execute && count) await db.collection(collection).updateMany(filter, { $unset: unset(fields) });
  }

  const permissionRows = await db.collection('permissions').find({ key: POD_KEY }).project({ key: 1 }).toArray();
  const keys = permissionRows.map((row) => String(row.key));
  console.log(`  permissions        ${keys.length} commerce.pod.* row(s)${keys.length ? `: ${keys.join(', ')}` : ''}`);
  const rolesWithKeys = await db.collection('roles').countDocuments({ permissionKeys: { $in: [POD_KEY] } });
  const usersWithKeys = await db.collection('users').countDocuments({ permissions: { $in: [POD_KEY] } });
  console.log(`  roles              ${rolesWithKeys} role(s) list them`);
  console.log(`  users              ${usersWithKeys} account(s) list them`);
  if (execute) {
    if (keys.length) await db.collection('permissions').deleteMany({ key: POD_KEY });
    if (rolesWithKeys) await db.collection('roles').updateMany({}, { $pull: { permissionKeys: { $regex: POD_KEY } } } as never);
    if (usersWithKeys) await db.collection('users').updateMany({}, { $pull: { permissions: { $regex: POD_KEY } } } as never);
  }

  for (const name of ['podcallrecords', 'podoverrides']) {
    const exists = (await db.listCollections({ name }).toArray()).length > 0;
    if (!exists) { console.log(`  ${name.padEnd(18)} not present`); continue; }
    const size = await db.collection(name).countDocuments();
    console.log(`  ${name.padEnd(18)} ${size} document(s)${size ? ' - kept, not empty' : ' - empty, can be dropped'}`);
    if (execute && size === 0) await db.collection(name).drop();
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => void disconnectDatabase());
