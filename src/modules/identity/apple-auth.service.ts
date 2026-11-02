import { createPublicKey } from 'crypto';
import jwt, { JwtHeader, JwtPayload } from 'jsonwebtoken';
import { HttpError } from '@utils/http';

type AppleKey = JsonWebKey & { kid?: string };

let cachedKeys: { expiresAt: number; keys: AppleKey[] } | undefined;

async function appleKeys() {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  try {
    const response = await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Apple responded ${response.status}`);
    const payload = await response.json() as { keys: AppleKey[] };
    if (!Array.isArray(payload.keys) || !payload.keys.length) throw new Error('Apple returned no signing keys');
    cachedKeys = { keys: payload.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
    return payload.keys;
  } catch (error) {
    console.error('[apple-auth] could not load Apple signing keys:', error instanceof Error ? error.message : error);
  
    if (cachedKeys) return cachedKeys.keys;
    throw new HttpError(503, 'Apple sign-in is temporarily unavailable');
  }
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

export async function verifyAppleIdentityToken(identityToken: string) {
  const decoded = jwt.decode(identityToken, { complete: true });
  const header = decoded?.header as JwtHeader | undefined;
  if (!header?.kid) throw new HttpError(401, 'Invalid Apple identity token');
  const key = (await appleKeys()).find((candidate) => candidate.kid === header.kid);
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
  } catch {
    throw new HttpError(401, 'Invalid or expired Apple identity token');
  }
}
