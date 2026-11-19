import { AccountStatus, AccountType, ScopeType, UserRole } from '@lib/constants';
import { hashPassword } from '@lib/security';
import { MarketVendor } from '@models/catalog/market-vendor.model';
import { User } from '@models/users/user.model';
import { revokeAccountSessions } from '@modules/identity/account-session.service';
import { nextPublicId } from '@modules/platform';
import { HttpError, isDuplicateKeyError } from '@utils/http';

/** Every new vendor account starts here and is forced to choose its own password at first sign-in. */
export const DEFAULT_VENDOR_PASSWORD = '123456';

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] || 'Vendor', lastName: parts.slice(1).join(' ') };
}

/**
 * Gives a vendor a login: a User of type vendor with the default password and a forced change. Idempotent, so
 * onboarding, the backfill script and "reset password" can all call it. Vendors are verified from the start.
 */
export async function provisionVendorAccount(vendor: any, options: { resetPassword?: boolean } = {}) {
  const emailAddress = String(vendor.email || '').trim().toLowerCase();
  if (!emailAddress) throw new HttpError(400, 'A vendor needs an email address to sign in', { field: 'email' }, 'VALIDATION_ERROR');

  let account: any = vendor.accountId ? await User.findById(vendor.accountId) : null;
  if (!account) {
    const existing: any = await User.findOne({ email: emailAddress }).lean();
    if (existing && existing.accountType !== AccountType.VENDOR) {
      throw new HttpError(409, 'An account with this email already exists', { field: 'email' }, 'CONFLICT');
    }
    account = existing ? await User.findById(existing._id) : null;
  }

  const { firstName, lastName } = splitName(vendor.contactName || vendor.businessName);
  if (!account) {
    try {
      account = await User.create({
        publicId: await nextPublicId('vendorAccount'),
        accountType: AccountType.VENDOR,
        accountStatus: AccountStatus.ACTIVE,
        role: UserRole.VENDOR,
        scopeType: ScopeType.SELF,
        email: emailAddress,
        phone: vendor.phone,
        firstName,
        lastName,
        password: await hashPassword(DEFAULT_VENDOR_PASSWORD),
        mustChangePassword: true,
        isActive: vendor.status === 'active',
        isEmailVerified: true,
        isPhoneVerified: false,
      } as any);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new HttpError(409, 'An account with this email or phone already exists', undefined, 'CONFLICT');
      throw error;
    }
  } else if (options.resetPassword) {
    account.password = await hashPassword(DEFAULT_VENDOR_PASSWORD);
    account.mustChangePassword = true;
    account.failedLoginAttempts = 0;
    account.lockedUntil = undefined;
    await account.save();
    await revokeAccountSessions(account.id, 'vendor_password_reset');
  }

  await MarketVendor.updateOne({ _id: vendor._id }, { $set: { accountId: account.id, verifiedAt: vendor.verifiedAt || new Date() } });
  return { accountId: account.id as string, email: emailAddress };
}

/** Keeps the login in step when staff change a vendor: suspended or blocked vendors cannot sign in. */
export async function syncVendorAccount(vendor: any, changes: { email?: string; phone?: string; status?: string; contactName?: string }) {
  if (!vendor.accountId) return;
  const set: Record<string, unknown> = {};
  if (changes.email) set.email = changes.email;
  if (changes.phone) set.phone = changes.phone;
  if (changes.contactName) Object.assign(set, splitName(changes.contactName));
  if (changes.status) {
    const active = changes.status === 'active';
    set.isActive = active;
    set.accountStatus = active ? AccountStatus.ACTIVE : AccountStatus.SUSPENDED;
  }
  if (!Object.keys(set).length) return;
  await User.updateOne({ _id: vendor.accountId }, { $set: set });
  if (changes.status && changes.status !== 'active') await revokeAccountSessions(vendor.accountId, 'vendor_suspended');
}
