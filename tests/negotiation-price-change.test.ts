import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { CartItem } from '../src/models/cart/cart-item.model';
import { Cart } from '../src/models/cart/cart.model';
import { NegotiatedQuote } from '../src/models/catalog/catalog.model';
import { Negotiation } from '../src/models/negotiations/negotiation.model';
import { Product } from '../src/models/products/product.model';
import { CartService } from '../src/modules/orders/cart.service';
import { reconcileProduct, sweepNegotiationDrift } from '../src/modules/negotiation/negotiation-reconcile.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

/**
 * What happens to a locked (agreed) price when an admin changes the product.
 * List price 50,000.00 NGN, floor 40,000.00 NGN, customer agreed 43,000.00 NGN. Amounts are integer kobo.
 */
const PRODUCT_ID = '64b0000000000000000000a1';
const VARIANT_ID = '64b0000000000000000000b1';
const AGREED = 4_300_000;

before(startDatabase);
after(stopDatabase);
afterEach(async () => {
  mock.restoreAll();
  await resetDatabase();
});

function product(over: Record<string, unknown> = {}) {
  return {
    _id: PRODUCT_ID,
    publicId: 'prd_1',
    title: 'Hook shoe',
    status: 'published',
    availabilityStatus: 'available',
    sellingPriceMinor: 5_000_000,
    discountMinor: 0,
    catalogVersion: 7,
    currency: 'NGN',
    negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 },
    ...over,
  };
}

function stubProduct(doc: Record<string, unknown>) {
  mock.method(Product, 'findById', () => ({ select: () => ({ lean: async () => doc }), lean: async () => doc }));
  mock.method(Product, 'find', () => ({ select: () => ({ lean: async () => [doc] }) }));
}

async function lockedQuote() {
  const session = await Negotiation.create({
    publicId: 'neg_pc_1', customerId: 'customer_1', productId: PRODUCT_ID, variantId: VARIANT_ID,
    quantity: 1, currency: 'NGN', status: 'agreed', offerCount: 1, maximumOffers: 3, version: 2,
  });
  return NegotiatedQuote.create({
    publicId: 'quo_pc_1', negotiationId: String(session._id), customerId: 'customer_1', productId: PRODUCT_ID,
    variantId: VARIANT_ID, quantity: 1, currency: 'NGN', originalPriceMinor: 5_000_000, agreedPriceMinor: AGREED,
    productVersion: 7, expiresAt: new Date(Date.now() + 30 * 60_000), status: 'active',
  });
}

async function quoteStatus() {
  const quote = await NegotiatedQuote.findOne({ publicId: 'quo_pc_1' }).lean();
  return { status: quote?.status, voidReason: quote?.voidReason };
}

test('floor raised above the agreed price cancels the quote', async () => {
  await lockedQuote();
  stubProduct(product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_400_000, maximumDiscountMinor: 600_000 } }));
  const result = await reconcileProduct(PRODUCT_ID);
  assert.equal(result.quotesVoided, 1);
  assert.deepEqual(await quoteStatus(), { status: 'cancelled', voidReason: 'FLOOR_RAISED' });
});

test('a product that was paused cancels the quote and closes live sessions', async () => {
  await lockedQuote();
  await Negotiation.create({
    publicId: 'neg_pc_2', customerId: 'customer_2', productId: PRODUCT_ID, variantId: VARIANT_ID,
    quantity: 1, currency: 'NGN', status: 'active', offerCount: 0, maximumOffers: 3, version: 1, transcript: [],
  });
  stubProduct(product({ status: 'paused' }));
  const result = await reconcileProduct(PRODUCT_ID);
  assert.deepEqual(result, { quotesVoided: 1, sessionsClosed: 1 });
  assert.deepEqual(await quoteStatus(), { status: 'cancelled', voidReason: 'PRODUCT_UNAVAILABLE' });
  const live = await Negotiation.findOne({ publicId: 'neg_pc_2' }).lean();
  assert.equal(live?.status, 'closed');
  assert.equal(live?.endReason, 'PRODUCT_UNAVAILABLE');
});

test('a price drop or an unrelated edit leaves the quote alone', async () => {
  await lockedQuote();
  stubProduct(product({ sellingPriceMinor: 4_200_000, catalogVersion: 12, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_500_000, maximumDiscountMinor: 700_000 } }));
  assert.deepEqual(await reconcileProduct(PRODUCT_ID), { quotesVoided: 0, sessionsClosed: 0 });
  assert.equal((await quoteStatus()).status, 'active');
});

