import { ProductAvailabilityStatus, ProductStatus } from '@lib/constants';

/**
 * Hook sells what a Market Associate has physically confirmed on a given day, so availability is a verification
 * window rather than a stock count. A confirmation made on a day stays valid through the end of that day in Lagos
 * time plus however many further days the admin allows; after that the product drops out of sale until it is
 * confirmed again. Everything that decides "can this be bought right now?" goes through the helpers below so the
 * catalogue, cart, checkout and negotiation can never disagree.
 */

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is UTC+1 all year, with no daylight saving.
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the Lagos calendar day containing `at`, as an absolute instant. */
export function startOfLagosDay(at: Date): Date {
  const local = at.getTime() + LAGOS_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - LAGOS_OFFSET_MS);
}

/**
 * When a confirmation made at `verifiedAt` stops being valid: the last millisecond of the Lagos day that is
 * `days` calendar days long counting the verification day itself. One day means "until the day is complete".
 */
export function availabilityWindowEnd(verifiedAt: Date, days: number): Date {
  const span = Math.min(Math.max(Math.floor(days) || 1, 1), 30);
  return new Date(startOfLagosDay(verifiedAt).getTime() + span * DAY_MS - 1);
}

const SELLABLE_AVAILABILITY: ProductAvailabilityStatus[] = [ProductAvailabilityStatus.AVAILABLE, ProductAvailabilityStatus.LIMITED];

/** True while a product is live, confirmed available and its confirmation has not run out. */
export function isOnSale(
  product: { status?: string; availabilityStatus?: string; availabilityValidUntil?: Date | string | null },
  now = new Date(),
): boolean {
  if (product.status !== ProductStatus.PUBLISHED) return false;
  if (!product.availabilityStatus || !SELLABLE_AVAILABILITY.includes(product.availabilityStatus as ProductAvailabilityStatus)) return false;
  if (!product.availabilityValidUntil) return true; // Older products carry no window; the scheduled check still governs them.
  return new Date(product.availabilityValidUntil).getTime() > now.getTime();
}

/** The same rule as a Mongo filter fragment, for queries that must only return products a customer can buy. */
export function onSaleFilter(now = new Date()) {
  return {
    status: ProductStatus.PUBLISHED,
    availabilityStatus: { $in: SELLABLE_AVAILABILITY },
    $or: [{ availabilityValidUntil: { $exists: false } }, { availabilityValidUntil: null }, { availabilityValidUntil: { $gt: now } }],
  };
}

/**
 * `match AND on sale`. Both sides of a query often carry their own `$or` (an id lookup by `_id` or `publicId`, and
 * the availability window), and spreading the two objects together silently drops the first `$or`, so the query
 * can return a different product. Always combine them with this.
 */
export function withOnSale(match: Record<string, unknown>, now = new Date()) {
  return { $and: [match, onSaleFilter(now)] };
}

/** The window filter alone, for listings that already constrain status themselves. */
export function stillValidFilter(now = new Date()) {
  return { $or: [{ availabilityValidUntil: { $exists: false } }, { availabilityValidUntil: null }, { availabilityValidUntil: { $gt: now } }] };
}
