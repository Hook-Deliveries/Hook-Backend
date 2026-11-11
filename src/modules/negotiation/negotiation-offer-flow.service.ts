import { NegotiationStatus } from '@lib/constants';
import {
  defaultPicks,
  midpointOffer,
  MIN_OFFER_SHARE,
  percentOff,
  suggestionCandidates,
  unitFromTotal,
  validateOffer,
  type Suggestion,
} from '@lib/negotiation-offer-rules';
import { Negotiation } from '@models/negotiations/negotiation.model';
import { Product } from '@models/products/product.model';
import { AzureNegotiationService } from '@modules/negotiation/azure-negotiation.service';
import { NegotiationCommandService } from '@modules/negotiation/negotiation-command.service';
import { clampToLive, loadLiveRules } from '@modules/negotiation/negotiation-live-rules.service';
import { closeSessionForProduct } from '@modules/negotiation/negotiation-reconcile.service';
import { NegotiationService, type NegotiationIdentity } from '@modules/negotiation/negotiation.service';
import { HttpError } from '@utils/http';

/**
 * The guided "make an offer" flow. Everything the screen needs comes from one payload (`OfferFlow`), and every
 * amount is shown as a TOTAL for the whole quantity with the per-item price beside it, so "50k" is never ambiguous.
 * The pricing engine still decides every answer; the AI only picks which suggested prices to show and words notes.
 */

export interface OfferFlow {
  negotiationId: string;
  status: string;
  endReason?: string;
  productId?: string;
  variantId?: string;
  quantity: number;
  currency: string;
  listUnitMinor: number;
  listTotalMinor: number;
  /** The round the next offer will be (1-based). */
  round: number;
  remainingOffers: number;
  maximumOffers: number;
  expiresAt?: string;
  /** Hook's best price so far: its latest counter, or the price it accepted, whichever is lower. */
  counter?: { unitMinor: number; totalMinor: number; percentOff: number };
  /**
   * Hook has accepted a price but it is NOT locked, because offers remain. The customer chooses: lock it, or try for
   * less. A price is only locked automatically when the last offer is used.
   */
  priceAccepted: boolean;
  /** This is the customer's final offer. */
  lastRound: boolean;
  /** Halfway between the customer's best offer and Hook's price, when the gap is wide enough to be worth a step. */
  midpoint?: Suggestion;
  /** The customer's best offer so far. Omitted once Hook has accepted a price, since going lower is then the point. */
  bestOffer?: { unitMinor: number; totalMinor: number };
  locked?: { quoteId: string; unitMinor: number; totalMinor: number; savingsTotalMinor: number; percentOff: number; expiresAt: string };
  /** The locked price was cancelled because the product changed. */
  quoteCancelled?: { reason?: string };
  /** Offers must be at least this much (a sanity limit, not a pricing rule). */
  minTotalMinor: number;
  /** Offers must be below this: Hook's last counter, or the list price. */
  maxTotalMinor: number;
  suggestions: Array<Suggestion & { note?: string }>;
  history: Array<{ round: number; offerTotalMinor: number; decision?: string; counterTotalMinor?: number; acceptedTotalMinor?: number }>;
}

const naira = (minor: number) => `₦${Math.round(minor / 100).toLocaleString('en-NG')}`;

// The picks are the same for a given session state, so repeated screen refreshes never call the model again.
const pickCache = new Map<string, { at: number; picks: Array<Suggestion & { note?: string }> }>();
const PICK_TTL_MS = 15 * 60_000;

/** Forgets cached suggestion picks. Only tests need this. */
export function clearOfferFlowCache() {
  pickCache.clear();
}

export class NegotiationOfferFlowService {
  private readonly negotiations = new NegotiationService();
  private readonly ai = new AzureNegotiationService();

