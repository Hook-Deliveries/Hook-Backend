import { Types } from 'mongoose';
import { Product } from '@models/products/product.model';
import { ProductVariant } from '@models/catalog/catalog.model';
import { Market } from '@models/platform/network.model';
import { LegalContent } from '@models/platform/legal-content.model';
import { Cart } from '@models/cart/cart.model';
import { CartItem } from '@models/cart/cart-item.model';
import type { Negotiation } from '@models/negotiations/negotiation.model';

/** Explicit allowlist: never serialize whole documents or private pricing rules. */
export async function negotiationContext(session: Pick<Negotiation, 'customerId' | 'productId' | 'marketId' | 'variantId' | 'quantity' | 'lastCounterPriceMinor' | 'agreedPriceMinor'>) {
  const product = await Product.findById(session.productId).select('publicId title description marketId availabilityStatus sellingPriceMinor discountMinor').lean();
  const marketId = product?.marketId || session.marketId;
  const [market, variants, policies, cart] = await Promise.all([
    marketId ? Market.findOne(Types.ObjectId.isValid(marketId) ? { _id: marketId } : { publicId: marketId }).select('publicId name').lean() : null,
    ProductVariant.find({ productId: session.productId, active: true, deletedAt: { $exists: false } }).select('publicId colour size').limit(40).lean(),
    LegalContent.find({ effectiveDate: { $lte: new Date() }, type: 'terms' }).select('title bodyHtml version').limit(1).lean(),
    session.customerId ? Cart.findOne({ userId: session.customerId }).select('_id').lean() : null,
  ]);
  const lines = cart ? await CartItem.find({ cartId: cart._id.toString(), deletedAt: null }).select('productId quantity selectedVariants unitPriceMinor').limit(12).lean() : [];
  const products = await Product.find({ _id: { $in: lines.map((line) => line.productId).filter(Types.ObjectId.isValid) } }).select('publicId title').lean();
  const names = new Map(products.map((entry) => [entry._id.toString(), { id: entry.publicId, title: entry.title }]));
  return {
    product: product ? { id: product.publicId, title: product.title, description: product.description?.slice(0, 2000), availability: product.availabilityStatus, priceMinor: Math.max(0, Number(product.sellingPriceMinor || 0) - Number(product.discountMinor || 0)) } : null,
    market: market ? { id: market.publicId, name: market.name } : null,
    options: variants.map((entry) => ({ id: entry.publicId, colour: entry.colour, size: entry.size })),
    selectedOptions: variants.filter((entry) => entry._id.toString() === session.variantId).map((entry) => ({ id: entry.publicId, colour: entry.colour, size: entry.size }))[0] || null,
    quantity: session.quantity, counterPriceMinor: session.lastCounterPriceMinor, agreedPriceMinor: session.agreedPriceMinor,
    policies: policies.map((entry) => ({ title: entry.title, version: entry.version, text: entry.bodyHtml.replace(/<[^>]*>/g, ' ').slice(0, 4000) })),
    cart: lines.map((line) => ({ product: names.get(line.productId), quantity: line.quantity, options: line.selectedVariants, unitPriceMinor: line.unitPriceMinor })),
  };
}
