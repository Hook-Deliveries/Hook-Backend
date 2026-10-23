import { randomUUID } from "crypto";
import type { ClientSession } from "mongoose";
import {
  CommerceOutboxEvent,
  type OutboxEventType,
} from "@models/commerce/commerce.model";
import { DeadLetterEvent } from "@models/platform/dead-letter-event.model";
import { nextPublicId } from "@services/public-id.service";
import { isDuplicateKeyError } from "@utils/http";

export const OUTBOX_MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const DISPATCH_RETRY_MS = 60_000;

export type OutboxDraft = {
  aggregateType: "order" | "payment" | "refund";
  aggregateId: string;
  eventType: OutboxEventType;
  eventVersion?: number;
  /** IDs and small facts only. Consumers re-read state from MongoDB. */
  payload: Record<string, unknown>;
};

export type OutboxHandler = (event: any) => Promise<unknown>;

/**
 * Writes events to the outbox. Called inside the business transaction so the
 * state change and its follow-up work commit or roll back together. The unique
 * {aggregateId, eventType, eventVersion} index makes a replayed transaction a
 * no-op rather than a duplicate.
 */
export async function emitOutbox(drafts: OutboxDraft[], session?: ClientSession) {
  for (const draft of drafts) {
    const doc = {
      publicId: await nextPublicId("event"),
      aggregateType: draft.aggregateType,
      aggregateId: draft.aggregateId,
      eventType: draft.eventType,
      eventVersion: draft.eventVersion ?? 1,
      payload: draft.payload,
      status: "pending" as const,
      attempts: 0,
      availableAt: new Date(),
    };
    try {
      // A duplicate-key error inside a transaction aborts it, so probe first
      // and only rely on the index as the race-safe backstop.
      const exists = await CommerceOutboxEvent.exists({
        aggregateId: doc.aggregateId,
        eventType: doc.eventType,
        eventVersion: doc.eventVersion,
      }).session(session ?? null);
      if (exists) continue;
      await CommerceOutboxEvent.create([doc], { session });
    } catch (error) {
      if (!isDuplicateKeyError(error) || session) throw error;
    }
  }
}

