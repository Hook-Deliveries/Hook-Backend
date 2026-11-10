import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { resetAppleKeyCache, verifyAppleIdentityToken } from '../src/modules/identity/apple-auth.service';

/** A real RS256 key pair standing in for Apple's, so tokens are genuinely signed and verified. */
function appleLikeKey(kid: string) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const sign = (over: Record<string, unknown> = {}, expiresIn: string | number = '10m') =>
    jwt.sign(
      { iss: 'https://appleid.apple.com', aud: 'com.biodun42.hook', sub: 'apple-user-1', email: 'Person@Example.com', email_verified: 'true', ...over },
      privateKey,
      { algorithm: 'RS256', keyid: kid, expiresIn: expiresIn as never },
    );
  return { jwk, sign };
}

const keysResponse = (...keys: unknown[]) => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } });
const previousEnv = { audience: process.env.APPLE_CLIENT_ID, node: process.env.NODE_ENV };

beforeEach(() => {
  resetAppleKeyCache();
  delete process.env.APPLE_CLIENT_ID;
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  if (previousEnv.audience === undefined) delete process.env.APPLE_CLIENT_ID; else process.env.APPLE_CLIENT_ID = previousEnv.audience;
  if (previousEnv.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv.node;
});

test('a genuine Apple token is verified and normalised', async () => {
  const key = appleLikeKey('k1');
  mock.method(globalThis, 'fetch', async () => keysResponse(key.jwk));
  const result = await verifyAppleIdentityToken(key.sign());
  assert.deepEqual(result, { sub: 'apple-user-1', email: 'person@example.com', emailVerified: true });
});

test('a failed key download is retried instead of failing the sign-in', async () => {
  const key = appleLikeKey('k1');
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls < 3) throw new Error('socket hang up');
    return keysResponse(key.jwk);
  });
  assert.equal((await verifyAppleIdentityToken(key.sign())).sub, 'apple-user-1');
  assert.equal(calls, 3);
});

test('keys are downloaded once for several sign-ins at the same time', async () => {
  const key = appleLikeKey('k1');
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return keysResponse(key.jwk);
  });
  await Promise.all([1, 2, 3, 4].map(() => verifyAppleIdentityToken(key.sign())));
  assert.equal(calls, 1);
});

test('when Apple cannot be reached, keys already held keep sign-in working', async (t) => {
  const key = appleLikeKey('k1');
  const fetchMock = mock.method(globalThis, 'fetch', async () => keysResponse(key.jwk));
  await verifyAppleIdentityToken(key.sign());
  // Two hours later the keys are stale and Apple is unreachable.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * 60 * 1000 });
  fetchMock.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal((await verifyAppleIdentityToken(key.sign())).sub, 'apple-user-1');
});

test('a key Apple has rotated in is picked up by refreshing once', async () => {
  const oldKey = appleLikeKey('old');
  const newKey = appleLikeKey('new');
  let served = [oldKey.jwk];
  mock.method(globalThis, 'fetch', async () => keysResponse(...served));
  await verifyAppleIdentityToken(oldKey.sign());
  served = [oldKey.jwk, newKey.jwk];
  assert.equal((await verifyAppleIdentityToken(newKey.sign())).sub, 'apple-user-1');
});

test('with no keys at all, the customer gets a clear, retryable error', async () => {
  const key = appleLikeKey('k1');
  mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(verifyAppleIdentityToken(key.sign()), (error: { statusCode?: number; code?: string; message?: string }) =>
    error.statusCode === 503 && error.code === 'APPLE_KEYS_UNAVAILABLE' && /try again/i.test(error.message || ''));
});

test('a token for a different app is refused, and the log says which audience it was for', async () => {
  const key = appleLikeKey('k1');
  mock.method(globalThis, 'fetch', async () => keysResponse(key.jwk));
  process.env.NODE_ENV = 'production';
  const warn = console.warn as unknown as ReturnType<typeof mock.fn>;
  await assert.rejects(verifyAppleIdentityToken(key.sign({ aud: 'com.someone.else' })), { statusCode: 401 });
  const logged = JSON.parse(String((warn as any).mock.calls.at(-1).arguments[0]));
  assert.equal(logged.event, 'apple_auth.rejected');
  assert.equal(logged.tokenAudience, 'com.someone.else');
  assert.deepEqual(logged.expectedAudiences, ['com.biodun42.hook']);
});

test('an expired token is refused', async () => {
  const key = appleLikeKey('k1');
  mock.method(globalThis, 'fetch', async () => keysResponse(key.jwk));
  await assert.rejects(verifyAppleIdentityToken(key.sign({}, -60)), { statusCode: 401 });
});
