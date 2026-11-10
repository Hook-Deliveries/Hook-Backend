import { NegotiatedQuoteStatus } from '@lib/constants';
import { percentOff } from '@lib/negotiation-offer-rules';
import { NegotiatedQuote } from '@models/catalog/catalog.model';
import { Product } from '@models/products/product.model';
import { deriveLiveRules, resolveQuote } from '@modules/negotiation/negotiation-live-rules.service';
import { voidQuote } from '@modules/negotiation/negotiation-reconcile.service';

/** A price the customer has locked for a product: it applies at any quantity and in any option until `expiresAt`. */
export interface LockedPrice {
  quoteId: string;
  /** The product's public id, so any screen showing that product can look its locked price up. */
  productId: string;
  unitPriceMinor: number;
  listUnitMinor: number;
  percentOff: number;
  expiresAt: string;
}

/**
 * Every locked price the customer holds right now, resolved against today's product rules: the lower of the agreed
 * and the current price, and a price the product has moved away from is cancelled instead of shown.
 */
export async function lockedPricesFor(customerId: string): Promise<LockedPrice[]> {
  const quotes = await NegotiatedQuote.find({
    customerId,
    status: NegotiatedQuoteStatus.ACTIVE,
    expiresAt: { $gt: new Date() },
  })
    .sort({ agreedPriceMinor: 1 })
    .limit(50)
    .lean({ virtuals: true });
  if (!quotes.length) return [];
  const products = await Product.find({ _id: { $in: [...new Set(quotes.map((quote) => quote.productId))] } })
    .select('publicId status availabilityStatus availabilityValidUntil sellingPriceMinor discountMinor catalogVersion negotiationRules deletedAt')
    .lean({ virtuals: true });
  const byId = new Map(products.map((product) => [String(product._id), product]));

  const best = new Map<string, LockedPrice>();
  for (const quote of quotes) {
    const product = byId.get(quote.productId);
    if (!product) continue;
    const live = deriveLiveRules(product);
    const resolution = resolveQuote(Number(quote.agreedPriceMinor), live);
    if (!resolution.valid) {
      await voidQuote(quote as never, resolution.reason).catch(() => undefined);
      continue;
    }
    const entry: LockedPrice = {
      quoteId: quote.publicId || String(quote._id),
      productId: (product as { publicId?: string }).publicId || String(product._id),
      unitPriceMinor: resolution.unitPriceMinor,
      listUnitMinor: live.effectivePriceMinor,
      percentOff: percentOff(resolution.unitPriceMinor, live.effectivePriceMinor),
      expiresAt: new Date(quote.expiresAt).toISOString(),
    };
    const current = best.get(entry.productId);
    if (!current || entry.unitPriceMinor < current.unitPriceMinor) best.set(entry.productId, entry);
  }
  return [...best.values()];
}
