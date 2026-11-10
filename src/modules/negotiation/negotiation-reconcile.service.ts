import { randomUUID } from 'crypto';
import { NegotiatedQuoteStatus, NegotiationStatus } from '@lib/constants';
import { NegotiatedQuote } from '@models/catalog/catalog.model';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { createCommerceNotification } from '@modules/notifications';
import { publishRealtime } from '@modules/platform';
import { Product } from '@models/products/product.model';
import {
  loadLiveRules,
  resolveQuote,
  type LiveRules,
  type QuoteResolution,
  type QuoteVoidReason,
} from '@modules/negotiation/negotiation-live-rules.service';

/**
 * Keeps negotiations honest when an admin changes a product. The live-rules guard in cart, checkout and the
 * negotiation itself is the source of truth and never depends on this module running; this module makes the
 * change visible straight away (customer told, cart refreshed) and cleans up so nothing lingers.
 */

type QuoteRef = { _id: unknown; publicId?: string; customerId: string; negotiationId?: string };

const COPY: Record<QuoteVoidReason, string> = {
  PRODUCT_UNAVAILABLE: 'is no longer available, so your negotiated price has been cancelled.',
  NEGOTIATION_DISABLED: 'is no longer open for negotiation, so your negotiated price has been cancelled.',
  FLOOR_RAISED: 'changed price, so your negotiated price is no longer valid. You can negotiate again.',
};

/** Cancels a still-active quote because the product changed. Returns false when it was not active (already used/expired). */
export async function voidQuote(quote: QuoteRef, reason: QuoteVoidReason): Promise<boolean> {
  const result = await NegotiatedQuote.updateOne(
    { _id: quote._id, status: NegotiatedQuoteStatus.ACTIVE },
    { $set: { status: NegotiatedQuoteStatus.CANCELLED, voidedAt: new Date(), voidReason: reason }, $inc: { version: 1 } },
  );
  if (!result.modifiedCount) return false;
  const session = quote.negotiationId
    ? await Negotiation.findById(quote.negotiationId).select('publicId productId').lean().catch(() => null)
    : null;
  const product = session?.productId ? await Product.findById(session.productId).select('title').lean().catch(() => null) : null;
  const title = (product as { title?: string } | null)?.title || 'Your product';
  await createCommerceNotification({
    eventKey: `negotiation-quote:${quote.publicId || String(quote._id)}:voided`,
    userId: quote.customerId,
    title: 'Your negotiated price changed',
    body: `${title} ${COPY[reason]}`,
    type: 'negotiation_quote_voided',
    data: { quoteId: quote.publicId, negotiationId: session?.publicId, reason },
  }).catch(() => undefined);
  publishRealtime({ type: 'negotiation.updated', entityId: session?.publicId || String(quote._id) }, { accountId: quote.customerId });
  publishRealtime({ type: 'cart.updated', entityId: String(quote._id), version: 1 }, { accountId: quote.customerId });
  return true;
}

/** Closes a live session whose product can no longer be negotiated and tells the customer. */
export async function closeSessionForProduct(
  session: { _id: unknown; publicId?: string; customerId?: string; transcript?: unknown[] },
  reason: 'PRODUCT_UNAVAILABLE' | 'NEGOTIATION_DISABLED',
): Promise<boolean> {
  const result = await Negotiation.updateOne(
    { _id: session._id, status: NegotiationStatus.ACTIVE },
    {
      $set: { status: NegotiationStatus.CLOSED, endReason: reason },
      $push: {
        transcript: {
          id: randomUUID(),
          sequence: (session.transcript?.length || 0) + 1,
          kind: 'text',
          role: 'hook',
          message: 'This negotiation has ended because the product is no longer available for negotiation.',
          createdAt: new Date(),
        },
      },
      $inc: { version: 1 },
    },
  );
  if (result.modifiedCount && session.customerId) {
    publishRealtime({ type: 'negotiation.updated', entityId: session.publicId }, { accountId: session.customerId });
  }
  return Boolean(result.modifiedCount);
}

/** Resolves a quote against today's rules and cancels it if it can no longer stand. */
export async function reconcileQuote(
  quote: QuoteRef & { productId: string; variantId?: string; agreedPriceMinor: number; status?: string },
  live?: LiveRules,
): Promise<QuoteResolution> {
  const rules = live || (await loadLiveRules(quote.productId, quote.variantId));
  const resolution = resolveQuote(Number(quote.agreedPriceMinor), rules);
  if (!resolution.valid && quote.status === NegotiatedQuoteStatus.ACTIVE) await voidQuote(quote, resolution.reason);
  return resolution;
}

/**
 * Re-checks every live negotiation and active quote for one product. Called after an admin changes it.
 * Safe to run any number of times, and safe to run concurrently with customers: the guards re-check anyway.
 */
export async function reconcileProduct(productId: string): Promise<{ quotesVoided: number; sessionsClosed: number }> {
  const [quotes, sessions] = await Promise.all([
    NegotiatedQuote.find({ productId, status: NegotiatedQuoteStatus.ACTIVE, expiresAt: { $gt: new Date() } }).lean(),
    Negotiation.find({ productId, status: NegotiationStatus.ACTIVE }).select('_id publicId customerId variantId transcript').lean(),
  ]);
  if (!quotes.length && !sessions.length) return { quotesVoided: 0, sessionsClosed: 0 };
  const live = await loadLiveRules(productId);
  let quotesVoided = 0;
  let sessionsClosed = 0;
  for (const quote of quotes) {
    const resolution = resolveQuote(Number(quote.agreedPriceMinor), live);
    if (!resolution.valid && (await voidQuote(quote as never, resolution.reason))) quotesVoided += 1;
  }
  if (!live.onSale || !live.enabled) {
    for (const session of sessions) {
      if (await closeSessionForProduct(session as never, live.onSale ? 'NEGOTIATION_DISABLED' : 'PRODUCT_UNAVAILABLE')) sessionsClosed += 1;
    }
  }
  return { quotesVoided, sessionsClosed };
}

/** Fire-and-forget hook for admin write paths: never blocks or fails the admin's own change. */
export function reconcileProductInBackground(productId: string | undefined | null) {
  if (!productId) return;
  setImmediate(() => {
    void reconcileProduct(String(productId)).catch((error) => {
      console.error('[negotiation] reconcile after product change failed', productId, error);
    });
  });
}

/** Safety net for the scheduled job: covers changes made by scripts or paths that do not call the hook. */
export async function sweepNegotiationDrift(limit = 300): Promise<{ products: number; quotesVoided: number; sessionsClosed: number }> {
  const now = new Date();
  const [quoteProducts, sessionProducts] = await Promise.all([
    NegotiatedQuote.distinct('productId', { status: NegotiatedQuoteStatus.ACTIVE, expiresAt: { $gt: now } }),
    Negotiation.distinct('productId', { status: NegotiationStatus.ACTIVE }),
  ]);
  const productIds = [...new Set([...quoteProducts, ...sessionProducts])].slice(0, limit);
  let quotesVoided = 0;
  let sessionsClosed = 0;
  for (const productId of productIds) {
    const result = await reconcileProduct(String(productId));
    quotesVoided += result.quotesVoided;
    sessionsClosed += result.sessionsClosed;
  }
  return { products: productIds.length, quotesVoided, sessionsClosed };
}
