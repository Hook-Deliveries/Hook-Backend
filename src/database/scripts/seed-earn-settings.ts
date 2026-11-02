import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { CommerceSettings } from '@models/commerce/commerce.model';

const execute = process.argv.includes('--execute');

/**
 * The commerce settings document predates the Hook credit earn fields, so they
 * are absent on disk and only exist as Mongoose schema defaults. That is fine
 * for reads but leaves the admin Settings screen with nothing to edit, so
 * write the defaults once. $setOnInsert-style semantics: existing values are
 * never overwritten.
 */
async function main() {
  await connectDatabase();
  const settings = await CommerceSettings.findOne({ key: 'commerce' }).lean() as any;
  if (!settings) {
    console.log('No commerce settings document found. Nothing to do.');
    return;
  }
  const defaults: Record<string, number | boolean> = {
    orderEarnPercent: 1,
    orderEarnMaxMinor: 0,
    orderEarnEnabled: true,
  };
  const missing = Object.entries(defaults).filter(([key]) => settings[key] === undefined);
  if (!missing.length) {
    console.log('Hook credit earn settings are already persisted. Nothing to do.');
    return;
  }
  console.log(`${execute ? 'Writing' : 'Would write'} ${missing.length} missing setting(s):`);
  for (const [key, value] of missing) console.log(`  ${key} = ${value}`);
  if (execute) {
    await CommerceSettings.updateOne({ key: 'commerce' }, { $set: Object.fromEntries(missing) });
    console.log('Done.');
  } else {
    console.log('\nNo data changed. Run with --execute to apply.');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => disconnectDatabase());
