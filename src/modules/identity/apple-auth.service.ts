import { createPublicKey } from 'crypto';
import jwt, { JwtHeader, JwtPayload } from 'jsonwebtoken';
import { HttpError } from '@utils/http';

type AppleKey = JsonWebKey & { kid?: string };

let cachedKeys: { expiresAt: number; keys: AppleKey[] } | undefined;

async function appleKeys() {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetch('https://appleid.apple.com/auth/keys');
  if (!response.ok) throw new HttpError(503, 'Apple sign-in is temporarily unavailable');
  const payload = await response.json() as { keys: AppleKey[] };
  cachedKeys = { keys: payload.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return payload.keys;
}

export async function verifyAppleIdentityToken(identityToken: string) {
  const decoded = jwt.decode(identityToken, { complete: true });
  const header = decoded?.header as JwtHeader | undefined;
  if (!header?.kid) throw new HttpError(401, 'Invalid Apple identity token');
  const key = (await appleKeys()).find((candidate) => candidate.kid === header.kid);
  if (!key) throw new HttpError(401, 'Apple identity key was not recognized');
  const audience = process.env.APPLE_CLIENT_ID || 'com.biodun42.hook';
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
