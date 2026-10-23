import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Permission, Role } from '@models/platform/access.model';
import { ensurePlatformAccessCatalog } from '@modules/platform/platform-bootstrap.service';

const execute = process.argv.includes('--execute');

/**
 * ensurePlatformAccessCatalog() seeds role permissions with $setOnInsert, so a
 * role that already exists never receives newly-added keys on redeploy. This
 * pushes the new ones onto the roles that should have them.
 */
const GRANTS: Record<string, string[]> = {
  FINANCE_OFFICER: ['coupons.view', 'coupons.manage', 'credits.view', 'credits.adjust'],
  // orders.cancel refunds Hook credit and releases coupons, so it goes only to
  // the roles that already own order outcomes — not to read-only or
  // hub/logistics roles that merely hold orders.edit.
  OPERATIONS_LEAD: ['coupons.view', 'logistics.view', 'logistics.book', 'logistics.manage', 'logistics.track', 'orders.cancel'],
  LOGISTICS_OFFICER: ['logistics.view', 'logistics.book', 'logistics.manage', 'logistics.track'],
  CUSTOMER_SUPPORT_OFFICER: ['coupons.view', 'credits.view', 'orders.cancel'],
};

async function main() {
  await connectDatabase();

  // Make sure the Permission documents themselves exist first.
  if (execute) await ensurePlatformAccessCatalog();

  console.log(`${execute ? 'Backfilling' : 'Dry run for'} role permissions:\n`);

  for (const [key, permissions] of Object.entries(GRANTS)) {
    const role = await Role.findOne({ key }).select('key permissionKeys').lean();
    if (!role) {
      console.log(`  skip — ${key} does not exist in this database`);
      continue;
    }
    const current = new Set(role.permissionKeys || []);
    const missing = permissions.filter((permission) => !current.has(permission));
    if (!missing.length) {
      console.log(`  none — ${key} already has all of them`);
      continue;
    }
    if (execute) {
      await Role.updateOne({ key }, { $addToSet: { permissionKeys: { $each: missing } } });
    }
    console.log(`  ${execute ? 'Granted' : 'Would grant'} ${key}: ${missing.join(', ')}`);
  }

  const seeded = await Permission.countDocuments({ key: { $in: ['coupons.view', 'coupons.manage', 'credits.view', 'credits.adjust'] } });
  console.log(`\n${seeded} of 4 new permission records exist.`);
  if (!execute) console.log('No data changed. Run with --execute to apply.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
