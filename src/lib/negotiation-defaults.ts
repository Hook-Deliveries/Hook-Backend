/**
 * AI negotiation is on by default for every product, derived from pricing the
 * admin already sets — no separate field to fill in. The floor is the
 * product's own minAcceptablePrice (shown as "Negotiation Floor" on every
 * product form) and the ceiling discount is the gap between that floor and
 * the selling price, which matches the same boundary checks
 * commercial-catalog.service.ts enforces when an operator sets these by hand.
 *
 * Returns `undefined` when there isn't enough valid pricing to derive a safe
 * rule (missing price, floor above selling price, or floor below cost) —
 * callers should fall back to negotiation left off rather than write an
 * inconsistent rule.
 */
export function defaultNegotiationRules(pricing: {
  sellingPriceMinor?: number;
  basePriceMinor?: number;
  minAcceptablePriceMinor: number;
}) {
  const sellingMinor = Number(pricing.sellingPriceMinor || 0);
  const floorMinor = Number(pricing.minAcceptablePriceMinor || 0);
  if (!sellingMinor || !floorMinor) return undefined;
  if (floorMinor > sellingMinor) return undefined;
  const baseMinor = Number(pricing.basePriceMinor || 0);
  if (baseMinor && floorMinor < baseMinor) return undefined;

  return {
    enabled: true,
    minimumNegotiablePriceMinor: floorMinor,
    maximumDiscountMinor: sellingMinor - floorMinor,
    maximumCustomerOffers: 3,
    acceptedQuoteExpiryMinutes: 30,
  };
}
