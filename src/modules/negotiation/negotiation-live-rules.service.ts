import { isValidObjectId } from 'mongoose';
import { isOnSale } from '@lib/product-availability';
import { ProductVariant } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';

/**
 * Negotiation prices are agreed against rules that an admin can change at any time. This module is the single
 * answer to "what are the rules RIGHT NOW?" so the negotiation, cart, checkout and order-restoration paths can
 * never disagree about a locked price. The functions here are pure; only `loadLiveRules` touches the database.
 *
 * Policy for a locked price (a NegotiatedQuote) when the product changes underneath it:
 *  - the customer pays the LOWER of the agreed price and the current list price;
 *  - the quote is void when the product is no longer on sale, negotiation was switched off, the option was
 *    removed, or the minimum price was raised above the agreed price;
 *  - an unrelated change (availability confirmation, description edit, ...) does not touch the quote.
 */

export type QuoteVoidReason = 'PRODUCT_UNAVAILABLE' | 'NEGOTIATION_DISABLED' | 'FLOOR_RAISED';

export interface LiveRules {
  /** Live, confirmed available, not deleted and the chosen option (if any) is still active. */
  onSale: boolean;
  /** Negotiation is switched on and fully configured for this product. */
  enabled: boolean;
  /** What a customer pays today without negotiating: selling price minus discount. */
  effectivePriceMinor: number;
  /** The lowest price the business accepts. Internal: never send this to a client or the model. */
  floorMinor: number;
  catalogVersion: number;
  currency: string;
}

export type QuoteResolution =
  | { valid: true; unitPriceMinor: number; reason?: 'PRICE_DROPPED' }
  | { valid: false; reason: QuoteVoidReason };

type ProductLike = {
  status?: string;
  availabilityStatus?: string;
  availabilityValidUntil?: Date | string | null;
  deletedAt?: Date | string | null;
  sellingPriceMinor?: number;
  discountMinor?: number;
  catalogVersion?: number;
  currency?: string;
  negotiationRules?: {
    enabled?: boolean;
    minimumNegotiablePriceMinor?: number;
    maximumDiscountMinor?: number;
  } | null;
};

/** Pure: derive the live rules from a product document. `variantActive` is true when no option is involved. */
export function deriveLiveRules(product: ProductLike | null | undefined, variantActive = true, now = new Date()): LiveRules {
  if (!product) {
    return { onSale: false, enabled: false, effectivePriceMinor: 0, floorMinor: 0, catalogVersion: 0, currency: 'NGN' };
  }
  const selling = Number(product.sellingPriceMinor || 0);
  const effective = Math.max(0, selling - Number(product.discountMinor || 0));
  const rules = product.negotiationRules;
  const minimum = Number(rules?.minimumNegotiablePriceMinor || 0);
  const configured = Boolean(rules?.enabled) && minimum > 0 && rules?.maximumDiscountMinor !== undefined && selling > 0;
  const floor = configured ? Math.max(minimum, selling - Number(rules?.maximumDiscountMinor || 0)) : 0;
  return {
    onSale: !product.deletedAt && variantActive && effective > 0 && isOnSale(product, now),
    enabled: configured && floor > 0 && floor <= selling,
    effectivePriceMinor: effective,
    floorMinor: floor,
    catalogVersion: Number(product.catalogVersion || 1),
    currency: product.currency || 'NGN',
  };
}

/** Pure: apply the hybrid policy to an agreed unit price. */
export function resolveQuote(agreedPriceMinor: number, live: LiveRules): QuoteResolution {
  if (!live.onSale) return { valid: false, reason: 'PRODUCT_UNAVAILABLE' };
  if (!live.enabled) return { valid: false, reason: 'NEGOTIATION_DISABLED' };
  if (live.floorMinor > agreedPriceMinor) return { valid: false, reason: 'FLOOR_RAISED' };
  if (live.effectivePriceMinor < agreedPriceMinor) {
    return { valid: true, unitPriceMinor: live.effectivePriceMinor, reason: 'PRICE_DROPPED' };
  }
  return { valid: true, unitPriceMinor: agreedPriceMinor };
}

/**
 * Pure: the inputs `PricingEngine` expects, built from live rules. The engine stays unaware of discounts:
 * the list price it sees is already the effective price, and the floor can never exceed it.
 * `needed` is false when the list price is already at (or under) the floor, so haggling has nothing to give.
 */
export function pricingInputs(live: LiveRules) {
  const sellingPriceMinor = live.effectivePriceMinor;
  const minimumNegotiablePriceMinor = Math.min(live.floorMinor, sellingPriceMinor);
  return {
    sellingPriceMinor,
    minimumNegotiablePriceMinor,
    maximumDiscountMinor: sellingPriceMinor - minimumNegotiablePriceMinor,
    needed: live.enabled && sellingPriceMinor > live.floorMinor,
  };
}

/** Pure: pull a stored counter/agreed price back inside what is currently allowed. */
export function clampToLive(priceMinor: number, live: LiveRules) {
  if (!priceMinor) return priceMinor;
  return Math.min(Math.max(priceMinor, live.floorMinor), live.effectivePriceMinor);
}

/** Loads the product (and option) and derives the live rules. Never throws for a missing product. */
export async function loadLiveRules(productId: string, variantId?: string | null): Promise<LiveRules> {
  const product = isValidObjectId(productId) ? await Product.findById(productId).lean({ virtuals: true }) : null;
  let variantActive = true;
  if (product && variantId && isValidObjectId(variantId)) {
    const variant = await ProductVariant.findOne({
      _id: variantId,
      productId: String(product._id),
      active: true,
      deletedAt: { $exists: false },
    } as never).select('_id').lean();
    variantActive = Boolean(variant);
  }
  return deriveLiveRules(product as ProductLike | null, variantActive);
}
