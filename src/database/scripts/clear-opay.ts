import mongoose, { Model } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CommerceSettings, IntegrationException, PaymentWebhookEvent } from '@models/commerce/commerce.model';
import { PaymentLink } from '@models/payments/payment-link.model';
import { Payment } from '@models/payments/payment.model';

type AnyModel = Model<any>;
type Target = { label: string; model: AnyModel; filter: Record<string, unknown> };

const execute = process.argv.includes('--execute');

/** Opay has been removed in favour of Paystack; this clears the data those removed code paths left behind. */
async function main() {
  await connectDatabase();

  const targets: Target[] = [
    { label: 'Opay payments', model: Payment, filter: { gateway: 'opay' } },
    { label: 'Opay payment links', model: PaymentLink, filter: { provider: 'opay' } },
    { label: 'Opay webhook events', model: PaymentWebhookEvent, filter: { provider: 'opay' } },
    { label: 'Opay integration exceptions', model: IntegrationException, filter: { provider: 'opay' } },
  ];

  console.log(`${execute ? 'Clearing' : 'Dry run for'} Opay data:\n`);

  for (const target of targets) {
    const count = await target.model.countDocuments(target.filter);
    if (!count) {
      console.log(`  none — ${target.label}`);
      continue;
    }
    if (execute) await target.model.deleteMany(target.filter);
    console.log(`  ${execute ? 'Deleted' : 'Would delete'} ${count} ${target.label}`);
  }

  // Saved cards were Opay-tokenisation only, and that model is gone, so the whole collection is orphaned.
  const savedMethods = mongoose.connection.collection('savedpaymentmethods');
  const savedCount = await savedMethods.countDocuments({}).catch(() => 0);
  if (savedCount) {
    if (execute) await savedMethods.drop().catch(() => undefined);
    console.log(`  ${execute ? 'Dropped' : 'Would drop'} savedpaymentmethods (${savedCount} saved card(s))`);
  } else {
    console.log('  none — saved payment methods');
  }

  // Settings keep a providers array; pull the opay row and make sure Paystack
  // is the enabled default so the admin panel has a valid selection.
  const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('paymentProviders').lean();
  const opayEntries = (settings?.paymentProviders || []).filter((entry: any) => entry.provider === 'opay');
  if (opayEntries.length) {
    if (execute) {
      // Mongo refuses $pull and $set on the same path in one update, so the
      // removal and the Paystack-default fixup are two sequential writes.
      await CommerceSettings.updateOne(
        { key: 'commerce' },
        { $pull: { paymentProviders: { provider: 'opay' } as any } },
      );
      await CommerceSettings.updateOne(
        { key: 'commerce' },
        { $set: { 'paymentProviders.$[paystack].enabled': true, 'paymentProviders.$[paystack].isDefault': true } },
        { arrayFilters: [{ 'paystack.provider': 'paystack' }] },
      );
    }
    console.log(`  ${execute ? 'Removed' : 'Would remove'} the Opay entry from commerce payment providers`);
  } else {
    console.log('  none — commerce payment provider settings');
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply this cleanup.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
