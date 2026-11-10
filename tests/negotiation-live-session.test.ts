import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { Cart } from '../src/models/cart/cart.model';
import { NegotiatedQuote, ProductVariant } from '../src/models/catalog/catalog.model';
import { CommerceSettings } from '../src/models/commerce/commerce.model';
import { Negotiation } from '../src/models/negotiations/negotiation.model';
import { LegalContent } from '../src/models/platform/legal-content.model';
import { Product } from '../src/models/products/product.model';
import { AzureNegotiationService } from '../src/modules/negotiation/azure-negotiation.service';
import { NegotiationService } from '../src/modules/negotiation/negotiation.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

/**
 * Negotiations judged against live rules. Prices are integer kobo: list 50,000.00 NGN, floor 40,000.00 NGN.
 * Persistence is real (in-memory replica set); only Azure and the product lookups are stubbed.
 */
const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION'];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const PRODUCT_ID = '64b0000000000000000000a1';
const VARIANT_ID = '64b0000000000000000000b1';

before(startDatabase);
after(stopDatabase);
afterEach(async () => {
  mock.restoreAll();
  for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await resetDatabase();
});

function liveProduct(over: Record<string, unknown> = {}) {
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

function stubWorld(product: Record<string, unknown>, variantActive = true) {
  for (const key of keys) process.env[key] = 'unit-test';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://hook-unit.openai.azure.com';
  mock.method(CommerceSettings, 'findOne', () => ({ select: () => ({ lean: async () => ({}) }), lean: async () => ({}) }));
  mock.method(Product, 'findById', () => ({ select: () => ({ lean: async () => product }), lean: async () => product }));
  mock.method(ProductVariant, 'findOne', () => ({ select: () => ({ lean: async () => (variantActive ? { _id: VARIANT_ID } : null) }) }));
  mock.method(Product, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  for (const model of [ProductVariant, LegalContent]) mock.method(model, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  mock.method(Cart, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  mock.method(AzureNegotiationService.prototype, 'shoppingIntent', async () => ({ intent: 'offer', quantity: undefined }));
  mock.method(AzureNegotiationService.prototype, 'phrase', async () => ({ message: 'Okay.', telemetry: { provider: 'azure_openai' }, fallbackUsed: false }));
}

async function startedSession(over: Record<string, unknown> = {}) {
  return Negotiation.create({
    publicId: 'neg_live_1',
    customerId: 'customer_1',
    channel: 'shopper',
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    quantity: 1,
    currency: 'NGN',
    status: 'active',
    offerCount: 0,
    maximumOffers: 3,
    transcript: [],
    version: 1,
    rulesSnapshot: {
      priceBasis: 'effective',
      sellingPriceMinor: 5_000_000,
      minimumNegotiablePriceMinor: 4_000_000,
      maximumDiscountMinor: 1_000_000,
      maximumOffers: 3,
      quoteMinutes: 30,
      azureWordingEnabled: true,
    },
    ...over,
  });
}

const customer = { customerId: 'customer_1' };

test('offer on a product that was paused ends the session instead of pricing it', async () => {
  stubWorld(liveProduct({ status: 'paused' }));
  await startedSession();
  await assert.rejects(
    new NegotiationService().offer(customer, 'neg_live_1', 4_500_000, 'offer-key-0001', '45k'),
    { code: 'NEGOTIATION_PRODUCT_UNAVAILABLE' },
  );
  const saved = await Negotiation.findOne({ publicId: 'neg_live_1' }).lean();
  assert.equal(saved?.status, 'closed');
  assert.equal(saved?.endReason, 'PRODUCT_UNAVAILABLE');
  assert.equal(saved?.offerCount, 0);
});

test('offer after negotiation is switched off reports the product as unavailable for negotiation', async () => {
  stubWorld(liveProduct({ negotiationRules: { enabled: false, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 } }));
  await startedSession();
  await assert.rejects(
    new NegotiationService().offer(customer, 'neg_live_1', 4_500_000, 'offer-key-0002', '45k'),
    { code: 'NEGOTIATION_PRODUCT_UNAVAILABLE' },
  );
  assert.equal((await Negotiation.findOne({ publicId: 'neg_live_1' }).lean())?.endReason, 'NEGOTIATION_DISABLED');
});

test('a price drop mid-session is applied, stored and reported to the customer', async () => {
  // List price falls to 45,000 and the floor to 38,000.
  stubWorld(liveProduct({ sellingPriceMinor: 4_500_000, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_800_000, maximumDiscountMinor: 700_000 } }));
  await startedSession();
  const response: any = await new NegotiationService().offer(customer, 'neg_live_1', 4_000_000, 'offer-key-0003', '40k');
  assert.equal(response.decision, 'COUNTER');
  assert.equal(response.counterPriceMinor, 4_266_667);
  assert.deepEqual(response.priceChanged, { fromMinor: 5_000_000, toMinor: 4_500_000 });
  const saved = await Negotiation.findOne({ publicId: 'neg_live_1' }).lean();
  assert.equal(saved?.rulesSnapshot?.sellingPriceMinor, 4_500_000);
  assert.equal(saved?.rulesSnapshot?.minimumNegotiablePriceMinor, 3_800_000);
  assert.ok(saved?.transcript.some((entry: any) => /price of this item changed/i.test(entry.message)));
  assert.equal(JSON.stringify(response).includes('floor'), false);
});

test('an unchanged product does not report a price change', async () => {
  stubWorld(liveProduct());
  await startedSession();
  const response: any = await new NegotiationService().offer(customer, 'neg_live_1', 4_000_000, 'offer-key-0004', '40k');
  assert.equal(response.priceChanged, undefined);
});

test('a raised floor never lets an old counter or agreed price lock below it', async () => {
  // Floor is now 44,000. The customer earlier had 41,000 agreed and 43,000 countered.
  stubWorld(liveProduct({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_400_000, maximumDiscountMinor: 600_000 } }));
  await startedSession({
    offerCount: 2,
    agreedPriceMinor: 4_100_000,
    lastCounterPriceMinor: 4_300_000,
    transcript: [
      { id: 'a', sequence: 1, kind: 'text', role: 'customer', message: '40k', offeredPriceMinor: 4_000_000, createdAt: new Date() },
      { id: 'b', sequence: 2, kind: 'text', role: 'customer', message: '41k', offeredPriceMinor: 4_100_000, createdAt: new Date() },
    ],
  });
  const response: any = await new NegotiationService().offer(customer, 'neg_live_1', 4_400_000, 'offer-key-0005', '44k');
  assert.equal(response.status, 'agreed');
  assert.equal(response.agreedPriceMinor, 4_400_000);
  const quote = await NegotiatedQuote.findOne({ publicId: response.quoteId }).lean();
  assert.equal(quote?.agreedPriceMinor, 4_400_000);
  assert.equal(quote?.productVersion, 7);
});

test('when the list price drops to the floor the customer is locked in at the list price', async () => {
  // 10,000 discount takes the 50,000 list price down to the 40,000 floor.
  stubWorld(liveProduct({ discountMinor: 1_000_000 }));
  await startedSession();
  const response: any = await new NegotiationService().offer(customer, 'neg_live_1', 3_000_000, 'offer-key-0006', '30k');
  assert.equal(response.decision, 'ACCEPT');
  assert.equal(response.status, 'agreed');
  assert.equal(response.agreedPriceMinor, 4_000_000);
  const quote = await NegotiatedQuote.findOne({ publicId: response.quoteId }).lean();
  assert.equal(quote?.originalPriceMinor, 4_000_000);
});

test('accept locks the best price that is still allowed and refuses a paused product', async () => {
  stubWorld(liveProduct({ sellingPriceMinor: 4_200_000, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_500_000, maximumDiscountMinor: 700_000 } }));
  await startedSession({ offerCount: 1, lastCounterPriceMinor: 4_600_000 });
  mock.method(mongoose.model('User'), 'findOne', () => ({ lean: async () => ({ _id: 'customer_1' }) }));
  const accepted: any = await new NegotiationService().accept(customer, 'neg_live_1');
  // The old 46,000 counter is above today's 42,000 list price, so the customer gets the lower one.
  assert.equal(accepted.agreedPriceMinor, 4_200_000);
});

test('accept ends the session when the product is no longer on sale', async () => {
  stubWorld(liveProduct({ availabilityStatus: 'unconfirmed' }));
  await startedSession({ offerCount: 1, lastCounterPriceMinor: 4_600_000 });
  mock.method(mongoose.model('User'), 'findOne', () => ({ lean: async () => ({ _id: 'customer_1' }) }));
  await assert.rejects(new NegotiationService().accept(customer, 'neg_live_1'), { code: 'NEGOTIATION_PRODUCT_UNAVAILABLE' });
  assert.equal((await Negotiation.findOne({ publicId: 'neg_live_1' }).lean())?.status, 'closed');
});

test('offer after the chosen option was switched off ends the session', async () => {
  stubWorld(liveProduct(), false);
  await startedSession();
  await assert.rejects(
    new NegotiationService().offer(customer, 'neg_live_1', 4_500_000, 'offer-key-0007', '45k'),
    { code: 'NEGOTIATION_PRODUCT_UNAVAILABLE' },
  );
});

test('a conversation with too many price-less messages is capped', async () => {
  stubWorld(liveProduct());
  const chatter = Array.from({ length: 40 }, (_, index) => ({
    id: `c${index}`, sequence: index + 1, kind: 'text', role: 'customer', message: 'hello', createdAt: new Date(),
  }));
  await startedSession({ transcript: chatter });
  await assert.rejects(
    new NegotiationService().offer(customer, 'neg_live_1', undefined, 'offer-key-0008', 'hello again'),
    { code: 'NEGOTIATION_MESSAGE_LIMIT' },
  );
});
