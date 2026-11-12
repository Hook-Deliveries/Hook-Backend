import { createHash } from 'node:crypto';
import { HttpError } from '@utils/http';

export interface PricingDecisionInput {
  sellingPriceMinor: number;
  minimumNegotiablePriceMinor: number;
  maximumDiscountMinor: number;
  customerOfferMinor: number;
  offerNumber: number;
  maximumOffers: number;
  currency: string;
  previousCustomerOfferMinor?: number;
  previousCounterPriceMinor?: number;
  /** Makes the counter vary from one negotiation to the next while staying repeatable inside one (e.g. the session id). */
  variationSeed?: string;
}

export interface PricingDecision {
  decision: 'ACCEPT' | 'COUNTER' | 'DECLINE';
  acceptedPriceMinor?: number;
  counterPriceMinor?: number;
  reasonCode: string;
  remainingOffers: number;
}

/** Counters are rounded up to whole ₦100 so they read like prices a seller would actually say. */
const COUNTER_STEP_MINOR = 10_000;
/** How much of the room above the lowest price a counter may keep back: a small, varying cushion, never a fixed amount. */
const CUSHION_MIN = 0.06;
const CUSHION_SPAN = 0.14;

/** A repeatable number in [0, 1) from the inputs, so the same offer in the same negotiation always gets the same answer. */
function variation(parts: Array<string | number | undefined>) {
  const digest = createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export class PricingEngine {
  /**
   * Hook's counter when an offer is short of this round's price. It is never a flat refusal and never the exact
   * lowest price Hook accepts:
   *  - it starts from this round's allowed price (`threshold`, which already sits at or above the lowest price);
   *  - it keeps back a small cushion that varies with the negotiation and the offer, and shrinks as the offer gets
   *    closer, so a near offer gets a near price and a low offer a firmer one;
   *  - it never rises above the previous counter, never drops below this round's price, and never exceeds the list price.
   */
  private counterPrice(input: PricingDecisionInput, floor: number, threshold: number) {
    const ask = Math.min(input.previousCounterPriceMinor || input.sellingPriceMinor, input.sellingPriceMinor);
    const base = Math.min(threshold, ask);
    const room = input.sellingPriceMinor - floor;
    const closeness = room > 0 ? Math.min(1, Math.max(0.2, (threshold - input.customerOfferMinor) / (room * 0.25))) : 1;
    const cushion = CUSHION_MIN + CUSHION_SPAN * variation([input.variationSeed, input.sellingPriceMinor, floor, input.offerNumber, input.customerOfferMinor]);
    // On a late round the gap to the previous counter can be tiny, so the cushion is sized from the room as well.
    const reference = Math.max(ask - base, room * 0.12);
    const wanted = Math.ceil((base + reference * cushion * closeness) / COUNTER_STEP_MINOR) * COUNTER_STEP_MINOR;
    return Math.max(base, Math.min(wanted, ask, input.sellingPriceMinor));
  }

  decide(input: PricingDecisionInput): PricingDecision {
    const values = [
      input.sellingPriceMinor,
      input.minimumNegotiablePriceMinor,
      input.maximumDiscountMinor,
      input.customerOfferMinor,
      input.offerNumber,
      input.maximumOffers,
    ];
    if (!values.every(Number.isSafeInteger) || values.some((value) => value < 0)) {
      throw new HttpError(400, 'Negotiation prices must use positive integer minor units', undefined, 'PRICING_BOUNDARY_VIOLATION');
    }
    if (input.currency !== 'NGN') {
      throw new HttpError(400, 'This product cannot be negotiated in the requested currency', undefined, 'PRICING_BOUNDARY_VIOLATION');
    }
    if (input.maximumOffers < 1 || input.maximumOffers > 10 || input.offerNumber < 1 || input.offerNumber > input.maximumOffers) {
      throw new HttpError(409, 'Negotiation offer limit reached', undefined, 'NEGOTIATION_OFFER_LIMIT_REACHED');
    }
    const configuredFloor = input.minimumNegotiablePriceMinor;
    const discountFloor = input.sellingPriceMinor - input.maximumDiscountMinor;
    const floor = Math.max(configuredFloor, discountFloor);
    if (floor <= 0 || floor > input.sellingPriceMinor) {
      throw new HttpError(409, 'Product negotiation rules are invalid', undefined, 'PRICING_BOUNDARY_VIOLATION');
    }
    const allowedRange = input.sellingPriceMinor - floor;
    const threshold = input.sellingPriceMinor - Math.floor((allowedRange * input.offerNumber) / input.maximumOffers);
    const remainingOffers = input.maximumOffers - input.offerNumber;
    // An offer that already meets this round's price is accepted, even when it repeats the last one.
    if (input.customerOfferMinor >= threshold) {
      return {
        decision: 'ACCEPT',
        acceptedPriceMinor: Math.min(input.customerOfferMinor, input.sellingPriceMinor),
        reasonCode: 'OFFER_WITHIN_ROUND_BOUNDARY',
        remainingOffers,
      };
    }
    const customerDidNotImprove = Boolean(
      input.previousCustomerOfferMinor
      && input.customerOfferMinor <= input.previousCustomerOfferMinor,
    );
    // A repeated or lower offer does not move Hook's price.
    if (customerDidNotImprove && input.previousCounterPriceMinor) {
      return {
        decision: 'COUNTER',
        counterPriceMinor: input.previousCounterPriceMinor,
        reasonCode: 'CUSTOMER_OFFER_DID_NOT_IMPROVE',
        remainingOffers,
      };
    }
    // Even the last offer gets Hook's best price rather than a refusal; the negotiation then closes at that price.
    return {
      decision: 'COUNTER',
      counterPriceMinor: this.counterPrice(input, floor, threshold),
      reasonCode: input.offerNumber === input.maximumOffers ? 'FINAL_COUNTER' : 'COUNTER_AT_ROUND_BOUNDARY',
      remainingOffers,
    };
  }
}