export function outboxBackoffMs(attempts: number) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
  // Full jitter so a burst of failures does not retry in lockstep.
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** Strips anything that could carry card or customer data before it is stored. */
export function sanitizeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Outbox processing failed");
  return raw
    .replace(/\b\d{12,19}\b/g, "[number]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

/**
 * Claims and processes due events. Safe to run from several workers at once:
 * the claim is an atomic findOneAndUpdate with a lease, and every consumer is
 * idempotent, so a lease that expires mid-run only causes a harmless replay.
 */
export async function processOutbox(handlers: Partial<Record<OutboxEventType, OutboxHandler>>, limit = 5) {
  const types = Object.keys(handlers);
  const results: unknown[] = [];
  if (!types.length) return results;
  for (let index = 0; index < limit; index += 1) {
    const run = await claimAndRun({ eventType: { $in: types } }, handlers);
    if (!run.claimed) break;
    if (run.ok) results.push(run.result);
  }
  return results;
}

export async function processOutboxEvent(publicId: string, handlers: Partial<Record<OutboxEventType, OutboxHandler>>) {
  const run = await claimAndRun({ publicId, eventType: { $in: Object.keys(handlers) } }, handlers);
  return run.claimed;
}

async function claimAndRun(match: Record<string, unknown>, handlers: Partial<Record<OutboxEventType, OutboxHandler>>) {
  const lockToken = randomUUID();
  const now = new Date();
  const event = await CommerceOutboxEvent.findOneAndUpdate(
    {
      ...match,
      $or: [
        { status: "pending", availableAt: { $lte: now } },
        { status: "processing", lockedUntil: { $lt: now } },
      ],
    } as any,
    { $set: { status: "processing", lockToken, lockedUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { availableAt: 1, createdAt: 1 }, returnDocument: "after" },
  ).lean({ virtuals: true });
  if (!event) return { claimed: false as const };
  const handler = handlers[(event as any).eventType as OutboxEventType]!;
  try {
    const result = await handler(event);
    await CommerceOutboxEvent.updateOne(
      { _id: (event as any)._id, lockToken },
      { $set: { status: "published", processedAt: new Date() }, $unset: { lockedUntil: 1, lockToken: 1, lastError: 1 } },
    );
    return { claimed: true as const, ok: true as const, result };
  } catch (error) {
    await failOutboxEvent(event as any, lockToken, error);
    return { claimed: true as const, ok: false as const };
  }
}

export async function dispatchDueOutbox(
  publish: (event: { publicId: string; eventType: string }) => Promise<void>,
  limit = 50,
) {
  let sent = 0;
  while (sent < limit) {
    const now = new Date();
    const event = await CommerceOutboxEvent.findOneAndUpdate(
      {
        $and: [
          {
            $or: [
              { status: "pending", availableAt: { $lte: now } },
              { status: "processing", lockedUntil: { $lt: now } },
            ],
          },
          { $or: [{ dispatchedAt: { $exists: false } }, { dispatchedAt: { $lt: new Date(now.getTime() - DISPATCH_RETRY_MS) } }] },
        ],
      } as any,
      { $set: { dispatchedAt: now } },
      { sort: { availableAt: 1, createdAt: 1 }, returnDocument: "after", projection: { publicId: 1, eventType: 1 } },
    ).lean();
    if (!event) break;
    try {
      await publish({ publicId: (event as any).publicId, eventType: (event as any).eventType });
    } catch (error) {
      await CommerceOutboxEvent.updateOne({ _id: (event as any)._id }, { $unset: { dispatchedAt: 1 } });
      throw error;
    }
    sent += 1;
  }
  return sent;
}

async function failOutboxEvent(event: any, lockToken: string, error: unknown) {
  const attempts = Number(event.attempts || 1);
  const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
  const message = sanitizeError(error);
  const failedAt = new Date();
  const updated = await CommerceOutboxEvent.updateOne(
    { _id: event._id, lockToken },
    {
      $set: {
        status: exhausted ? "dead_letter" : "pending",
        availableAt: new Date(Date.now() + outboxBackoffMs(attempts)),
        lastError: message,
        ...(event.firstFailedAt ? {} : { firstFailedAt: failedAt }),
      },
      $unset: { lockedUntil: 1, lockToken: 1, dispatchedAt: 1 },
    },
  );
  if (!exhausted || !updated.modifiedCount) return;
  await DeadLetterEvent.updateOne(
    { outboxPublicId: event.publicId },
    {
      $set: { attempts, sanitizedError: message, lastFailedAt: failedAt, replayStatus: "pending" },
      $setOnInsert: {
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        firstFailedAt: event.firstFailedAt || failedAt,
      },
    },
    { upsert: true },
  );
  console.error(`[outbox] event ${event.publicId} (${event.eventType}) dead-lettered after ${attempts} attempts`);
}

/** Puts a dead-lettered event back in the queue. Idempotent per replay request. */
export async function replayDeadLetter(deadLetterId: string, actorId: string) {
  const dead = await DeadLetterEvent.findOne({ _id: deadLetterId }).lean();
  if (!dead) return undefined;
  const reset = await CommerceOutboxEvent.updateOne(
    { publicId: dead.outboxPublicId, status: "dead_letter" },
    { $set: { status: "pending", attempts: 0, availableAt: new Date() }, $unset: { lockedUntil: 1, lockToken: 1, lastError: 1, firstFailedAt: 1 } },
  );
  if (!reset.modifiedCount) return { replayed: false };
  await DeadLetterEvent.updateOne(
    { _id: dead._id },
    { $set: { replayStatus: "replayed", replayedBy: actorId, replayedAt: new Date() }, $inc: { replayCount: 1 } },
  );
  return { replayed: true };
}
