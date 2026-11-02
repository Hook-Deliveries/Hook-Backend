import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Handover codes are stored encrypted so the associate can be shown the code
 * again after a refresh. In production the key must be set explicitly: an
 * unset key used to fall back to JWT_SECRET and then to a string published in
 * this repository, which would make the stored codes readable to anyone.
 */
function key() {
  const configured = process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('PACKAGE_CREDENTIAL_ENCRYPTION_KEY is required in production');
  }
  return createHash('sha256')
    .update(configured || process.env.JWT_SECRET || 'hook-development-package-key')
    .digest();
}

export function encryptPackageCredential(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptPackageCredential(value: string) {
  const [iv, tag, encrypted] = value.split('.');
  if (!iv || !tag || !encrypted) throw new Error('Invalid package credential');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

/** Decrypts, or returns undefined if the value is damaged or the key changed. Never throws. */
export function tryDecryptPackageCredential(value: string | undefined | null) {
  if (!value) return undefined;
  try {
    return decryptPackageCredential(value);
  } catch {
    return undefined;
  }
}