  /** Chooses three of the candidates (AI first, evenly spread if the AI is unavailable or returns something unusable). */
  private async pick(cacheKey: string, candidates: Suggestion[], context: { title: string; description?: string; quantity: number; round: number }) {
    if (candidates.length <= 3) return candidates;
    const cached = pickCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PICK_TTL_MS) return cached.picks;
    let picks: Array<Suggestion & { note?: string }>;
    try {
      const chosen = await this.ai.suggestOffers({
        productTitle: context.title,
        productDescription: context.description,
        quantity: context.quantity,
        round: context.round,
        candidates: candidates.map((candidate, index) => ({ index, percentOff: candidate.percentOff })),
      });
      picks = chosen.map((entry) => ({ ...candidates[entry.index], ...(entry.note ? { note: entry.note } : {}) }));
    } catch {
      picks = defaultPicks(candidates);
    }
    if (pickCache.size > 500) pickCache.clear();
    pickCache.set(cacheKey, { at: Date.now(), picks });
    return picks;
  }

  async flow(identity: NegotiationIdentity, id: string): Promise<OfferFlow> {
    // detail() also expires a timed-out session and resolves the locked price against today's product rules.
    const base: any = await this.negotiations.detail(identity, id);
    const session = await Negotiation.findOne({ publicId: base.negotiationId, customerId: identity.customerId })
      .select('productId variantId transcript lastCounterPriceMinor agreedPriceMinor')
      .lean();
    if (!session) throw new HttpError(404, 'Negotiation not found', undefined, 'NOT_FOUND');

    const quantity = Math.max(1, Number(base.quantity || 1));
    const live = await loadLiveRules(session.productId, session.variantId);
    let status: string = base.status;
    let endReason: string | undefined = base.endReason;
    if (status === NegotiationStatus.ACTIVE && (!live.onSale || !live.enabled)) {
      await closeSessionForProduct({ _id: (session as { _id: unknown })._id, publicId: base.negotiationId, customerId: identity.customerId, transcript: session.transcript }, live.onSale ? 'NEGOTIATION_DISABLED' : 'PRODUCT_UNAVAILABLE');
      status = NegotiationStatus.CLOSED;
      endReason = live.onSale ? 'NEGOTIATION_DISABLED' : 'PRODUCT_UNAVAILABLE';
    }

    const listUnitMinor = live.effectivePriceMinor || Number(base.product?.effectivePriceMinor || 0);
    const active = status === NegotiationStatus.ACTIVE;
    const customerOffers = (session.transcript || []).filter((entry: any) => entry.role === 'customer' && entry.offeredPriceMinor);
    const previousBestUnit = customerOffers.reduce((best: number, entry: any) => Math.max(best, Number(entry.offeredPriceMinor)), 0);
    const lastCounterUnit = active && session.lastCounterPriceMinor ? clampToLive(Number(session.lastCounterPriceMinor), live) : 0;
    const agreedUnit = active && session.agreedPriceMinor ? clampToLive(Number(session.agreedPriceMinor), live) : 0;
    // Hook's best price so far, and whether it is one Hook has already said yes to.
    const hookUnit = [lastCounterUnit, agreedUnit].filter((value) => value > 0).reduce((low, value) => Math.min(low, value), Infinity);
    const counterUnit = Number.isFinite(hookUnit) ? hookUnit : undefined;
    const priceAccepted = Boolean(agreedUnit && (!lastCounterUnit || agreedUnit <= lastCounterUnit));
    // Once Hook has accepted a price the customer's next move is to try for less, so "higher than your last offer"
    // no longer applies.
    const ruleBestUnit = priceAccepted ? 0 : previousBestUnit;

    const history: OfferFlow['history'] = [];
    (session.transcript || []).forEach((entry: any, index: number, all: any[]) => {
      if (entry.role !== 'customer' || !entry.offeredPriceMinor) return;
      const reply = all.slice(index + 1).find((next: any) => next.role === 'hook' && next.decision);
      history.push({
        round: history.length + 1,
        offerTotalMinor: Number(entry.offeredPriceMinor) * quantity,
        decision: reply?.decision,
        ...(reply?.counterPriceMinor ? { counterTotalMinor: Number(reply.counterPriceMinor) * quantity } : {}),
        ...(reply?.acceptedPriceMinor ? { acceptedTotalMinor: Number(reply.acceptedPriceMinor) * quantity } : {}),
      });
    });

    const quote = base.quote as { id: string; agreedPriceMinor: number; expiresAt: string; status: string; voidReason?: string } | undefined;
    const lockedUnit = quote?.status === 'active' ? Number(quote.agreedPriceMinor) : 0;
    const remainingOffers = Math.max(0, Number(base.remainingOffers || 0));
    const round = Number(base.offerCount || 0) + 1;

    let suggestions: OfferFlow['suggestions'] = [];
    if (active && remainingOffers > 0) {
      const candidates = suggestionCandidates({
        listUnitMinor,
        floorUnitMinor: live.floorMinor,
        quantity,
        counterUnitMinor: counterUnit,
        previousBestUnitMinor: ruleBestUnit,
      });
      const product = await Product.findById(session.productId).select('title description').lean();
      suggestions = await this.pick(`${base.negotiationId}:${base.version}:${counterUnit || 0}`, candidates, {
        title: (product as { title?: string } | null)?.title || base.product?.title || 'this product',
        description: (product as { description?: string } | null)?.description,
        quantity,
        round,
      });
    }

    const ceilingUnit = counterUnit && counterUnit < listUnitMinor ? counterUnit : listUnitMinor;
    return {
      negotiationId: base.negotiationId,
      status,
      ...(endReason ? { endReason } : {}),
      productId: base.product?.id,
      variantId: base.variantId,
      quantity,
      currency: base.product?.currency || 'NGN',
      listUnitMinor,
      listTotalMinor: listUnitMinor * quantity,
      round,
      remainingOffers: active ? remainingOffers : 0,
      maximumOffers: Number(base.maximumOffers || 0),
      expiresAt: base.expiresAt,
      ...(counterUnit ? { counter: { unitMinor: counterUnit, totalMinor: counterUnit * quantity, percentOff: percentOff(counterUnit, listUnitMinor) } } : {}),
      priceAccepted: active && priceAccepted,
      lastRound: active && remainingOffers === 1,
      ...(active && counterUnit && !priceAccepted && remainingOffers > 0
        ? (() => {
            const middle = midpointOffer({ previousBestUnitMinor: previousBestUnit, hookUnitMinor: counterUnit, listUnitMinor, quantity });
            return middle ? { midpoint: middle } : {};
          })()
        : {}),
      ...(ruleBestUnit ? { bestOffer: { unitMinor: ruleBestUnit, totalMinor: ruleBestUnit * quantity } } : {}),
      ...(lockedUnit && quote
        ? {
            locked: {
              quoteId: quote.id,
              unitMinor: lockedUnit,
              totalMinor: lockedUnit * quantity,
              savingsTotalMinor: Math.max(0, (listUnitMinor - lockedUnit) * quantity),
              percentOff: percentOff(lockedUnit, listUnitMinor),
              expiresAt: quote.expiresAt,
            },
          }
        : {}),
      ...(quote?.status === 'cancelled' ? { quoteCancelled: { reason: quote.voidReason } } : {}),
      minTotalMinor: Math.ceil(listUnitMinor * MIN_OFFER_SHARE) * quantity,
      maxTotalMinor: ceilingUnit * quantity,
      suggestions,
      history,
    };
  }

  /**
   * Submits an offer as a total for the whole quantity. The rules are checked first, so a rejected offer never uses
   * up a round; then the usual idempotent command runs it through the pricing engine.
   */
  async submitTotal(identity: NegotiationIdentity, id: string, totalMinor: number, key: string) {
    const before = await this.flow(identity, id);
    if (before.status !== NegotiationStatus.ACTIVE) {
      throw new HttpError(409, 'This negotiation is no longer active', undefined, 'INVALID_STATE_TRANSITION');
    }
    if (before.remainingOffers <= 0) {
      throw new HttpError(409, 'You have used every offer in this negotiation', undefined, 'OFFER_LIMIT_REACHED');
    }
    const unitMinor = unitFromTotal(totalMinor, before.quantity);
    const rejection = validateOffer({
      unitMinor,
      listUnitMinor: before.listUnitMinor,
      quantity: before.quantity,
      counterUnitMinor: before.counter?.unitMinor,
      previousBestUnitMinor: before.bestOffer?.unitMinor,
    });
    if (rejection) throw new HttpError(409, rejection.message, { minTotalMinor: before.minTotalMinor, maxTotalMinor: before.maxTotalMinor }, rejection.code);

    const items = before.quantity > 1 ? ` for ${before.quantity} items` : '';
    const result: any = await new NegotiationCommandService().run(identity, id, key, {
      offeredPriceMinor: unitMinor,
      message: `My offer is ${naira(unitMinor * before.quantity)}${items}`,
    });
    // Nothing is locked here. An accepted price waits for the customer while offers remain (they can lock it, or try for
    // less); the offer service itself locks the best price when the last offer is used.
    const flow = await this.flow(identity, id);
    return {
      result: {
        decision: result.decision as 'ACCEPT' | 'COUNTER' | 'DECLINE' | undefined,
        message: result.message as string | undefined,
        offerTotalMinor: unitMinor * before.quantity,
        counterTotalMinor: result.counterPriceMinor ? Number(result.counterPriceMinor) * before.quantity : undefined,
        acceptedTotalMinor: result.acceptedPriceMinor ? Number(result.acceptedPriceMinor) * before.quantity : undefined,
        providerFallback: Boolean(result.providerFallback),
      },
      flow,
    };
  }
}
