import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { IdempotencyRecord } from '@models/platform/idempotency-record.model';
import { HttpError, isDuplicateKeyError } from '@utils/http';

/** Shared idempotency for retryable mutations, keyed on (actor, operation, Idempotency-Key), with tiers financial/consequential/crud controlling whether a key is required. */
type Tier = 'financial' | 'consequential' | 'crud';

const LEASE_MS = 60_000;
const TTL_MS = 24 * 60 * 60_000;

/** Required keys are enforced by default; IDEMPOTENCY_ENFORCE=false turns it into a warning header for older clients still in the field. */
export function idempotencyEnforced() {
  return process.env.IDEMPOTENCY_ENFORCE !== 'false';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        // The key itself must not change the hash of an otherwise identical body.
        .filter((key) => key !== 'idempotencyKey')
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function hashRequest(req: Request, fingerprint?: (req: Request) => unknown) {
  const material = fingerprint
    ? JSON.stringify(canonical(fingerprint(req)))
    : JSON.stringify({ params: canonical(req.params), query: canonical(req.query), body: canonical(req.body ?? {}) });
  return createHash('sha256').update(material).digest('hex');
}

function actorKey(req: Request) {
  const user = req.user as { sub?: string } | undefined;
  return user?.sub ? `user:${user.sub}` : `anon:${req.ip || 'unknown'}`;
}

function keyFrom(req: Request) {
  const header = req.header('idempotency-key')?.trim();
  const body = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '';
  return header || body || '';
}

export function withIdempotency(options: {
  operation: string;
  tier: Tier;
  /** What "the same request" means when the whole body is too strict (e.g. checkout confirm's fresh single-use preview token). */
  fingerprint?: (req: Request) => unknown;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = keyFrom(req);
      if (!key) {
        if (options.tier !== 'crud') {
          if (idempotencyEnforced()) {
            throw new HttpError(400, 'An Idempotency-Key header is required for this request', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
          }
          res.setHeader('X-Idempotency-Warning', 'Idempotency-Key missing; retries of this request are not protected');
        }
        return next();
      }
      if (key.length < 8 || key.length > 200) {
        throw new HttpError(400, 'Idempotency-Key must be 8-200 characters', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
      }

      const identity = { actorKey: actorKey(req), operation: options.operation, key };
      const requestHash = hashRequest(req, options.fingerprint);
      const now = new Date();
      let record;
      try {
        record = await IdempotencyRecord.create({
          ...identity,
          requestHash,
          state: 'in_progress',
          lockedUntil: new Date(now.getTime() + LEASE_MS),
          expiresAt: new Date(now.getTime() + TTL_MS),
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await IdempotencyRecord.findOne(identity).lean();
        if (!existing) return next(); // expired between the two calls; run normally
        if (existing.requestHash !== requestHash) {
          throw new HttpError(409, 'This Idempotency-Key was already used with a different request', undefined, 'IDEMPOTENCY_CONFLICT');
        }
        if (existing.state === 'completed') {
          res.setHeader('Idempotent-Replayed', 'true');
          return void res.status(existing.statusCode || 200).json(existing.responseBody);
        }
        if (new Date(existing.lockedUntil).getTime() > now.getTime()) {
          res.setHeader('Retry-After', '2');
          throw new HttpError(409, 'This request is already being processed', undefined, 'OPERATION_IN_PROGRESS');
        }
        // The first attempt died without finishing; take over its lease since re-running is safe.
        const reclaimed = await IdempotencyRecord.findOneAndUpdate(
          { ...identity, state: 'in_progress', lockedUntil: { $lt: now } },
          { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } },
          { returnDocument: 'after' },
        );
        if (!reclaimed) {
          res.setHeader('Retry-After', '2');
          throw new HttpError(409, 'This request is already being processed', undefined, 'OPERATION_IN_PROGRESS');
        }
        record = reclaimed;
      }

      const recordId = record._id;
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        // Only successes are remembered; a failed attempt releases the key so the client can fix the request and retry.
        const settle = status >= 300
          ? IdempotencyRecord.deleteOne({ _id: recordId })
          : IdempotencyRecord.updateOne({ _id: recordId }, { $set: { state: 'completed', statusCode: status, responseBody: body } });
        settle.catch((error) => console.error('[idempotency] could not persist response', error));
        return originalJson(body);
      }) as Response['json'];
      // A client that disconnects mid-request must not wedge the key until the lease expires.
      res.on('close', () => {
        if (!res.writableEnded) IdempotencyRecord.updateOne({ _id: recordId, state: 'in_progress' }, { $set: { lockedUntil: new Date() } }).catch(() => undefined);
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
