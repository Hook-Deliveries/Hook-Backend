import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { OperationState } from '@models/platform/geography.model';

/**
 * Sets each State's delivery price by region (amounts in kobo):
 *   North (north-west, north-east, north-central + FCT)  ₦4,000
 *   South (south-south)                                  ₦3,000
 *   East  (south-east)                                   ₦3,500
 *   West  (south-west)                                   ₦3,500
 *
 * Safe to re-run: it only writes States whose price differs, and States that
 * already carry a different price are left alone unless --overwrite is passed.
 *   npx ts-node -r tsconfig-paths/register src/database/scripts/seed-delivery-state-fees.ts            (dry run)
 *   npx ts-node -r tsconfig-paths/register src/database/scripts/seed-delivery-state-fees.ts --execute
 */
const execute = process.argv.includes('--execute');
const overwrite = process.argv.includes('--overwrite');

const REGIONS: Record<string, { label: string; feeMinor: number; states: string[] }> = {
  north: {
    label: 'North',
    feeMinor: 400_000,
    states: ['Adamawa', 'Bauchi', 'Benue', 'Borno', 'FCT', 'Federal Capital Territory', 'Abuja', 'Gombe', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Nasarawa', 'Niger', 'Plateau', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'],
  },
  south: {
    label: 'South',
    feeMinor: 300_000,
    states: ['Akwa Ibom', 'Bayelsa', 'Cross River', 'Delta', 'Edo', 'Rivers'],
  },
  east: {
    label: 'East',
    feeMinor: 350_000,
    states: ['Abia', 'Anambra', 'Ebonyi', 'Enugu', 'Imo'],
  },
  west: {
    label: 'West',
    feeMinor: 350_000,
    states: ['Ekiti', 'Lagos', 'Ogun', 'Ondo', 'Osun', 'Oyo'],
  },
};

const normalise = (value: string) => value.toLowerCase().replace(/\bstate\b/g, '').replace(/[^a-z]/g, '');
const byName = new Map<string, { label: string; feeMinor: number }>();
for (const region of Object.values(REGIONS)) {
  for (const name of region.states) byName.set(normalise(name), { label: region.label, feeMinor: region.feeMinor });
}

async function main() {
  await connectDatabase();
  console.log(`${execute ? 'Applying' : 'Dry run of'} delivery prices by region${overwrite ? ' (overwriting existing prices)' : ''}:\n`);
  const states = await OperationState.find({ countryCode: 'NG' }).sort({ name: 1 });
  const unmatched: string[] = [];
  let changed = 0;

  for (const state of states) {
    const region = byName.get(normalise(state.name));
    if (!region) { unmatched.push(state.name); continue; }
    const current = state.deliveryFeeMinor;
    if (current === region.feeMinor) { console.log(`  ok      ${state.name.padEnd(22)} ${region.label.padEnd(6)} ₦${region.feeMinor / 100}`); continue; }
    if (current !== undefined && current !== null && !overwrite) {
      console.log(`  keep    ${state.name.padEnd(22)} already ₦${current / 100} (use --overwrite to replace)`);
      continue;
    }
    console.log(`  ${execute ? 'set    ' : 'would  '} ${state.name.padEnd(22)} ${region.label.padEnd(6)} ₦${region.feeMinor / 100}`);
    if (execute) await OperationState.updateOne({ _id: state._id }, { $set: { deliveryFeeMinor: region.feeMinor } });
    changed += 1;
  }

  if (unmatched.length) console.log(`\nNo region for: ${unmatched.join(', ')} (set these by hand in Delivery States)`);
  console.log(`\n${execute ? 'Updated' : 'Would update'} ${changed} of ${states.length} States.`);
  if (!execute) console.log('No data changed. Run with --execute to apply.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
