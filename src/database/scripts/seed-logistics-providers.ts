import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { LogisticsProvider } from '@models/logistics/logistics-provider.model';
import { nextPublicId } from '@modules/platform/public-id.service';

const execute = process.argv.includes('--execute');

/** Starter couriers so the checkout picker has something to show. */
const PROVIDERS = [
  { code: 'GIG', name: 'GIG Logistics', feeMinor: 500_000, sortOrder: 1, description: 'Nationwide delivery, 2-4 working days.' },
  { code: 'GUO', name: 'GUO Transport', feeMinor: 350_000, sortOrder: 2, description: 'Affordable interstate delivery.' },
  { code: 'DHL', name: 'DHL Express', feeMinor: 1_200_000, sortOrder: 3, description: 'Fastest option, next working day in most cities.' },
];

async function main() {
  await connectDatabase();
  console.log(`${execute ? 'Seeding' : 'Dry run for'} logistics providers:\n`);

  for (const provider of PROVIDERS) {
    const existing = await LogisticsProvider.findOne({ code: provider.code }).lean();
    if (existing) {
      console.log(`  skip — ${provider.code} already exists`);
      continue;
    }
    if (execute) {
      await LogisticsProvider.create({
        ...provider,
        publicId: await nextPublicId('logisticsProvider'),
        status: 'active',
      });
    }
    console.log(`  ${execute ? 'Created' : 'Would create'} ${provider.code} — ${provider.name} (₦${(provider.feeMinor / 100).toLocaleString()})`);
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
