import crypto from 'crypto';
import { adminAppBaseUrl } from '@services/email-settings.service';
import { AccountStatus, AccountType } from '@lib/constants';
import { hashPassword } from '@lib/security';
import { AccountInvitation } from '@models/platform/account-invitation.model';
import { HookPartner, MarketAssociateProfile, StaffProfile } from '@models/platform/operations-accounts.model';
import { User } from '@models/users/user.model';
import { HttpError } from '@utils/http';
import { EmailService } from '@emails/email.service';
import { PlatformAuditLog } from '@models/platform/audit-log.model';
import { nextPublicId } from '@modules/platform/public-id.service';
import { createCommerceNotification } from './commerce-notification.service';

const email = new EmailService();
const invitationTtlHours = Number(process.env.ACCOUNT_INVITATION_TTL_HOURS || 48);

function tokenDigest(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function activationPath(accountType: AccountType) {
  if (accountType === AccountType.MARKETASSOCIATE) return '/market-associate/activate';
  if (accountType === AccountType.PARTNER) return '/partner/activate';
  if (accountType === AccountType.CUSTOMER) return '/customer/activate';
  return '/activate';
}

function accountTypeLabel(accountType: AccountType) {
  if (accountType === AccountType.MARKETASSOCIATE) return 'Market Associate';
  if (accountType === AccountType.PARTNER) return 'Partner';
  if (accountType === AccountType.STAFF) return 'Staff';
  return 'Hook';
}

export async function issueAccountInvitation(input: {
  accountId: string;
  accountType: AccountType;
  email: string;
  name: string;
  invitedBy: string;
}) {
  await AccountInvitation.updateMany(
    { accountId: input.accountId, acceptedAt: { $exists: false }, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + invitationTtlHours * 60 * 60 * 1000);
  await AccountInvitation.create({
    accountId: input.accountId,
    accountType: input.accountType,
    email: input.email,
    tokenHash: tokenDigest(token),
    expiresAt,
    invitedBy: input.invitedBy,
  });
  const baseUrl = (await adminAppBaseUrl());
  const activationUrl = `${baseUrl}${activationPath(input.accountType)}?token=${encodeURIComponent(token)}`;
  const delivery = await email.sendAccountInvitation({
    email: input.email,
    name: input.name,
    accountType: accountTypeLabel(input.accountType),
    activationUrl,
    expiresInHours: invitationTtlHours,
  }).catch((error) => {
    console.error(`[account-invitation] Delivery failed for account ${input.accountId}`, error);
    return { delivered: false, provider: 'error' };
  });
  return { expiresAt, delivery };
}

/**
 * Customer variant of issueAccountInvitation: same token/expiry mechanics,
 * but the email needs Partner/Market context a generic staff invitation
 * doesn't carry, so it uses its own template rather than sendAccountInvitation.
 */
export async function issueCustomerAccountSetup(input: {
  accountId: string;
  email: string;
  name: string;
  partnerName: string;
}) {
  await AccountInvitation.updateMany(
    { accountId: input.accountId, acceptedAt: { $exists: false }, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + invitationTtlHours * 60 * 60 * 1000);
  await AccountInvitation.create({
    accountId: input.accountId,
    accountType: AccountType.CUSTOMER,
    email: input.email,
    tokenHash: tokenDigest(token),
    expiresAt,
    invitedBy: input.accountId,
  });
  const baseUrl = (await adminAppBaseUrl());
  const activationUrl = `${baseUrl}${activationPath(AccountType.CUSTOMER)}?token=${encodeURIComponent(token)}`;
  const delivery = await email.sendCustomerAccountSetup({
    email: input.email,
    name: input.name,
    partnerName: input.partnerName,
    activationUrl,
    expiresInHours: invitationTtlHours,
  }).catch((error) => {
    console.error(`[account-invitation] Customer setup email failed for account ${input.accountId}`, error);
    return { delivered: false, provider: 'error' };
  });
  return { expiresAt, delivery };
}

export async function revokeAccountInvitations(accountId: string) {
  const result = await AccountInvitation.updateMany(
    {
      accountId,
      acceptedAt: { $exists: false },
      revokedAt: { $exists: false },
    },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount;
}

export async function acceptAccountInvitation(
  token: string,
  password: string,
  context?: { requestId?: string; ipAddress?: string; userAgent?: string },
) {
  const invitation = await AccountInvitation.findOne({
    tokenHash: tokenDigest(token),
    acceptedAt: { $exists: false },
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  if (!invitation) {
    throw new HttpError(400, 'Invitation is invalid or has expired', undefined, 'TOKEN_INVALID');
  }
  const account = await User.findById(invitation.accountId);
  if (!account || !account.isActive) {
    throw new HttpError(409, 'Account cannot be activated', undefined, 'INVALID_STATE_TRANSITION');
  }
  /**
   * Staff/Market Associate/Partner invitees start life as INVITED. Customers created at
   * a Partner's counter start PENDING_PASSWORD instead (they already have a
   * usable account, they just need a password) — both are valid pre-activation
   * states for this endpoint, anything else means the account already moved on.
   */
  const acceptableStatus: AccountStatus[] =
    invitation.accountType === AccountType.CUSTOMER
      ? [AccountStatus.PENDING_PASSWORD, AccountStatus.INVITED]
      : [AccountStatus.INVITED];
  if (!acceptableStatus.includes(account.accountStatus ?? AccountStatus.ACTIVE)) {
    throw new HttpError(409, 'Account cannot be activated', undefined, 'INVALID_STATE_TRANSITION');
  }

  const acceptedAt = new Date();
  account.password = await hashPassword(password);
  account.passwordChangedAt = acceptedAt;
  account.isEmailVerified = true;
  account.accountStatus = AccountStatus.ACTIVE;
  await account.save();
  await AccountInvitation.updateOne({ _id: invitation._id }, { $set: { acceptedAt } });

  const profileUpdate = { $set: { status: AccountStatus.ACTIVE } };
  if (invitation.accountType === AccountType.STAFF) {
    await StaffProfile.updateOne({ accountId: account.id }, profileUpdate);
  } else if (invitation.accountType === AccountType.MARKETASSOCIATE) {
    await MarketAssociateProfile.updateOne({ accountId: account.id }, profileUpdate);
  } else if (invitation.accountType === AccountType.PARTNER) {
    await HookPartner.updateOne({ accountId: account.id }, profileUpdate);
  }
  await PlatformAuditLog.create({
    publicId: await nextPublicId('audit'),
    actorType: invitation.accountType,
    actorId: account.id,
    actorPublicId: account.publicId,
    action: 'account.invitation_accepted',
    entityType: invitation.accountType,
    entityId: account.id,
    entityPublicId: account.publicId,
    requestId: context?.requestId || 'invitation-activation',
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });
  await createCommerceNotification({
    eventKey: `account:${account.id}:activated`,
    userId: account.id,
    title: "You're all set",
    body: `Your Hook ${accountTypeLabel(invitation.accountType)} account is now active.`,
    type: 'account_activated',
    data: { accountType: invitation.accountType },
  }).catch(() => undefined);
  if (account.email) {
    await email.sendAccountActivated({
      email: account.email,
      name: account.firstName,
      accountType: accountTypeLabel(invitation.accountType),
    }).catch(() => undefined);
  }
  return { activated: true, accountType: invitation.accountType };
}
