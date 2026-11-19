import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { provisionVendorAccount } from '@modules/catalog/vendor-account.service';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

/**
 * Gives every existing vendor a login (default password, forced change at first sign-in).
 * Vendors with no email are listed and skipped, because the email is the sign-in. Dry run by default; pass --execute
 * to write. Safe to run again: a vendor that already has an account is left alone.
 */
async function main() {
  await connectDatabase();
  const vendors = await MarketVendor.find({ deletedAt: { $exists: false }, accountId: { $exists: false } }).lean();
  const summary = { created: 0, skippedNoEmail: 0, conflicts: 0 };
  for (const vendor of vendors as any[]) {
    if (!vendor.email) {
      summary.skippedNoEmail += 1;
      console.log(`no email: ${vendor.publicId} ${vendor.businessName}`);
      continue;
    }
    if (!execute) { summary.created += 1; continue; }
    try {
      await provisionVendorAccount(vendor);
      summary.created += 1;
    } catch (error) {
      summary.conflicts += 1;
      console.log(`conflict: ${vendor.publicId} ${vendor.email}: ${(error as Error).message}`);
    }
  }
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'}`, summary);
  await disconnectDatabase();
}

main().catch((error) => { console.error(error); process.exit(1); });
