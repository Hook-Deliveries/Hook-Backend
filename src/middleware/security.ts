import { NextFunction, Request, Response } from 'express';
import { HttpError } from '@utils/http';
import { getRedis, redisKey } from '@config/redis';

type RateLimitOptions = {
  /** Count in Redis so every API instance shares the limit. Defaults to true; false counts in-process. */
  shared?: boolean;
  windowMs: number;
  max: number;
  message?: string;
  /** Overrides the default client key (ip + user), e.g. to throttle per target account. */
  key?: (req: Request) => string;
};

type Bucket = { count: number; resetAt: number };
const stores = new Map<string, Map<string, Bucket>>();

function clientKey(req: Request) {
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.user?.sub || 'anonymous'}`;
}

// Expired buckets used to live forever, so memory grew with every distinct client.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const bucket of stores.values()) {
    for (const [key, entry] of bucket) if (entry.resetAt <= now) bucket.delete(key);
  }
}, 60_000);
sweeper.unref();

// Atomic INCR + PEXPIRE: a crash between two separate commands could leave a
// counter with no TTL and lock the client out permanently.
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

function hitMemory(bucket: Map<string, Bucket>, key: string, windowMs: number): Bucket {
  const now = Date.now();
  const entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    bucket.set(key, fresh);
    return fresh;
  }
  entry.count += 1;
  return entry;
}

/**
 * Shared across API instances through Redis. If Redis is unset or failing the
 * limiter degrades to a per-process counter instead of rejecting traffic:
 * a Redis outage must never lock customers out.
 */
async function hit(name: string, bucket: Map<string, Bucket>, key: string, windowMs: number, shared: boolean): Promise<Bucket> {
  const redis = !shared || process.env.RATE_LIMIT_STORE === 'memory' ? undefined : getRedis();
  if (redis) {
    try {
      const [count, ttl] = (await redis.eval(WINDOW_SCRIPT, 1, redisKey('rl', name, key), String(windowMs))) as [number, number];
      return { count: Number(count), resetAt: Date.now() + Math.max(Number(ttl), 0) };
    } catch {
      // fall through to the in-memory counter
    }
  }
  return hitMemory(bucket, key, windowMs);
}

export function rateLimit(name: string, options: RateLimitOptions) {
  const bucket = stores.get(name) || new Map<string, Bucket>();
  stores.set(name, bucket);

  return (req: Request, res: Response, next: NextFunction) => {
    hit(name, bucket, options.key ? options.key(req) : clientKey(req), options.windowMs, options.shared !== false).then((entry) => {
      res.setHeader('X-RateLimit-Limit', String(options.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(options.max - entry.count, 0)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
      if (entry.count > options.max) {
        res.setHeader('Retry-After', String(Math.max(Math.ceil((entry.resetAt - Date.now()) / 1000), 1)));
        return next(new HttpError(429, options.message || 'Too many requests. Please try again later.'));
      }
      return next();
    }).catch(next);
  };
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$') || key.includes('.')) continue;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    safe[key] = sanitizeValue(item);
  }
  return safe;
}

export function sanitizeRequest(req: Request, _res: Response, next: NextFunction) {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) {
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        delete req.query[key];
      } else {
        (req.query as Record<string, unknown>)[key] = sanitizeValue(req.query[key]);
      }
    }
  }
  if (req.params) {
    for (const key of Object.keys(req.params)) {
      if (key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        delete req.params[key];
      }
    }
  }
  next();
}

// The general limiter runs on every request, so it counts in-process: a Redis round trip per request would add
// a network hop to every response. Strict limiters (auth, uploads) stay shared across instances.
export const generalLimiter = rateLimit('general', {
  shared: process.env.GENERAL_RATE_LIMIT_SHARED === 'true',
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 600),
});

export const authLimiter = rateLimit('auth', {
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  message: 'Too many authentication attempts. Please try again later.',
});

export const uploadLimiter = rateLimit('upload', {
  windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || 10 * 60_000),
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX || 40),
  message: 'Too many upload attempts. Please try again later.',
});
