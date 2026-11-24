import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { MarketVendor } from '@models/catalog/market-vendor.model';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

/**
 * Marks every vendor's payout details as verified. Dry run by default; pass --execute to write. Safe to run again.
 */
async function main() {
  await connectDatabase();
  const filter = { deletedAt: { $exists: false }, paymentProfile: { $exists: true }, 'paymentProfile.verificationStatus': { $ne: 'verified' } };
  const pending = await MarketVendor.countDocuments(filter);
  if (execute && pending) await MarketVendor.updateMany(filter, { $set: { 'paymentProfile.verificationStatus': 'verified' } });
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'}`, { vendorsToVerify: pending, remaining: execute ? await MarketVendor.countDocuments(filter) : pending });
  await disconnectDatabase();
}

main().catch((error) => { console.error(error); process.exit(1); });
