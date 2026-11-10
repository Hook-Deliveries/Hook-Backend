import { createPublicKey } from 'crypto';
import jwt, { JwtHeader, JwtPayload } from 'jsonwebtoken';
import { HttpError } from '@utils/http';

type AppleKey = JsonWebKey & { kid?: string };

const KEYS_URL = 'https://appleid.apple.com/auth/keys';
/** Keys are reused for an hour. After that they are refreshed, but a stale copy still works if Apple cannot be reached. */
const FRESH_MS = 60 * 60 * 1000;
const STALE_OK_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPTS = 3;

let cachedKeys: { fetchedAt: number; keys: AppleKey[] } | undefined;
let inflight: Promise<AppleKey[]> | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Downloads Apple's signing keys, retrying quickly: one slow or dropped request must not fail a sign-in. */
async function downloadKeys(): Promise<AppleKey[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Apple responded ${response.status}`);
      const payload = (await response.json()) as { keys?: AppleKey[] };
      if (!Array.isArray(payload.keys) || !payload.keys.length) throw new Error('Apple returned no signing keys');
      return payload.keys;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS - 1) await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function appleKeys(forceRefresh = false): Promise<AppleKey[]> {
  const now = Date.now();
  if (!forceRefresh && cachedKeys && now - cachedKeys.fetchedAt < FRESH_MS) return cachedKeys.keys;
  // Concurrent sign-ins share one download.
  inflight ??= downloadKeys()
    .then((keys) => {
      cachedKeys = { fetchedAt: Date.now(), keys };
      return keys;
    })
    .finally(() => {
      inflight = undefined;
    });
  try {
    return await inflight;
  } catch (error) {
    console.error('[apple-auth] could not load Apple signing keys:', error instanceof Error ? error.message : error);
    if (cachedKeys && now - cachedKeys.fetchedAt < STALE_OK_MS) return cachedKeys.keys;
    throw new HttpError(503, 'Apple sign-in is temporarily unavailable. Please try again in a moment.', undefined, 'APPLE_KEYS_UNAVAILABLE');
  }
}

/** Loads the keys in the background at startup so the first customer to tap "Sign in with Apple" is not the one who waits. */
export function warmAppleKeys() {
  void appleKeys().catch(() => undefined);
}

/** Forgets the cached keys. Only tests need this. */
export function resetAppleKeyCache() {
  cachedKeys = undefined;
  inflight = undefined;
}

/**
 * Apple signs the identity token for the app that asked: the store build's bundle id, or, while
 * developing, Expo Go (host.exp.Exponent) and the local dev build. Only the real bundle id is ever
 * accepted in production. APPLE_CLIENT_ID may list several ids, comma separated.
 */
function appleAudiences() {
  const configured = (process.env.APPLE_CLIENT_ID || 'com.biodun42.hook').split(',').map((value) => value.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production') return configured;
  return [...new Set([...configured, 'host.exp.Exponent', 'com.biodun42.hook.dev'])];
}

function tokenAudience(identityToken: string) {
  const payload = jwt.decode(identityToken) as JwtPayload | null;
  return payload?.aud;
}

export async function verifyAppleIdentityToken(identityToken: string) {
  const decoded = jwt.decode(identityToken, { complete: true });
  const header = decoded?.header as JwtHeader | undefined;
  if (!header?.kid) throw new HttpError(401, 'Invalid Apple identity token');
  let key = (await appleKeys()).find((candidate) => candidate.kid === header.kid);
  // Apple rotates its keys: a key we do not know may simply be newer than our copy.
  if (!key) key = (await appleKeys(true)).find((candidate) => candidate.kid === header.kid);
  if (!key) throw new HttpError(401, 'Apple identity key was not recognized');
  const audience = appleAudiences() as [string, ...string[]];
  try {
    const payload = jwt.verify(identityToken, createPublicKey({ key, format: 'jwk' }), {
      algorithms: ['RS256'],
      audience,
      issuer: 'https://appleid.apple.com',
    }) as JwtPayload;
    if (!payload.sub) throw new Error('Missing subject');
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase().trim() : undefined,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  } catch (error) {
    // Say exactly why, in the logs: the usual cause is an app whose bundle id is not in APPLE_CLIENT_ID.
    console.warn(JSON.stringify({
      event: 'apple_auth.rejected',
      reason: error instanceof Error ? error.message : 'unknown',
      tokenAudience: tokenAudience(identityToken),
      expectedAudiences: audience,
    }));
    throw new HttpError(401, 'Invalid or expired Apple identity token');
  }
}
