import { connectDatabase, disconnectDatabase } from '@config/data-source';
import { AccountStatus, AccountType, ScopeType, UserRole } from '@lib/constants';
import { hashPassword } from '@lib/security';
import { User } from '@models/users/user.model';
import { nextPublicId } from '@modules/platform/public-id.service';

/**
 * Creates (or resets) a verified customer account for App Store / Play review. Never clears anything.
 *   DEMO_EMAIL=test@gmail.com DEMO_PASSWORD=... npm run seed:demo-customer
 */
const email = String(process.env.DEMO_EMAIL || '').toLowerCase().trim();
const password = String(process.env.DEMO_PASSWORD || '');

async function main() {
  if (!email || password.length < 8) throw new Error('Set DEMO_EMAIL and a DEMO_PASSWORD of at least 8 characters');
  await connectDatabase();
  const hashed = await hashPassword(password);
  const existing = await User.findOne({ email });
  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: { password: hashed, passwordChangedAt: new Date(), isActive: true, accountStatus: AccountStatus.ACTIVE, isEmailVerified: true } });
    console.log(`  reset — ${email} (${existing.publicId})`);
    return;
  }
  const user = await User.create({
    publicId: await nextPublicId('customer'),
    email,
    phone: '+2348020000099',
    password: hashed,
    firstName: 'Demo',
    lastName: 'Reviewer',
    role: UserRole.SHOPPER,
    accountType: AccountType.CUSTOMER,
    accountStatus: AccountStatus.ACTIVE,
    scopeType: ScopeType.SELF,
    isActive: true,
    isEmailVerified: true,
    isPhoneVerified: true,
    passwordChangedAt: new Date(),
  });
  console.log(`  created — ${email} (${user.publicId})`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => void disconnectDatabase());
