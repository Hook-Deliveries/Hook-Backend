import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { signAccessToken, signRefreshToken } from '../src/modules/identity/token.service';
import { AccountType, UserRole } from '../src/lib/constants';

test('customer token lasts seven days while staff policy remains short', () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalExpiry = process.env.JWT_EXPIRY;
  try {
    process.env.JWT_SECRET = 'test-only-account-policy-secret-not-for-production';
    process.env.JWT_EXPIRY = '15m';
    const base = { sub: 'test-account', email: 'test@example.invalid', role: UserRole.CUSTOMER };
    const customer = jwt.decode(signAccessToken({ ...base, accountType: AccountType.CUSTOMER })) as jwt.JwtPayload;
    const staff = jwt.decode(signAccessToken({ ...base, accountType: AccountType.STAFF })) as jwt.JwtPayload;
    assert.equal(customer.exp! - customer.iat!, 7 * 86400);
    assert.equal(staff.exp! - staff.iat!, 900);
    const first = signRefreshToken({ ...base, accountType: AccountType.CUSTOMER });
    const second = signRefreshToken({ ...base, accountType: AccountType.CUSTOMER });
    assert.notEqual(first, second);
    assert.throws(() => jwt.verify(signAccessToken({ ...base, accountType: AccountType.CUSTOMER }), process.env.JWT_SECRET!, { clockTimestamp: customer.exp! + 1 }));
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalExpiry === undefined) delete process.env.JWT_EXPIRY;
    else process.env.JWT_EXPIRY = originalExpiry;
  }
});
