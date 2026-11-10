import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { CartItem } from '../src/models/cart/cart-item.model';
import { Cart } from '../src/models/cart/cart.model';
import { NegotiatedQuote, ProductVariant } from '../src/models/catalog/catalog.model';
import { Product } from '../src/models/products/product.model';
import { Market } from '../src/models/platform/network.model';
import { lockedPricesFor } from '../src/modules/negotiation/negotiation-locked-prices.service';
import { CartService } from '../src/modules/orders/cart.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

/**
 * A locked price is the customer's price for the PRODUCT until it expires: any quantity, any option, on every way of
 * adding it. List ₦49,000 each, locked at ₦45,000 each (negotiated for 2 items). Amounts are integer kobo.
 */
const PRODUCT_ID = '64b0000000000000000000a1';
const MARKET_ID = '64b0000000000000000000c1';
const LIST = 4_900_000;
const LOCKED = 4_500_000;
const owner = { userId: 'customer_1' };

before(startDatabase);
after(stopDatabase);
afterEach(async () => {
  mock.restoreAll();
  await resetDatabase();
});

function product(over: Record<string, unknown> = {}) {
  return {
    _id: PRODUCT_ID, publicId: 'PRD-1', marketId: MARKET_ID, sourceStateId: 'state_1', status: 'published', availabilityStatus: 'available',
    sellingPriceMinor: LIST, discountMinor: 0, currency: 'NGN', catalogVersion: 5,
    negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_300_000, maximumDiscountMinor: 600_000 }, ...over,
  };
}

function stub(doc: Record<string, unknown>) {
  const chain = { select: () => chain, lean: async () => doc };
  mock.method(Product, 'findOne', () => chain);
  mock.method(Product, 'findById', () => chain);
  mock.method(Product, 'find', () => ({ select: () => ({ lean: async () => [doc] }) }));
  mock.method(Market, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: MARKET_ID, name: 'Balogun Market' }) }) }));
  mock.method(ProductVariant, 'findOne', (filter: { publicId?: string }) => ({
    lean: async () => ({ _id: filter.publicId === 'VAR-B' ? '64b0000000000000000000b2' : '64b0000000000000000000b1', publicId: filter.publicId, colour: 'Red', size: filter.publicId === 'VAR-B' ? 'L' : 'M', attributes: {} }),
  }));
}

async function lockedQuote(over: Record<string, unknown> = {}) {
  return NegotiatedQuote.create({
    publicId: 'QTE-1', negotiationId: 'neg_1', customerId: 'customer_1', productId: PRODUCT_ID, variantId: '64b0000000000000000000b1',
    quantity: 2, currency: 'NGN', originalPriceMinor: LIST, agreedPriceMinor: LOCKED, productVersion: 5,
    expiresAt: new Date(Date.now() + 30 * 60_000), status: 'active', ...over,
  });
}

const lines = () => CartItem.find({}).sort({ variantKey: 1 }).lean();

test('an explicit locked price works at any quantity, not just the negotiated one', async () => {
  stub(product());
  await lockedQuote();
  await new CartService().addItem(owner, PRODUCT_ID, 5, undefined, 'VAR-A', 'QTE-1', { deferRecalculation: true });
  const [line] = await lines();
  assert.equal(line.quantity, 5);
  assert.equal(line.unitPriceMinor, LOCKED);
  assert.equal(line.totalPriceMinor, LOCKED * 5);
  assert.ok(line.quoteId);
});

test('every way of adding the product gets the locked price, with no quote id sent', async () => {
  stub(product());
  await lockedQuote();
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 1, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  await cart.addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  const [line] = await lines();
  assert.equal(line.quantity, 3, 'adds increment');
  assert.equal(line.unitPriceMinor, LOCKED);
  assert.equal(line.totalPriceMinor, LOCKED * 3);
});

test('a different option of the same product gets the same locked price', async () => {
  stub(product());
  await lockedQuote();
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 1, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  await cart.addItem(owner, PRODUCT_ID, 4, undefined, 'VAR-B', undefined, { deferRecalculation: true });
  const all = await lines();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((line) => line.unitPriceMinor), [LOCKED, LOCKED]);
  assert.equal(all[0].quoteId, all[1].quoteId);
});

