import assert from 'node:assert/strict';
import { after, afterEach, before, mock, test } from 'node:test';
import { defaultPicks, percentOff, suggestionCandidates, unitFromTotal, validateOffer } from '../src/lib/negotiation-offer-rules';
import { Cart } from '../src/models/cart/cart.model';
import { ProductVariant } from '../src/models/catalog/catalog.model';
import { CommerceSettings } from '../src/models/commerce/commerce.model';
import { Negotiation } from '../src/models/negotiations/negotiation.model';
import { LegalContent } from '../src/models/platform/legal-content.model';
import { Product } from '../src/models/products/product.model';
import { User } from '../src/models/users/user.model';
import { AzureNegotiationService, negotiationUnavailable, validateSuggestionPicks } from '../src/modules/negotiation/azure-negotiation.service';
import { clearOfferFlowCache, NegotiationOfferFlowService } from '../src/modules/negotiation/negotiation-offer-flow.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

// List ₦49,000 each, lowest price Hook accepts ₦43,000 each, 2 items. Amounts are integer kobo.
const LIST = 4_900_000;
const FLOOR = 4_300_000;

// ── Pure rules ───────────────────────────────────────────────────────────────────────────
test('suggestions sit between the floor and the list price and never reach the floor', () => {
  const found = suggestionCandidates({ listUnitMinor: LIST, floorUnitMinor: FLOOR, quantity: 2 });
  assert.ok(found.length >= 3);
  for (const suggestion of found) {
    assert.ok(suggestion.unitMinor < LIST, 'a real saving');
    assert.ok(suggestion.unitMinor > FLOOR, 'never at or below the floor');
    assert.equal(suggestion.totalMinor, suggestion.unitMinor * 2);
    assert.equal(suggestion.unitMinor % 50_000, 0, 'rounded to whole ₦500');
  }
  assert.deepEqual(found.map((s) => s.unitMinor), [...found].map((s) => s.unitMinor).sort((a, b) => b - a));
  // The deepest suggestion stops short of the floor: it never reveals where the floor is.
  assert.ok(Math.min(...found.map((s) => s.unitMinor)) >= FLOOR + (LIST - FLOOR) * 0.25 - 50_000);
});

test('after a counter, suggestions fall between the customer\'s last offer and Hook\'s counter', () => {
  const found = suggestionCandidates({ listUnitMinor: LIST, floorUnitMinor: FLOOR, quantity: 2, counterUnitMinor: 4_600_000, previousBestUnitMinor: 4_400_000 });
  assert.ok(found.length > 0);
  for (const suggestion of found) {
    assert.ok(suggestion.unitMinor < 4_600_000);
    assert.ok(suggestion.unitMinor > 4_400_000);
  }
});

test('with no room left there are no suggestions', () => {
  assert.deepEqual(suggestionCandidates({ listUnitMinor: LIST, floorUnitMinor: LIST, quantity: 1 }), []);
});

test('picks are spread across the candidates, and totals convert to per-item prices', () => {
  assert.deepEqual(defaultPicks([1, 2, 3, 4, 5]), [1, 3, 5]);
  assert.deepEqual(defaultPicks([1, 2]), [1, 2]);
  assert.equal(unitFromTotal(8_800_000, 2), 4_400_000);
  assert.equal(percentOff(4_410_000, LIST), 10);
});

test('offer rules: below list, serious, below the counter, above the last offer', () => {
  const base = { listUnitMinor: LIST, quantity: 2 };
  assert.equal(validateOffer({ ...base, unitMinor: LIST })?.code, 'OFFER_NOT_BELOW_LIST');
  assert.equal(validateOffer({ ...base, unitMinor: 1_000_000 })?.code, 'OFFER_TOO_LOW');
  assert.equal(validateOffer({ ...base, unitMinor: 4_700_000, counterUnitMinor: 4_600_000 })?.code, 'OFFER_ABOVE_COUNTER');
  assert.equal(validateOffer({ ...base, unitMinor: 4_400_000, previousBestUnitMinor: 4_400_000 })?.code, 'OFFER_NOT_HIGHER');
  assert.equal(validateOffer({ ...base, unitMinor: 4_500_000, counterUnitMinor: 4_600_000, previousBestUnitMinor: 4_400_000 }), undefined);
  assert.match(validateOffer({ ...base, unitMinor: LIST })!.message, /for 2 items/);
});

