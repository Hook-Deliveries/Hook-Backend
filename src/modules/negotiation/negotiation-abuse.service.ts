import { NegotiatedQuoteStatus, NegotiationStatus } from '@lib/constants';
import { NegotiatedQuote } from '@models/catalog/catalog.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { HttpError } from '@utils/http';

/**
 * Stops a customer re-rolling negotiations until the price they like comes up. A session only counts against the
 * customer when they actually negotiated (made at least one priced offer) and the session ended on their own terms.
 * Sessions that ended because the product changed (admin edits, going off sale) never count.
 */

export const DEFAULT_COOLDOWN_MINUTES = 30;
export const DEFAULT_MAX_SESSIONS_PER_DAY = 3;
/** Customer chat turns without a price, per session. Each one costs model calls, so it is bounded. */
export const MAX_CHAT_TURNS_PER_SESSION = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CountedAttempt {
  endedAt: Date;
}

export type AttemptVerdict = { blocked: false } | { blocked: true; retryAfterSeconds: number; reason: 'COOLDOWN' | 'DAILY_LIMIT' };

/** Pure: decide whether a customer may start another negotiation on the same product option right now. */
export function evaluateAttempts(
  attempts: CountedAttempt[],
  limits: { cooldownMinutes: number; maxSessionsPerDay: number },
  now = new Date(),
): AttemptVerdict {
  const recent = attempts
    .filter((attempt) => now.getTime() - attempt.endedAt.getTime() < DAY_MS)
    .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
  if (!recent.length) return { blocked: false };

  let retryAt = 0;
  let reason: 'COOLDOWN' | 'DAILY_LIMIT' = 'COOLDOWN';
  const cooldownMs = Math.max(0, limits.cooldownMinutes) * 60_000;
  if (cooldownMs > 0) {
    const cooledAt = recent[recent.length - 1].endedAt.getTime() + cooldownMs;
    if (cooledAt > now.getTime()) retryAt = cooledAt;
  }
  if (recent.length >= limits.maxSessionsPerDay) {
    // The attempt that has to age out of the 24h window for there to be room again.
    const freedAt = recent[recent.length - limits.maxSessionsPerDay].endedAt.getTime() + DAY_MS;
    if (freedAt > retryAt) {
      retryAt = freedAt;
      reason = 'DAILY_LIMIT';
    }
  }
  if (!retryAt) return { blocked: false };
  return { blocked: true, reason, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)) };
}

function waitLabel(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Throws 429 NEGOTIATION_COOLDOWN when this customer has negotiated this product option too often. */
export async function assertMayStartNegotiation(
  customerId: string,
  productId: string,
  variantId: string,
  limits: { cooldownMinutes?: number; maxSessionsPerDay?: number },
  now = new Date(),
) {
  const sessions = await Negotiation.find({
    customerId,
    productId,
    variantId,
    // Partner-assisted sessions are the Partner's work at the counter, not the customer re-rolling.
    initiatingPartnerId: { $exists: false },
    status: { $ne: NegotiationStatus.ACTIVE },
    offerCount: { $gt: 0 },
    endReason: { $exists: false },
    updatedAt: { $gte: new Date(now.getTime() - DAY_MS) },
  }).select('quoteId updatedAt').lean();
  if (!sessions.length) return;

  // A price cancelled because the product changed is not the customer's attempt.
  const quoteIds = sessions.map((session) => session.quoteId).filter((id): id is string => Boolean(id));
  const cancelled = quoteIds.length
    ? new Set((await NegotiatedQuote.find({ _id: { $in: quoteIds }, status: NegotiatedQuoteStatus.CANCELLED, voidReason: { $exists: true } }).select('_id').lean()).map((quote) => String(quote._id)))
    : new Set<string>();
  const counted = sessions
    .filter((session) => !session.quoteId || !cancelled.has(session.quoteId))
    .map((session) => ({ endedAt: new Date((session as { updatedAt?: Date }).updatedAt || now) }));

  const verdict = evaluateAttempts(counted, {
    cooldownMinutes: limits.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
    maxSessionsPerDay: limits.maxSessionsPerDay ?? DEFAULT_MAX_SESSIONS_PER_DAY,
  }, now);
  if (verdict.blocked) {
    throw new HttpError(
      429,
      verdict.reason === 'DAILY_LIMIT'
        ? `You have negotiated this item a lot today. Try again in about ${waitLabel(verdict.retryAfterSeconds)}.`
        : `Give it a little while before negotiating this item again. Try again in about ${waitLabel(verdict.retryAfterSeconds)}.`,
      { retryAfterSeconds: verdict.retryAfterSeconds },
      'NEGOTIATION_COOLDOWN',
    );
  }
}
