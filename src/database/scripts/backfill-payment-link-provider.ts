import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { PaymentLink } from '@models/payments/payment-link.model';

const execute = process.argv.includes('--execute');

/**
 * The PaymentLink schema was missing its `provider` field, so Mongoose
 * silently dropped it on every link ever created — leaving the hosted payment
 * page unable to initialize. This sets it on the affected rows.
 */
async function main() {
  await connectDatabase();
  const filter = { $or: [{ provider: { $exists: false } }, { provider: null }] };
  const count = await PaymentLink.countDocuments(filter);
  if (!count) {
    console.log('No payment links missing a provider. Nothing to do.');
    return;
  }
  console.log(`${execute ? 'Backfilling' : 'Dry run for'} ${count} payment link(s) with no provider.`);
  if (execute) {
    const result = await PaymentLink.updateMany(filter, { $set: { provider: 'paystack' } });
    console.log(`Updated ${result.modifiedCount} link(s) to provider=paystack.`);
  } else {
    console.log('No data changed. Run with --execute to apply.');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
