import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { AccountType } from '@lib/constants';
import { CommerceSettings } from '@models/commerce/commerce.model';
import { CreditLedger } from '@models/promotions/credit-ledger.model';
import { User } from '@models/users/user.model';
import { CreditService } from '@modules/orders/credit.service';

const execute = process.argv.includes('--execute');
const credits = new CreditService();

/**
 * Brings every existing customer up to the welcome balance new signups now
 * receive, so accounts created before the bonus existed are not left behind.
 * Only tops up the shortfall — an account already at or above the target is
 * left alone, and nobody's balance is ever reduced.
 */
async function main() {
  await connectDatabase();

  const settings = await CommerceSettings.findOne({ key: 'commerce' }).select('welcomeBonusMinor').lean();
  const target = Number(settings?.welcomeBonusMinor ?? 30000);
  console.log(`${execute ? 'Topping up' : 'Dry run for'} customers to ₦${(target / 100).toLocaleString()}:\n`);

  const customers = await User.find({ accountType: AccountType.CUSTOMER })
    .select('_id email')
    .lean();

  for (const customer of customers) {
    const id = String(customer._id);
    const balance = await credits.balance(id);
    if (balance >= target) {
      console.log(`  skip — ${customer.email} already has ₦${(balance / 100).toLocaleString()}`);
      continue;
    }
    const shortfall = target - balance;
    if (execute) {
      await CreditLedger.create({
        userId: id,
        type: 'welcome_bonus',
        amountMinor: shortfall,
        // Distinct from the signup grant's `welcome:<id>` key so this top-up
        // can run without colliding with a bonus the account already got.
        idempotencyKey: `welcome-topup:${id}`,
        note: 'Starting Hook credit',
      });
    }
    console.log(`  ${execute ? 'Credited' : 'Would credit'} ${customer.email} +₦${(shortfall / 100).toLocaleString()} (was ₦${(balance / 100).toLocaleString()})`);
  }

  if (!execute) console.log('\nNo data changed. Run with --execute to apply.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => disconnectDatabase());