test('a quote that was already used is never touched', async () => {
  const quote = await lockedQuote();
  await NegotiatedQuote.updateOne({ _id: quote._id }, { $set: { status: 'used' } });
  stubProduct(product({ status: 'paused' }));
  assert.equal((await reconcileProduct(PRODUCT_ID)).quotesVoided, 0);
  assert.equal((await quoteStatus()).status, 'used');
});

test('reconciling twice is harmless', async () => {
  await lockedQuote();
  stubProduct(product({ status: 'paused' }));
  assert.equal((await reconcileProduct(PRODUCT_ID)).quotesVoided, 1);
  assert.equal((await reconcileProduct(PRODUCT_ID)).quotesVoided, 0);
});

test('the scheduled sweep catches a change nobody announced', async () => {
  await lockedQuote();
  stubProduct(product({ negotiationRules: { enabled: false, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 } }));
  const result = await sweepNegotiationDrift();
  assert.equal(result.quotesVoided, 1);
  assert.deepEqual(await quoteStatus(), { status: 'cancelled', voidReason: 'NEGOTIATION_DISABLED' });
});

async function cartWithQuotedLine(itemOver: Record<string, unknown> = {}) {
  const cart = await Cart.create({ publicId: 'cart_pc_1', customerId: 'customer_1', status: 'active', isCheckedOut: false, subtotal: 0, deliveryFee: 0, total: 0, version: 1, ownerType: 'customer' } as never);
  const quote = await lockedQuote();
  await CartItem.create({
    publicId: 'item_pc_1', cartId: String(cart._id), productId: PRODUCT_ID, variantId: VARIANT_ID, variantKey: VARIANT_ID,
    quantity: 1, unitPrice: AGREED / 100, totalPrice: AGREED / 100, unitPriceMinor: AGREED, totalPriceMinor: AGREED,
    quoteId: String(quote._id), productVersion: 7, ...itemOver,
  });
  return String(cart._id);
}

test('cart: an unrelated catalogue edit does not block a quoted line', async () => {
  const cartId = await cartWithQuotedLine();
  stubProduct(product({ catalogVersion: 30 }));
  const cart: any = await new CartService().recalculate(cartId);
  assert.deepEqual(cart.items[0].blockingReasons, []);
  assert.equal(cart.items[0].unitPriceMinor, AGREED);
});

test('cart: a plain line is still blocked by a version change', async () => {
  const cartId = await cartWithQuotedLine({ quoteId: undefined, unitPriceMinor: 5_000_000, totalPriceMinor: 5_000_000 });
  stubProduct(product({ catalogVersion: 30 }));
  const cart: any = await new CartService().recalculate(cartId);
  assert.deepEqual(cart.items[0].blockingReasons, ['PRODUCT_CHANGED']);
});

test('cart: the customer pays the lower price when the list price falls under the agreed price', async () => {
  const cartId = await cartWithQuotedLine();
  stubProduct(product({ sellingPriceMinor: 4_200_000, catalogVersion: 8, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_500_000, maximumDiscountMinor: 700_000 } }));
  const cart: any = await new CartService().recalculate(cartId);
  const line = cart.items[0];
  assert.deepEqual(line.blockingReasons, []);
  assert.equal(line.unitPriceMinor, 4_200_000);
  assert.equal(line.totalPriceMinor, 4_200_000);
  assert.equal(line.priceNote, 'PRICE_DROPPED');
  assert.equal(cart.subtotalMinor, 4_200_000);
});

test('cart: a quote the product moved away from blocks the line instead of being honoured', async () => {
  const cartId = await cartWithQuotedLine();
  stubProduct(product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_400_000, maximumDiscountMinor: 600_000 } }));
  const cart: any = await new CartService().recalculate(cartId);
  const line = cart.items[0];
  assert.deepEqual(line.blockingReasons, ['NEGOTIATED_PRICE_VOIDED']);
  assert.equal(line.negotiatedQuote.status, 'cancelled');
  assert.equal(line.negotiatedQuote.voidReason, 'FLOOR_RAISED');
});

test('cart: re-confirming a cancelled line puts it back on the list price and clears the block', async () => {
  const cartId = await cartWithQuotedLine();
  const doc = product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_400_000, maximumDiscountMinor: 600_000 } });
  stubProduct(doc);
  await reconcileProduct(PRODUCT_ID);
  const owner = { userId: 'customer_1' };
  mock.method(Product, 'findById', () => ({ select: () => ({ lean: async () => doc }), lean: async () => doc }));
  await new CartService().updateItem(owner, 'item_pc_1', 1, { deferRecalculation: true });
  const item = await CartItem.findOne({ publicId: 'item_pc_1' }).lean();
  assert.equal(item?.quoteId, undefined);
  assert.equal(item?.unitPriceMinor, 5_000_000);
  assert.equal(item?.productVersion, 7);
});
