import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { MarketAssociateMarketAssignment } from '@models/platform/operations-accounts.model';

const execute = process.argv.includes('--execute');

async function main() {
  await connectDatabase();
  const count = await MarketAssociateMarketAssignment.countDocuments({ status: 'ended' });
  if (!count) {
    console.log('No ended assignments to clear.');
    return;
  }
  if (execute) {
    const result = await MarketAssociateMarketAssignment.deleteMany({ status: 'ended' });
    console.log(`Deleted ${result.deletedCount} ended assignment(s).`);
  } else {
    console.log(`${count} ended assignment(s) found. Run with --execute to delete them.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
