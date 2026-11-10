/**
 * Pure rules for the guided "make an offer" flow. All amounts are integer kobo, and offers are made as a TOTAL for
 * the whole quantity (so "50k" can never be misread as per item); the pricing engine works per unit.
 */

/** Unit prices are rounded to whole ₦500 so suggestions read like real prices. */
const ROUNDING_KOBO = 50_000;
/** The deepest suggestion stops this far short of the lowest price Hook accepts, so suggestions never reveal it. */
const SUGGESTION_FRACTIONS = [0.15, 0.3, 0.45, 0.6, 0.75] as const;
/** Offers below this share of the list price are rejected outright as not serious. */
export const MIN_OFFER_SHARE = 0.5;

export interface Suggestion {
  unitMinor: number;
  totalMinor: number;
  percentOff: number;
}

export function unitFromTotal(totalMinor: number, quantity: number) {
  return Math.round(totalMinor / Math.max(1, quantity));
}

export function percentOff(unitMinor: number, listUnitMinor: number) {
  if (listUnitMinor <= 0) return 0;
  return Math.max(0, Math.round(((listUnitMinor - unitMinor) / listUnitMinor) * 1000) / 10);
}

const roundDown = (value: number) => Math.floor(value / ROUNDING_KOBO) * ROUNDING_KOBO;

/**
 * The prices worth suggesting, best deal for the customer first. They sit between the lowest price Hook accepts
 * (`floorUnitMinor`, never shown) and the ceiling (list price, or Hook's last counter once there is one), and never
 * go deeper than 75% of the way down, so the lowest suggestion is always above the floor.
 */
export function suggestionCandidates(input: {
  listUnitMinor: number;
  floorUnitMinor: number;
  quantity: number;
  /** Hook's current counter per unit, if any: the ceiling for the next offer. */
  counterUnitMinor?: number;
  /** The customer's best offer so far per unit: the next offer must beat it. */
  previousBestUnitMinor?: number;
}): Suggestion[] {
  const ceiling = input.counterUnitMinor && input.counterUnitMinor < input.listUnitMinor ? input.counterUnitMinor : input.listUnitMinor;
  const floor = Math.min(input.floorUnitMinor, ceiling);
  const lowestAllowed = Math.max(Math.ceil(input.listUnitMinor * MIN_OFFER_SHARE), (input.previousBestUnitMinor || 0) + 1);
  const range = ceiling - floor;
  if (range <= 0) return [];
  const seen = new Set<number>();
  const out: Suggestion[] = [];
  for (const fraction of SUGGESTION_FRACTIONS) {
    let unit = roundDown(ceiling - range * fraction);
    // Rounding down can land on or above the ceiling for tiny ranges; keep every suggestion a real saving.
    if (unit >= ceiling) unit = ceiling - ROUNDING_KOBO;
    if (unit <= floor || unit < lowestAllowed || seen.has(unit)) continue;
    seen.add(unit);
    out.push({ unitMinor: unit, totalMinor: unit * input.quantity, percentOff: percentOff(unit, input.listUnitMinor) });
  }
  return out.sort((a, b) => b.unitMinor - a.unitMinor);
}

/** Three evenly spread picks from the candidates (shallowest, middle, deepest). Used when the AI is not consulted. */
export function defaultPicks<T>(candidates: T[]): T[] {
  if (candidates.length <= 3) return candidates;
  return [candidates[0], candidates[Math.floor((candidates.length - 1) / 2)], candidates[candidates.length - 1]];
}

export type OfferRejection =
  | { code: 'OFFER_NOT_BELOW_LIST'; message: string }
  | { code: 'OFFER_TOO_LOW'; message: string }
  | { code: 'OFFER_ABOVE_COUNTER'; message: string }
  | { code: 'OFFER_NOT_HIGHER'; message: string };

const naira = (minor: number) => `₦${Math.round(minor / 100).toLocaleString('en-NG')}`;

/**
 * Strict, predictable offer rules checked BEFORE a round is spent:
 * below the list price, a serious amount, below Hook's last counter, and higher than the customer's own last offer.
 */
export function validateOffer(input: {
  unitMinor: number;
  listUnitMinor: number;
  quantity: number;
  counterUnitMinor?: number;
  previousBestUnitMinor?: number;
}): OfferRejection | undefined {
  const total = (unit: number) => naira(unit * input.quantity);
  const forItems = input.quantity > 1 ? ` for ${input.quantity} items` : '';
  if (input.unitMinor >= input.listUnitMinor) {
    return { code: 'OFFER_NOT_BELOW_LIST', message: `That is at or above the list price of ${total(input.listUnitMinor)}${forItems}. Offer less, or add it to your cart as is.` };
  }
  if (input.unitMinor < Math.ceil(input.listUnitMinor * MIN_OFFER_SHARE)) {
    return { code: 'OFFER_TOO_LOW', message: `Offers start at ${total(Math.ceil(input.listUnitMinor * MIN_OFFER_SHARE))}${forItems}. Try a higher price.` };
  }
  if (input.counterUnitMinor && input.unitMinor >= input.counterUnitMinor) {
    return { code: 'OFFER_ABOVE_COUNTER', message: `Hook already offered ${total(input.counterUnitMinor)}${forItems}. Accept it, or offer less.` };
  }
  if (input.previousBestUnitMinor && input.unitMinor <= input.previousBestUnitMinor) {
    return { code: 'OFFER_NOT_HIGHER', message: `Offer more than your last ${total(input.previousBestUnitMinor)}${forItems}.` };
  }
  return undefined;
}
