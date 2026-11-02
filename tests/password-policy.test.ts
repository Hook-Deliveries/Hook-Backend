import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSchema, passwordResetSchema, changePasswordSchema, loginSchema } from '../src/validations/common.schemas';
test('new customer passwords accept eight and reject seven characters', () => {
  for (const password of ['12345678', 'longer-password']) {
    assert.equal(registerSchema.safeParse({ email: 'test@example.com', password }).success, true);
    assert.equal(passwordResetSchema.safeParse({ email: 'test@example.com', code: '1234', password }).success, true);
    assert.equal(changePasswordSchema.safeParse({ currentPassword: 'existing', newPassword: password }).success, true);
  }
  assert.equal(registerSchema.safeParse({ email: 'test@example.com', password: '1234567' }).success, false);
  assert.equal(passwordResetSchema.safeParse({ email: 'test@example.com', code: '1234', password: '1234567' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'existing', newPassword: '1234567' }).success, false);
  assert.equal(loginSchema.safeParse({ email: 'test@example.com', password: 'legacy' }).success, true);
});
