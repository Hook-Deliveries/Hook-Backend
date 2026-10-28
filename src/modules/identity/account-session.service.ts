import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { AccountType } from '@lib/constants';
import { isActiveAccount } from '@lib/account-state';
import { jwtSecret } from '@config/env';
import { AccountSession } from '@models/platform/session.model';
import { User } from '@models/users/user.model';
import { resolveAccessContext } from '@modules/identity/access-control.service';
import { presentPlatformRecords } from '@modules/platform';
import { HttpError } from '@utils/http';
import { AuthUserPayload, signAccessToken, signRefreshToken } from '@modules/identity/token.service';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function refreshExpiry() {
  const raw = process.env.JWT_REFRESH_EXPIRY || '30d';
  const match = /^(\d+)([dhm])$/.exec(raw);
  if (!match) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const amount = Number(match[1]);
  const unit = match[2] === 'd' ? 86400000 : match[2] === 'h' ? 3600000 : 60000;
  return new Date(Date.now() + amount * unit);
}

export async function presentAccountUser(user: User) {
  const accountId = (user as any)._id?.toString?.() || user.id;
  const base = {
    id: accountId,
    publicId: user.publicId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role,
    accountType: user.accountType,
    accountStatus: user.accountStatus,
    avatarUrl: user.avatarUrl,
    isEmailVerified: user.isEmailVerified,
  };
  if (user.accountType !== AccountType.STAFF) return base;
  const context = await resolveAccessContext(accountId);
  return presentPlatformRecords({
    ...base,
    id: user.publicId,
    roleKeys: context.roleKeys,
    permissions: [...context.permissions],
    scopeType: context.scopeType,
    assignedStateIds: context.stateIds,
    assignedHubIds: context.hubIds,
  });
}

export type SessionMetadata = {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  ipAddress?: string;
  userAgent?: string;
};

export async function issueAccountSession(
  user: User,
  metadata: SessionMetadata = {},
) {
  const familyId = randomUUID();
  const session = new AccountSession({
    accountId: user.id,
    accountType: user.accountType || AccountType.CUSTOMER,
    familyId,
    refreshTokenHash: 'pending',
    ...metadata,
    expiresAt: refreshExpiry(),
    lastUsedAt: new Date(),
  });
  const payload: AuthUserPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    accountType: user.accountType || AccountType.CUSTOMER,
    sid: session.id,
    familyId,
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  session.refreshTokenHash = hash(refreshToken);
  await session.save();
  return { accessToken, refreshToken, accessExpiresAt: new Date((jwt.decode(accessToken) as jwt.JwtPayload).exp! * 1000).toISOString(), user: await presentAccountUser(user) };
}

export async function rotateAccountSession(refreshToken: string) {
  let payload: AuthUserPayload;
  try {
    payload = jwt.verify(refreshToken, jwtSecret()) as AuthUserPayload;
  } catch {
    throw new HttpError(401, 'Invalid refresh token', undefined, 'TOKEN_INVALID');
  }
  if (!payload.sid || !payload.familyId) {
    throw new HttpError(401, 'Legacy session expired. Please sign in again.', undefined, 'TOKEN_INVALID');
  }
  const session = await AccountSession.findById(payload.sid);
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw new HttpError(401, 'Invalid refresh token', undefined, 'TOKEN_INVALID');
  }
  if (session.refreshTokenHash !== hash(refreshToken)) {
    await AccountSession.updateMany(
      { familyId: session.familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revocationReason: 'refresh_token_replay' } },
    );
    throw new HttpError(401, 'Session has been revoked', undefined, 'TOKEN_INVALID');
  }
  const user = await User.findById(session.accountId).lean({ virtuals: true }) as User | null;
  if (!user || !isActiveAccount(user)) {
    await revokeAccountSessions(session.accountId, 'account_inactive');
    throw new HttpError(401, 'Account is not active', undefined, 'TOKEN_INVALID');
  }
  const nextPayload: AuthUserPayload = {
    // `lean()` does not reliably include the base schema's virtual `id`.
    // Access-token subjects must always use the persisted Mongo identifier.
    sub: (user as any)._id?.toString?.() || user.id,
    email: user.email,
    role: user.role,
    accountType: user.accountType,
    sid: session.id,
    familyId: session.familyId,
  };
  const nextRefresh = signRefreshToken(nextPayload);
  // Compare-and-swap prevents parallel refreshes from issuing two valid successors.
  const rotated = await AccountSession.updateOne(
    { _id: session.id, refreshTokenHash: hash(refreshToken), revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { refreshTokenHash: hash(nextRefresh), lastUsedAt: new Date(), expiresAt: refreshExpiry() } },
  );
  if (rotated.modifiedCount !== 1) {
    throw new HttpError(401, 'Session renewal was already processed. Please sign in again.', undefined, 'TOKEN_INVALID');
  }
  const accessToken = signAccessToken(nextPayload);
  return {
    accessToken,
    accessExpiresAt: new Date((jwt.decode(accessToken) as jwt.JwtPayload).exp! * 1000).toISOString(),
    refreshToken: nextRefresh,
    user: await presentAccountUser(user),
  };
}

export async function revokeAccountSession(refreshToken?: string, sessionId?: string, reason = 'logout') {
  let id = sessionId;
  if (!id && refreshToken) {
    try {
      id = (jwt.verify(refreshToken, jwtSecret()) as AuthUserPayload).sid;
    } catch {
      return;
    }
  }
  if (id) {
    await AccountSession.updateOne(
      { _id: id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revocationReason: reason } },
    );
  }
}

export async function revokeAccountSessions(accountId: string, reason: string, actorId?: string) {
  await AccountSession.updateMany(
    { accountId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revocationReason: reason, revokedBy: actorId } },
  );
}