test('the AI\'s picks are only accepted when they are three distinct known candidates with clean notes', () => {
  const ok = { picks: [{ index: 0, note: 'A modest ask for a hand-woven bag' }, { index: 2 }, { index: 4, note: 'Bold but fair' }] };
  assert.deepEqual(validateSuggestionPicks(ok, [0, 1, 2, 3, 4])?.map((p) => p.index), [0, 2, 4]);
  assert.equal(validateSuggestionPicks({ picks: [{ index: 0 }, { index: 0 }, { index: 2 }] }, [0, 1, 2, 3, 4]), undefined, 'duplicates');
  assert.equal(validateSuggestionPicks({ picks: [{ index: 9 }, { index: 1 }, { index: 2 }] }, [0, 1, 2, 3, 4]), undefined, 'unknown index');
  assert.equal(validateSuggestionPicks({ picks: [{ index: 0 }, { index: 1 }] }, [0, 1, 2, 3, 4]), undefined, 'wrong count');
  assert.equal(validateSuggestionPicks({ picks: [{ index: 0, note: 'Only ₦40,000 will do' }, { index: 1 }, { index: 2 }] }, [0, 1, 2, 3, 4]), undefined, 'money in a note');
  assert.equal(validateSuggestionPicks({ picks: [{ index: 0, note: 'Hook will definitely accept this' }, { index: 1 }, { index: 2 }] }, [0, 1, 2, 3, 4]), undefined, 'a promise');
  assert.equal(validateSuggestionPicks({ picks: [{ index: 0, note: 'Above our price floor' }, { index: 1 }, { index: 2 }] }, [0, 1, 2, 3, 4]), undefined, 'pricing talk');
});

// ── Flow service (real persistence, stubbed product and AI) ──────────────────────────────
const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION'];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const PRODUCT_ID = '64b0000000000000000000a1';
const VARIANT_ID = '64b0000000000000000000b1';
const customer = { customerId: 'customer_1' };

before(startDatabase);
after(stopDatabase);
afterEach(async () => {
  clearOfferFlowCache();
  mock.restoreAll();
  for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await resetDatabase();
});

