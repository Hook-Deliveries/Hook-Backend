import Redis, { type RedisOptions } from 'ioredis';

/**
 * Redis is an accelerator and coordinator, never a source of truth. Every
 * caller must treat a missing or failing client as "fall back to MongoDB":
 * getRedis() returns undefined when REDIS_URL is unset, and command failures
 * are timeouts rather than hangs (no offline queue, short command timeout).
 *
 * REDIS_URL is a secret. It is only ever read from the environment and is
 * never logged; use redactRedisUrl() for anything that prints it.
 */

let cacheClient: Redis | undefined;
let warnedUnreachable = false;

export function redisConfigured() {
  return Boolean(process.env.REDIS_URL?.trim());
}

export function redactRedisUrl(url = process.env.REDIS_URL || '') {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return '[invalid REDIS_URL]';
  }
}

function baseOptions(): RedisOptions {
  const url = process.env.REDIS_URL || '';
  const tls = url.startsWith('rediss://');
  return {
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5_000),
    keyPrefix: undefined, // prefixing is done in redisKey() so BullMQ keeps its own namespace
    ...(tls
      ? { tls: { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' } }
      : {}),
  };
}

export function isPrivateHost(host: string) {
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Validates configuration at boot. In production a plaintext redis:// URL to a
 * remote host is refused: the URL carries the password and the traffic would
 * cross the network unencrypted.
 */
export function assertRedisConfig(options: { required: boolean }) {
  if (!redisConfigured()) {
    if (options.required) throw new Error('REDIS_URL is required for this process');
    if (process.env.NODE_ENV === 'production') {
      console.warn('[redis] REDIS_URL is not set: caching, shared rate limits and queues are disabled');
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(process.env.REDIS_URL as string);
  } catch {
    throw new Error('REDIS_URL is not a valid URL');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL must start with redis:// or rediss://');
  if (process.env.NODE_ENV === 'production' && parsed.protocol === 'redis:' && !isPrivateHost(parsed.hostname)) {
    throw new Error('REDIS_URL must use rediss:// (TLS) for a remote Redis in production');
  }
}

function ensureClient(): Redis | undefined {
  if (!redisConfigured()) return undefined;
  if (cacheClient) return cacheClient;
  cacheClient = new Redis(process.env.REDIS_URL as string, {
    ...baseOptions(),
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 500),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Back off to 30s so an unreachable Redis is retried quietly, not hammered.
    retryStrategy: (attempt) => Math.min(attempt * 500, 30_000),
  });
  cacheClient.on('error', (error) => {
    if (warnedUnreachable) return;
    warnedUnreachable = true;
    console.warn(`[redis] ${redactRedisUrl()} unavailable (${error.message}); using MongoDB/in-memory and retrying in the background`);
  });
  cacheClient.on('ready', () => {
    warnedUnreachable = false;
  });
  return cacheClient;
}

/**
 * Shared client for cache, rate limiting and leases. Returns undefined unless
 * the connection is READY, so while Redis is connecting or down every caller
 * takes its MongoDB / in-memory path immediately instead of waiting out a
 * command timeout on each request.
 */
export function getRedis(): Redis | undefined {
  const client = ensureClient();
  return client && client.status === 'ready' ? client : undefined;
}

/** Waits (bounded) for the first connection so the first requests are not cold. */
export async function warmRedis(timeoutMs = 3_000): Promise<boolean> {
  const client = ensureClient();
  if (!client) return false;
  if (client.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.once('ready', () => { clearTimeout(timer); resolve(true); });
  });
}

/** BullMQ needs its own connections with unlimited retries per request. */
export function createBullConnection(): Redis {
  if (!redisConfigured()) throw new Error('REDIS_URL is required for queues');
  return new Redis(process.env.REDIS_URL as string, {
    ...baseOptions(),
    maxRetriesPerRequest: null,
  });
}

export function redisKey(...parts: string[]) {
  return `${process.env.REDIS_KEY_PREFIX || 'hook:'}${parts.join(':')}`;
}

export async function redisHealth(): Promise<{ configured: boolean; ok: boolean; latencyMs?: number }> {
  if (!redisConfigured()) return { configured: false, ok: false };
  const client = getRedis();
  if (!client) return { configured: true, ok: false };
  const started = Date.now();
  try {
    await client.ping();
    return { configured: true, ok: true, latencyMs: Date.now() - started };
  } catch {
    return { configured: true, ok: false };
  }
}

export type RedisStatus = { state: 'connected' | 'unreachable' | 'not_configured'; target?: string; latencyMs?: number };

/**
 * Connects (bounded) and reports, for the startup banner: connected with
 * latency, unreachable (the API still starts and uses MongoDB), or not configured.
 */
export async function connectRedis(timeoutMs = 4_000): Promise<RedisStatus> {
  if (!redisConfigured()) return { state: 'not_configured' };
  const target = redactRedisUrl();
  if (!(await warmRedis(timeoutMs))) return { state: 'unreachable', target };
  const health = await redisHealth();
  return health.ok ? { state: 'connected', target, latencyMs: health.latencyMs } : { state: 'unreachable', target };
}

export function describeRedis(status: RedisStatus) {
  if (status.state === 'connected') return `Redis · ${status.target} (${status.latencyMs}ms)`;
  if (status.state === 'unreachable') return `Redis · UNREACHABLE ${status.target} (using MongoDB only)`;
  return 'Redis · not configured (using MongoDB only)';
}

export async function closeRedis() {
  const client = cacheClient;
  cacheClient = undefined;
  if (client) await client.quit().catch(() => client.disconnect());
}