test('changing the quantity keeps the locked price', async () => {
  stub(product());
  await lockedQuote();
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', 'QTE-1', { deferRecalculation: true });
  const [line] = await lines();
  await cart.updateItem(owner, String(line.publicId), 7, { deferRecalculation: true });
  const [after] = await lines();
  assert.equal(after.quantity, 7);
  assert.equal(after.unitPriceMinor, LOCKED);
  assert.equal(after.totalPriceMinor, LOCKED * 7);
  assert.ok(after.quoteId);
});

test('a line added at list price moves to the locked price when it changes quantity', async () => {
  stub(product());
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, LIST);
  await lockedQuote();
  const [line] = await lines();
  await cart.updateItem(owner, String(line.publicId), 3, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, LOCKED);
});

test('locking a price reprices what is already in the cart, at any quantity or option', async () => {
  stub(product());
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  await cart.addItem(owner, PRODUCT_ID, 6, undefined, 'VAR-B', undefined, { deferRecalculation: true });
  const quote = await lockedQuote();
  const changed = await cart.applyLockedPrice('customer_1', quote.toObject() as never);
  assert.equal(changed, 2);
  const all = await lines();
  assert.deepEqual(all.map((line) => [line.quantity, line.unitPriceMinor, line.totalPriceMinor]), [[2, LOCKED, LOCKED * 2], [6, LOCKED, LOCKED * 6]]);
});

test('if the list price drops below the locked price the customer pays the lower price', async () => {
  stub(product({ sellingPriceMinor: 4_400_000, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_900_000, maximumDiscountMinor: 500_000 } }));
  await lockedQuote();
  await new CartService().addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, 4_400_000);
});

test('when the product moves away from the locked price, a normal add falls back to the list price but an explicit one is refused', async () => {
  stub(product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_700_000, maximumDiscountMinor: 200_000 } }));
  await lockedQuote();
  const cart = new CartService();
  await cart.addItem(owner, PRODUCT_ID, 1, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, LIST);
  assert.equal((await NegotiatedQuote.findOne({ publicId: 'QTE-1' }).lean())?.status, 'cancelled');
  await lockedQuote({ publicId: 'QTE-2', negotiationId: 'neg_2' });
  await assert.rejects(cart.addItem(owner, PRODUCT_ID, 1, undefined, 'VAR-A', 'QTE-2', { deferRecalculation: true }), { code: 'NEGOTIATED_PRICE_VOIDED' });
});

test('an expired locked price is not applied', async () => {
  stub(product());
  await lockedQuote({ expiresAt: new Date(Date.now() - 1000) });
  await new CartService().addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, LIST);
});

test("another customer's locked price is never applied", async () => {
  stub(product());
  await lockedQuote({ customerId: 'someone_else' });
  await new CartService().addItem(owner, PRODUCT_ID, 2, undefined, 'VAR-A', undefined, { deferRecalculation: true });
  assert.equal((await lines())[0].unitPriceMinor, LIST);
});

test('the locked prices list has one entry per product with the saving and the expiry', async () => {
  stub(product());
  await lockedQuote();
  await lockedQuote({ publicId: 'QTE-3', negotiationId: 'neg_3', agreedPriceMinor: 4_600_000 });
  const prices = await lockedPricesFor('customer_1');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].productId, 'PRD-1');
  assert.equal(prices[0].unitPriceMinor, LOCKED, 'the better of the two');
  assert.equal(prices[0].listUnitMinor, LIST);
  assert.equal(prices[0].percentOff, 8.2);
  assert.ok(new Date(prices[0].expiresAt).getTime() > Date.now());
  assert.equal(JSON.stringify(prices).includes('4300000'), false, 'the floor is never exposed');
});

test('a locked price the product has moved away from is cancelled instead of listed', async () => {
  stub(product({ status: 'paused' }));
  await lockedQuote();
  assert.deepEqual(await lockedPricesFor('customer_1'), []);
  assert.equal((await NegotiatedQuote.findOne({ publicId: 'QTE-1' }).lean())?.status, 'cancelled');
});
