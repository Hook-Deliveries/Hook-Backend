import dotenv from 'dotenv';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { NegotiationStatus } from '@lib/constants';
import { Negotiation } from '@models/negotiations/negotiation.model';

dotenv.config({ quiet: true });

const execute = process.argv.includes('--execute');

/**
 * A customer can only have one live negotiation per product option and quantity (unique index
 * `unique_active_negotiation`). Sessions created before that rule can hold duplicates, which would stop the
 * index from building. This keeps the most recently updated live session of each group, closes the rest, and
 * then builds the index.
 *
 * Dry run by default; pass --execute to apply.
 */
async function main() {
  await connectDatabase();

  const groups = await Negotiation.aggregate<{ _id: unknown; ids: unknown[]; keep: unknown }>([
    { $match: { status: NegotiationStatus.ACTIVE, customerId: { $exists: true }, variantId: { $exists: true } } },
    { $sort: { updatedAt: -1 } },
    {
      $group: {
        _id: { customerId: '$customerId', productId: '$productId', variantId: '$variantId', quantity: '$quantity', initiatingPartnerId: '$initiatingPartnerId' },
        ids: { $push: '$_id' },
        keep: { $first: '$_id' },
      },
    },
    { $match: { 'ids.1': { $exists: true } } },
  ]);

  const duplicates = groups.flatMap((group) => group.ids.filter((id) => String(id) !== String(group.keep)));
  console.log(`Found ${groups.length} group(s) with duplicate live sessions (${duplicates.length} session(s) to close).`);
  if (!duplicates.length) console.log('Nothing to close.');
  else if (!execute) console.log('Dry run. Re-run with --execute to close them and build the index.');
  else {
    const result = await Negotiation.updateMany(
      { _id: { $in: duplicates } },
      { $set: { status: NegotiationStatus.CLOSED, endReason: 'DUPLICATE_SESSION' } },
    );
    console.log(`Closed ${result.modifiedCount} duplicate session(s).`);
  }
  if (execute) {
    await Negotiation.createIndexes();
    console.log('Index unique_active_negotiation is in place.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
