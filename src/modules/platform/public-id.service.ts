import { PublicIdCounter } from '@models/platform/counter.model';
import { HttpError } from '@utils/http';

export const PUBLIC_ID_PREFIXES = {
  state: 'STA',
  city: 'CIT',
  localGovernment: 'LGA',
  zone: 'ZON',
  market: 'MAR',
  hub: 'HUB',
  partner: 'HPT',
  marketAssociate: 'MA',
  customer: 'CUS',
  staff: 'STF',
  category: 'CAT',
  submission: 'SUB',
  product: 'PRD',
  variant: 'VAR',
  negotiation: 'NEG',
  quote: 'QTE',
  address: 'ADR',
  cart: 'CRT',
  cartItem: 'CTI',
  order: 'ORD',
  orderItem: 'ORI',
  payment: 'PAY',
  paymentLink: 'PLK',
  paymentAttempt: 'PAT',
  event: 'EVT',
  audit: 'AUD',
  fulfilment: 'FUL',
  runnerPackage: 'RPK',
  hubPackage: 'HPK',
  consolidation: 'CON',
  shipment: 'SHP',
  manifest: 'MAN',
  returnRequest: 'RET',
  refund: 'RFD',
  partnerCustody: 'PCU',
  orderFulfilmentGroup: 'OFG',
  deliveryRule: 'DPR',
  marketVendor: 'MVD',
  vendorInvitation: 'VNI',
  vendorCollection: 'VCL',
  vendorPayment: 'VPM',
  logisticsProvider: 'LGP',
  coupon: 'CPN',
  couponRedemption: 'CRD',
  referral: 'REF',
  itemResolution: 'IRS',
  waitlistEntry: 'WTL',
  broadcast: 'BRC',
  faq: 'FAQ',
} as const;

export type PublicIdDomain = keyof typeof PUBLIC_ID_PREFIXES;

export function formatPublicId(prefix: string, year: number, sequence: number) {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * The short, human-facing product alias (HK-000061) derived from the same
 * reserved sequence as the product's publicId (PRD-2026-000061), so the two
 * can never drift. Every product-creation path must use this rather than
 * inventing its own format.
 */
export function hookIdFromPublicId(productPublicId: string) {
  const sequence = productPublicId.split('-')[2];
  return `HK-${sequence || productPublicId}`;
}

export async function nextPublicId(domain: PublicIdDomain, now = new Date()) {
  const prefix = PUBLIC_ID_PREFIXES[domain];
  const year = now.getUTCFullYear();
  const counter = await PublicIdCounter.findOneAndUpdate(
    { prefix, year },
    { $inc: { sequence: 1 }, $setOnInsert: { prefix, year } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  if (!counter) throw new HttpError(500, 'Unable to generate public identifier', undefined, 'INTERNAL_ERROR');
  return formatPublicId(prefix, year, counter.sequence);
}

/** Reserve a contiguous range in one atomic counter update for bulk seed/import work. */
export async function nextPublicIds(domain: PublicIdDomain, count: number, now = new Date()) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new HttpError(400, 'Public identifier count must be a non-negative integer');
  }
  if (count === 0) return [];
  const prefix = PUBLIC_ID_PREFIXES[domain];
  const year = now.getUTCFullYear();
  const counter = await PublicIdCounter.findOneAndUpdate(
    { prefix, year },
    { $inc: { sequence: count }, $setOnInsert: { prefix, year } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  if (!counter) throw new HttpError(500, 'Unable to reserve public identifiers', undefined, 'INTERNAL_ERROR');
  const first = counter.sequence - count + 1;
  return Array.from({ length: count }, (_, index) => formatPublicId(prefix, year, first + index));
}

// Cart lines are created frequently. Reserving a small range keeps the
// identifier guarantee atomic while removing one counter write from the
// normal add-to-cart request. Unused values after a process restart are safe
// gaps, just like any other failed counter consumer.
const CART_ITEM_ID_BATCH_SIZE = 32;
let cartItemIdPool: string[] = [];
let cartItemIdPoolYear: number | undefined;
let cartItemIdRefill: Promise<void> | null = null;

export async function nextCartItemPublicId(now = new Date()) {
  const year = now.getUTCFullYear();
  if (cartItemIdPoolYear !== year) {
    cartItemIdPool = [];
    cartItemIdPoolYear = year;
  }

  if (!cartItemIdPool.length) {
    if (!cartItemIdRefill) {
      cartItemIdRefill = nextPublicIds("cartItem", CART_ITEM_ID_BATCH_SIZE, now)
        .then((ids) => {
          if (cartItemIdPoolYear === year) cartItemIdPool.push(...ids);
        })
        .finally(() => {
          cartItemIdRefill = null;
        });
    }
    await cartItemIdRefill;
  }

  const publicId = cartItemIdPool.shift();
  if (!publicId) {
    throw new HttpError(500, "Unable to generate cart item identifier", undefined, "INTERNAL_ERROR");
  }
  return publicId;
}

export async function repairPublicIdCounter(
  domain: PublicIdDomain,
  sequence: number,
  actorId: string,
  year = new Date().getUTCFullYear(),
) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new HttpError(400, 'Counter sequence must be a non-negative integer');
  }
  const prefix = PUBLIC_ID_PREFIXES[domain];
  return PublicIdCounter.findOneAndUpdate(
    { prefix, year },
    { $set: { sequence, repairedAt: new Date(), repairedBy: actorId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean({ virtuals: true });
}
