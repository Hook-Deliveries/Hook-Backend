import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { findStaleInvitations, purgeUnacceptedAccount } from '@modules/identity/stale-invitation.service';

const execute = process.argv.includes('--execute');

/** Removes dead invited-but-never-accepted accounts (failed create or cancelled invitation) so their emails can be reused; pending invitations are left alone. */
async function main() {
  await connectDatabase();
  const stale = await findStaleInvitations();
  console.log(`${execute ? 'Removing' : 'Would remove'} ${stale.length} unaccepted account(s):`);
  for (const item of stale) console.log(`  ${item.kind}  ${item.email}  (${item.reason})`);
  if (!execute) return console.log('\nNo data changed. Run with --execute to apply.');
  let removed = 0;
  for (const item of stale) if (await purgeUnacceptedAccount(item.userId)) removed += 1;
  console.log(`\nRemoved ${removed}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDatabase());
