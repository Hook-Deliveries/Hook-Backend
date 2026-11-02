import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { AzureNegotiationService, negotiationUnavailable } from '../src/modules/negotiation/azure-negotiation.service';
import { NegotiationService } from '../src/modules/negotiation/negotiation.service';
import { Negotiation } from '../src/models/negotiations/negotiation.model';
import { CommerceSettings } from '../src/models/commerce/commerce.model';
import { Product } from '../src/models/products/product.model';
import { PricingEngine } from '../src/modules/catalog/pricing-engine.service';
import { Cart } from '../src/models/cart/cart.model';
import { ProductVariant } from '../src/models/catalog/catalog.model';
import { LegalContent } from '../src/models/platform/legal-content.model';
import { canReceiveNegotiationAlert } from '../src/modules/negotiation/negotiation-notifications.service';
import { ScopeType } from '../src/lib/constants';
import { negotiationContext } from '../src/modules/negotiation/negotiation-context.service';
import { withNegotiationExecution, negotiationWriteFence } from '../src/lib/negotiation-execution';

const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION'];
const original = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => { mock.restoreAll(); for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const session = { _id: 'session', publicId: 'neg_1', customerId: 'customer', productId: 'product', quantity: 2, version: 3, status: 'active', offerCount: 1, maximumOffers: 3, lastCounterPriceMinor: 4500000, transcript: [{ role: 'customer', message: '40k', offeredPriceMinor: 4000000 }], rulesSnapshot: { azureWordingEnabled: true } };
function fixture() {
  for (const key of keys) process.env[key] = 'unit-test';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://hook-unit.openai.azure.com';
  mock.method(Negotiation, 'findOne', () => ({ lean: async () => session }));
  mock.method(CommerceSettings, 'findOne', () => ({ select: () => ({ lean: async () => ({}) }) }));
  mock.method(Product, 'findById', () => ({ select: () => ({ lean: async () => ({ publicId: 'prd_1', title: 'Hook shoe', sellingPriceMinor: 5000000, negotiationRules: { minimumNegotiablePriceMinor: 100 } }) }) }));
  mock.method(Product, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  for (const model of [ProductVariant, LegalContent]) mock.method(model, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  mock.method(Cart, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  mock.method(AzureNegotiationService.prototype, 'shoppingIntent', async () => ({ intent: 'conversation', quantity: undefined }));
  return mock.method(Negotiation, 'findOneAndUpdate', () => ({ lean: async () => session }));
}
test('non-price messages preserve prior offers, counters, and remaining offers', async () => {
  const write = fixture();
  const pricing = mock.method(PricingEngine.prototype, 'decide', () => { throw new Error('must not price'); });
  mock.method(AzureNegotiationService.prototype, 'guide', async () => ({ message: 'What size would you like?', telemetry: {}, fallbackUsed: false }));
  const response = await new NegotiationService().offer({ customerId: 'customer' }, 'neg_1', undefined, 'request-key', 'Give me 2');
  assert.equal(response.remainingOffers, 2);
  assert.equal(pricing.mock.callCount(), 0);
  const update = write.mock.calls[0].arguments[1] as { $inc: Record<string, number>; $set: Record<string, unknown> };
  assert.equal(update.$inc.offerCount, undefined);
  assert.equal(update.$set.lastCounterPriceMinor, undefined);
  assert.equal(update.$set.agreedPriceMinor, undefined);
});
test('AI failure does not commit a transcript or consume an offer', async () => {
  const write = fixture();
  mock.method(AzureNegotiationService.prototype, 'guide', async () => { throw negotiationUnavailable(); });
  await assert.rejects(new NegotiationService().offer({ customerId: 'customer' }, 'neg_1', undefined, 'request-key', 'Hello'), { code: 'NEGOTIATION_UNAVAILABLE' });
  assert.equal(write.mock.callCount(), 0);
});
test('backend context excludes private pricing and customer identity', async () => {
  fixture();
  const context = await negotiationContext(session);
  assert.equal(context.product?.title, 'Hook shoe');
  assert.equal(JSON.stringify(context).includes('minimumNegotiablePriceMinor'), false);
  assert.equal(JSON.stringify(context).includes('customerId'), false);
});
test('admin notifications require negotiation permission and matching operational scope', () => {
  const access = { permissions: ['ai_negotiation.view'], roleKeys: [], scopeType: ScopeType.SINGLE_STATE, stateIds: ['state_1'], hubIds: [] };
  assert.equal(canReceiveNegotiationAlert(access, 'state_1'), true);
  assert.equal(canReceiveNegotiationAlert(access, 'state_2'), false);
  assert.equal(canReceiveNegotiationAlert({ ...access, permissions: [] }, 'state_1'), false);
  assert.equal(canReceiveNegotiationAlert({ ...access, scopeType: ScopeType.HUB, hubIds: ['hub_1'] }, 'state_1', 'hub_2'), false);
});
test('command leases fence stale writes without leaking execution owners outside execution', async () => {
  assert.deepEqual(negotiationWriteFence(), {});
  await withNegotiationExecution('owner_1', async () => { assert.equal(negotiationWriteFence()['commandLock.owner'], 'owner_1'); });
  assert.deepEqual(negotiationWriteFence(), {});
});
