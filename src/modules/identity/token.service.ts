import jwt, { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { AccountType, UserRole } from '@lib/constants';
import { jwtSecret } from '@config/env';

export interface AuthUserPayload {
  sub: string;
  email: string;
  role: UserRole;
  accountType?: AccountType;
  sid?: string;
  familyId?: string;
}

export function signAccessToken(payload: AuthUserPayload) {
  const options: SignOptions = {
    // Customer mobile sessions renew weekly; staff tokens retain their shorter policy.
    expiresIn: payload.accountType === AccountType.CUSTOMER
      ? '7d'
      : (process.env.JWT_EXPIRY || '15m') as SignOptions['expiresIn'],
  };

  return jwt.sign(payload, jwtSecret(), options);
}

export function signRefreshToken(payload: AuthUserPayload) {
  const options: SignOptions = {
    expiresIn: (process.env.JWT_REFRESH_EXPIRY || '30d') as SignOptions['expiresIn'],
    jwtid: randomUUID(),
  };

  return jwt.sign(payload, jwtSecret(), options);
}
