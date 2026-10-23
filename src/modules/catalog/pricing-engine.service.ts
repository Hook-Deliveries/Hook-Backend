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
}

export interface PricingDecision {
  decision: 'ACCEPT' | 'COUNTER' | 'DECLINE';
  acceptedPriceMinor?: number;
  counterPriceMinor?: number;
  reasonCode: string;
  remainingOffers: number;
}

export class PricingEngine {
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
    const customerDidNotImprove = Boolean(
      input.previousCustomerOfferMinor
      && input.customerOfferMinor <= input.previousCustomerOfferMinor,
    );
    if (customerDidNotImprove) {
      if (input.offerNumber === input.maximumOffers) {
        return {
          decision: 'DECLINE',
          reasonCode: 'FINAL_OFFER_DID_NOT_IMPROVE',
          remainingOffers: 0,
        };
      }
      return {
        decision: 'COUNTER',
        counterPriceMinor: input.previousCounterPriceMinor || threshold,
        reasonCode: 'CUSTOMER_OFFER_DID_NOT_IMPROVE',
        remainingOffers,
      };
    }
    if (input.customerOfferMinor >= threshold) {
      return {
        decision: 'ACCEPT',
        acceptedPriceMinor: Math.min(input.customerOfferMinor, input.sellingPriceMinor),
        reasonCode: 'OFFER_WITHIN_ROUND_BOUNDARY',
        remainingOffers,
      };
    }
    if (input.offerNumber === input.maximumOffers) {
      return { decision: 'DECLINE', reasonCode: 'FINAL_OFFER_BELOW_BOUNDARY', remainingOffers: 0 };
    }
    return {
      decision: 'COUNTER',
      counterPriceMinor: threshold,
      reasonCode: 'COUNTER_AT_ROUND_BOUNDARY',
      remainingOffers,
    };
  }
}