function world(opts: { suggest?: 'ai' | 'down'; wording?: 'ok' | 'down' } = {}) {
  for (const key of keys) process.env[key] = 'unit-test';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://hook-unit.openai.azure.com';
  const product = {
    _id: PRODUCT_ID, publicId: 'PRD-1', title: 'Woven Rattan Handbag', description: 'Hand-woven rattan bag', status: 'published', availabilityStatus: 'available',
    sellingPriceMinor: LIST, discountMinor: 0, catalogVersion: 3, currency: 'NGN',
    negotiationRules: { enabled: true, minimumNegotiablePriceMinor: FLOOR, maximumDiscountMinor: LIST - FLOOR },
  };
  mock.method(CommerceSettings, 'findOne', () => ({ select: () => ({ lean: async () => ({}) }), lean: async () => ({}) }));
  mock.method(Product, 'findById', () => ({ select: () => ({ lean: async () => product }), lean: async () => product }));
  mock.method(Product, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  mock.method(ProductVariant, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: VARIANT_ID }) }) }));
  mock.method(ProductVariant, 'findById', () => ({ select: () => ({ lean: async () => ({ publicId: 'VAR-1' }) }) }));
  for (const model of [ProductVariant, LegalContent]) mock.method(model, 'find', () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  mock.method(Cart, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const suggest = mock.method(AzureNegotiationService.prototype, 'suggestOffers', async (ctx: any) => {
    if (opts.suggest === 'down') throw negotiationUnavailable();
    return [{ index: 0, note: 'A gentle ask' }, { index: Math.floor((ctx.candidates.length - 1) / 2), note: 'A fair middle' }, { index: ctx.candidates.length - 1, note: 'A bolder ask' }];
  });
  mock.method(AzureNegotiationService.prototype, 'phrase', async () => {
    if (opts.wording === 'down') throw negotiationUnavailable();
    return { message: 'Okay.', telemetry: { provider: 'azure_openai' }, fallbackUsed: false };
  });
  return { suggest };
}

function session(over: Record<string, unknown> = {}) {
  return Negotiation.create({
    publicId: 'neg_flow_1', customerId: 'customer_1', channel: 'shopper', productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 2,
    currency: 'NGN', status: 'active', offerCount: 0, maximumOffers: 3, transcript: [], version: 1,
    rulesSnapshot: { priceBasis: 'effective', sellingPriceMinor: LIST, minimumNegotiablePriceMinor: FLOOR, maximumDiscountMinor: LIST - FLOOR, maximumOffers: 3, quoteMinutes: 30, azureWordingEnabled: true },
    ...over,
  });
}

test('the flow shows totals for the whole quantity, three suggestions and the rounds left', async () => {
  world();
  await session();
  const flow = await new NegotiationOfferFlowService().flow(customer, 'neg_flow_1');
  assert.equal(flow.quantity, 2);
  assert.equal(flow.listTotalMinor, LIST * 2);
  assert.equal(flow.remainingOffers, 3);
  assert.equal(flow.round, 1);
  assert.equal(flow.suggestions.length, 3);
  for (const suggestion of flow.suggestions) {
    assert.equal(suggestion.totalMinor, suggestion.unitMinor * 2);
    assert.ok(suggestion.note);
  }
  assert.equal(flow.maxTotalMinor, LIST * 2);
  assert.equal(flow.minTotalMinor, Math.ceil(LIST * 0.5) * 2);
  assert.equal(JSON.stringify(flow).includes(String(FLOOR)), false, 'the floor is never in the payload');
});

test('if the AI is unavailable the same three evenly spread suggestions are shown', async () => {
  world({ suggest: 'down' });
  await session();
  const flow = await new NegotiationOfferFlowService().flow(customer, 'neg_flow_1');
  assert.equal(flow.suggestions.length, 3);
  assert.equal(flow.suggestions.every((s) => s.note === undefined), true);
});

test('the AI is asked once per session state, not on every refresh', async () => {
  const { suggest } = world();
  await session();
  const service = new NegotiationOfferFlowService();
  await service.flow(customer, 'neg_flow_1');
  await service.flow(customer, 'neg_flow_1');
  assert.equal(suggest.mock.callCount(), 1);
});

test('an offer is made as a total and answered with totals', async () => {
  world();
  await session();
  const outcome = await new NegotiationOfferFlowService().submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0001');
  assert.equal(outcome.result.offerTotalMinor, 8_800_000);
  assert.equal(outcome.result.decision, 'COUNTER');
  // Round 1 of 3 on a ₦6,000 range: Hook counters at ₦47,000 each = ₦94,000 for both.
  assert.equal(outcome.result.counterTotalMinor, 9_400_000);
  assert.equal(outcome.flow.counter?.totalMinor, 9_400_000);
  assert.equal(outcome.flow.remainingOffers, 2);
  assert.equal(outcome.flow.history.length, 1);
  assert.deepEqual({ offer: outcome.flow.history[0].offerTotalMinor, counter: outcome.flow.history[0].counterTotalMinor }, { offer: 8_800_000, counter: 9_400_000 });
  assert.equal(outcome.flow.maxTotalMinor, 9_400_000, 'the next offer must be below Hook\'s counter');
});

test('an accepted total is locked straight away at the per-item price', async () => {
  world();
  await session();
  mock.method(User, 'findOne', () => ({ lean: async () => ({ _id: 'customer_1' }) }));
  const outcome = await new NegotiationOfferFlowService().submitTotal(customer, 'neg_flow_1', 9_400_000, 'offer-flow-0002');
  assert.equal(outcome.result.decision, 'ACCEPT');
  assert.equal(outcome.result.acceptedTotalMinor, 9_400_000);
  assert.equal(outcome.flow.status, 'agreed');
  assert.equal(outcome.flow.locked?.totalMinor, 9_400_000);
  assert.equal(outcome.flow.locked?.unitMinor, 4_700_000);
  assert.equal(outcome.flow.locked?.savingsTotalMinor, 400_000);
});

test('if the lock cannot be made the accepted offer is still reported, with the reason', async () => {
  world();
  await session();
  mock.method(User, 'findOne', () => ({ lean: async () => null }));
  const outcome = await new NegotiationOfferFlowService().submitTotal(customer, 'neg_flow_1', 9_400_000, 'offer-flow-0011');
  assert.equal(outcome.result.decision, 'ACCEPT');
  assert.ok(outcome.result.lockError);
  assert.equal(outcome.flow.status, 'active');
});

test('rejected offers never use up a round', async () => {
  world();
  await session();
  const service = new NegotiationOfferFlowService();
  await assert.rejects(service.submitTotal(customer, 'neg_flow_1', 9_800_000, 'offer-flow-0003'), { code: 'OFFER_NOT_BELOW_LIST' });
  await assert.rejects(service.submitTotal(customer, 'neg_flow_1', 2_000_000, 'offer-flow-0004'), { code: 'OFFER_TOO_LOW' });
  assert.equal((await Negotiation.findOne({ publicId: 'neg_flow_1' }).lean())?.offerCount, 0);
  await service.submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0005');
  await assert.rejects(service.submitTotal(customer, 'neg_flow_1', 9_600_000, 'offer-flow-0006'), { code: 'OFFER_ABOVE_COUNTER' });
  await assert.rejects(service.submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0007'), { code: 'OFFER_NOT_HIGHER' });
  assert.equal((await Negotiation.findOne({ publicId: 'neg_flow_1' }).lean())?.offerCount, 1);
});

test('retrying the same offer with the same key does not spend another round', async () => {
  world();
  await session();
  const service = new NegotiationOfferFlowService();
  await service.submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0008');
  await service.submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0008').catch(() => undefined);
  assert.equal((await Negotiation.findOne({ publicId: 'neg_flow_1' }).lean())?.offerCount, 1);
});

test('an offer still works, with fixed wording, when the AI provider is down', async () => {
  world({ wording: 'down', suggest: 'down' });
  await session();
  const outcome = await new NegotiationOfferFlowService().submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0009');
  assert.equal(outcome.result.decision, 'COUNTER');
  assert.equal(outcome.result.providerFallback, true);
  assert.match(outcome.result.message || '', /₦94,000/);
});

test('an offer on a negotiation that already ended is refused', async () => {
  world();
  await session({ status: 'closed' });
  await assert.rejects(new NegotiationOfferFlowService().submitTotal(customer, 'neg_flow_1', 8_800_000, 'offer-flow-0010'), { code: 'INVALID_STATE_TRANSITION' });
});
