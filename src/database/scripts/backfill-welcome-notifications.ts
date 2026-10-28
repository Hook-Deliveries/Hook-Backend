import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { Notification } from '@models/notifications/notification.model';
import { CreditLedger } from '@models/promotions/credit-ledger.model';
import { User } from '@models/users/user.model';
import { CreditService } from '@modules/orders/credit.service';

const execute = process.argv.includes('--execute');
const credits = new CreditService();

/**
 * Accounts credited by topup-customer-credits.ts received their Hook credit
 * before credit notifications existed, so they were never told about it.
 * This posts the missing notification for them.
 *
 * announceWelcomeBonus() dedupes on eventKey, so re-running is a no-op for
 * anyone who already has the notification.
 */
async function main() {
  await connectDatabase();

  const entries = await CreditLedger.find({ type: 'welcome_bonus' })
    .select('userId amountMinor')
    .lean();
  console.log(`${execute ? 'Backfilling' : 'Dry run for'} welcome notifications (${entries.length} credited account(s)):\n`);

  for (const entry of entries) {
    const userId = String(entry.userId);
    const user = await User.findById(userId).select('email').lean();
    const already = await Notification.exists({ eventKey: `credit:welcome:${userId}` });
    if (already) {
      console.log(`  skip — ${user?.email || userId} already has it`);
      continue;
    }
    if (execute) await credits.announceWelcomeBonus(userId, Number(entry.amountMinor));
    console.log(`  ${execute ? 'Posted' : 'Would post'} for ${user?.email || userId} (₦${(Number(entry.amountMinor) / 100).toLocaleString()})`);
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => disconnectDatabase());
