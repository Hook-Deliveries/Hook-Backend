const unsafeJwtSecrets = new Set([
  'change-me-in-production',
  'hook-dev-jwt-secret-change-in-production-12345',
  'secret',
  'password',
]);

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function jwtSecret() {
  return requireEnv('JWT_SECRET');
}

export function parseOrigins() {
  const raw = process.env.CORS_ORIGINS;
  if (!raw || raw.trim() === '') {
    if (isProduction()) throw new Error('CORS_ORIGINS is required in production');
    return ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'];
  }
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export function assertSafeEnvironment() {
  requireEnv('MONGODB_URI');
  const secret = jwtSecret();
  const origins = parseOrigins();

  if (isProduction()) {
    if (unsafeJwtSecrets.has(secret) || secret.length < 32) {
      throw new Error('JWT_SECRET must be a strong production secret with at least 32 characters');
    }
    if (origins.includes('*')) {
      throw new Error('CORS_ORIGINS cannot be * in production when credentials are enabled');
    }
    for (const origin of origins) {
      if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
        throw new Error(`Invalid CORS origin: ${origin}`);
      }
    }
    if (process.env.CLOUDINARY_UPLOADS_ENABLED !== 'false') {
      requireEnv('CLOUDINARY_CLOUD_NAME');
      requireEnv('CLOUDINARY_UPLOAD_PRESET');
    }
    if (process.env.CATALOG_SIGNED_MEDIA_ENABLED !== 'false') {
      requireEnv('CLOUDINARY_CLOUD_NAME');
      requireEnv('CLOUDINARY_API_KEY');
      requireEnv('CLOUDINARY_API_SECRET');
    }
    const packageKey = requireEnv('PACKAGE_CREDENTIAL_ENCRYPTION_KEY');
    if (packageKey.length < 32 || packageKey.startsWith('replace-with-')) {
      throw new Error('PACKAGE_CREDENTIAL_ENCRYPTION_KEY must be an independent production secret with at least 32 characters');
    }
    for (const name of ['BOOTH_ACCESS_SECRET', 'BOOTH_SESSION_SECRET']) {
      const value = requireEnv(name);
      if (value.length < 32 || value.startsWith('replace-with-')) {
        throw new Error(`${name} must be an independent production secret with at least 32 characters`);
      }
    }
    requireEnv('PAYSTACK_SECRET_KEY');
    // Optional: falls back to JWT_SECRET (already required above to be a
    // strong, independent production secret) so a dedicated key is not
    // mandatory. Set it explicitly only if package credentials should be
    // encrypted with a key independent of JWT_SECRET.
    const packageCredentialKey = process.env.PACKAGE_CREDENTIAL_ENCRYPTION_KEY;
    if (packageCredentialKey && packageCredentialKey.length < 32) {
      throw new Error('PACKAGE_CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters');
    }
    requireEnv('GOOGLE_WEB_CLIENT_ID');
  }
}

export function apiDocsEnabled() {
  return !isProduction() || process.env.ENABLE_API_DOCS === 'true';
}
