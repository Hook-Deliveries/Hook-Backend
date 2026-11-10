import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductAvailabilityStatus, ProductStatus } from '../src/lib/constants';
import { clampToLive, deriveLiveRules, pricingInputs, resolveQuote } from '../src/modules/negotiation/negotiation-live-rules.service';
import { PricingEngine } from '../src/modules/catalog/pricing-engine.service';

// Prices are integer kobo. List 50,000.00 NGN, floor 40,000.00 NGN.
const product = (over: Record<string, unknown> = {}) => ({
  status: ProductStatus.PUBLISHED,
  availabilityStatus: ProductAvailabilityStatus.AVAILABLE,
  sellingPriceMinor: 5_000_000,
  discountMinor: 0,
  catalogVersion: 4,
  currency: 'NGN',
  negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 },
  ...over,
});

test('deriveLiveRules reads price, floor and sale state', () => {
  const live = deriveLiveRules(product());
  assert.deepEqual(
    { onSale: live.onSale, enabled: live.enabled, effective: live.effectivePriceMinor, floor: live.floorMinor },
    { onSale: true, enabled: true, effective: 5_000_000, floor: 4_000_000 },
  );
});

test('floor is the stricter of the configured minimum and selling minus max discount', () => {
  const live = deriveLiveRules(product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_000_000, maximumDiscountMinor: 500_000 } }));
  assert.equal(live.floorMinor, 4_500_000);
});

test('a discount lowers the effective price but not the floor', () => {
  const live = deriveLiveRules(product({ discountMinor: 300_000 }));
  assert.equal(live.effectivePriceMinor, 4_700_000);
  assert.equal(live.floorMinor, 4_000_000);
});

test('paused, unavailable, deleted or inactive-option products are not on sale', () => {
  assert.equal(deriveLiveRules(product({ status: ProductStatus.PAUSED })).onSale, false);
  assert.equal(deriveLiveRules(product({ availabilityStatus: ProductAvailabilityStatus.UNCONFIRMED })).onSale, false);
  assert.equal(deriveLiveRules(product({ deletedAt: new Date() })).onSale, false);
  assert.equal(deriveLiveRules(product(), false).onSale, false);
  assert.equal(deriveLiveRules(product({ availabilityValidUntil: new Date(Date.now() - 1000) })).onSale, false);
  assert.equal(deriveLiveRules(null).onSale, false);
});

test('negotiation is disabled when rules are off or incomplete', () => {
  assert.equal(deriveLiveRules(product({ negotiationRules: { enabled: false, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 } })).enabled, false);
  assert.equal(deriveLiveRules(product({ negotiationRules: { enabled: true, maximumDiscountMinor: 1_000_000 } })).enabled, false);
  assert.equal(deriveLiveRules(product({ negotiationRules: undefined })).enabled, false);
});

test('quote: unchanged product keeps the agreed price', () => {
  assert.deepEqual(resolveQuote(4_300_000, deriveLiveRules(product())), { valid: true, unitPriceMinor: 4_300_000 });
});

test('quote: unrelated version bump does not touch the quote', () => {
  const live = deriveLiveRules(product({ catalogVersion: 99 }));
  assert.deepEqual(resolveQuote(4_300_000, live), { valid: true, unitPriceMinor: 4_300_000 });
});

test('quote: customer pays the lower of agreed and a dropped list price', () => {
  const live = deriveLiveRules(product({ sellingPriceMinor: 4_200_000, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 3_500_000, maximumDiscountMinor: 700_000 } }));
  assert.deepEqual(resolveQuote(4_300_000, live), { valid: true, unitPriceMinor: 4_200_000, reason: 'PRICE_DROPPED' });
});

test('quote: a raised list price never raises the agreed price', () => {
  const live = deriveLiveRules(product({ sellingPriceMinor: 6_000_000, negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 2_000_000 } }));
  assert.deepEqual(resolveQuote(4_300_000, live), { valid: true, unitPriceMinor: 4_300_000 });
});

test('quote: voided when the floor rises above the agreed price', () => {
  const live = deriveLiveRules(product({ negotiationRules: { enabled: true, minimumNegotiablePriceMinor: 4_400_000, maximumDiscountMinor: 600_000 } }));
  assert.deepEqual(resolveQuote(4_300_000, live), { valid: false, reason: 'FLOOR_RAISED' });
});

test('quote: voided when paused or when negotiation is switched off', () => {
  assert.deepEqual(resolveQuote(4_300_000, deriveLiveRules(product({ status: ProductStatus.PAUSED }))), { valid: false, reason: 'PRODUCT_UNAVAILABLE' });
  const off = deriveLiveRules(product({ negotiationRules: { enabled: false, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000 } }));
  assert.deepEqual(resolveQuote(4_300_000, off), { valid: false, reason: 'NEGOTIATION_DISABLED' });
});

test('pricingInputs feeds the engine the effective price and never a floor above it', () => {
  const live = deriveLiveRules(product({ discountMinor: 300_000 }));
  const inputs = pricingInputs(live);
  assert.equal(inputs.sellingPriceMinor, 4_700_000);
  assert.equal(inputs.minimumNegotiablePriceMinor, 4_000_000);
  assert.equal(inputs.maximumDiscountMinor, 700_000);
  assert.equal(inputs.needed, true);
});

test('pricingInputs reports nothing to negotiate when the list price is at the floor', () => {
  const inputs = pricingInputs(deriveLiveRules(product({ discountMinor: 1_000_000 })));
  assert.equal(inputs.needed, false);
  assert.equal(inputs.minimumNegotiablePriceMinor, inputs.sellingPriceMinor);
});

test('clampToLive pulls stored prices inside the live band and ignores zero', () => {
  const live = deriveLiveRules(product());
  assert.equal(clampToLive(3_000_000, live), 4_000_000);
  assert.equal(clampToLive(9_000_000, live), 5_000_000);
  assert.equal(clampToLive(4_500_000, live), 4_500_000);
  assert.equal(clampToLive(0, live), 0);
});

// PricingEngine boundaries (the deterministic core the model never sees).
const engine = new PricingEngine();
const base = { sellingPriceMinor: 5_000_000, minimumNegotiablePriceMinor: 4_000_000, maximumDiscountMinor: 1_000_000, maximumOffers: 3, currency: 'NGN' };

test('engine: counters early, accepts at the round boundary, declines a low final offer', () => {
  // Round thresholds: 4,666,667 -> 4,333,334 -> 4,000,000 (floor on the last round).
  const first = engine.decide({ ...base, customerOfferMinor: 4_000_000, offerNumber: 1 });
  assert.equal(first.decision, 'COUNTER');
  assert.equal(first.counterPriceMinor, 4_666_667);
  assert.equal(engine.decide({ ...base, customerOfferMinor: 4_700_000, offerNumber: 1 }).decision, 'ACCEPT');
  assert.equal(engine.decide({ ...base, customerOfferMinor: 3_999_999, offerNumber: 3 }).decision, 'DECLINE');
  assert.equal(engine.decide({ ...base, customerOfferMinor: 4_000_000, offerNumber: 3 }).decision, 'ACCEPT');
});

test('engine: never accepts above the list price and rejects bad input', () => {
  const accepted = engine.decide({ ...base, customerOfferMinor: 9_000_000, offerNumber: 1 });
  assert.equal(accepted.acceptedPriceMinor, 5_000_000);
  assert.throws(() => engine.decide({ ...base, customerOfferMinor: 1.5, offerNumber: 1 }), /integer minor units/);
  assert.throws(() => engine.decide({ ...base, customerOfferMinor: 4_000_000, offerNumber: 4 }), /offer limit/i);
  assert.throws(() => engine.decide({ ...base, currency: 'USD', customerOfferMinor: 4_000_000, offerNumber: 1 }), /currency/);
});

test('engine: a repeated or lower offer does not move the counter', () => {
  const next = engine.decide({
    ...base,
    customerOfferMinor: 4_000_000,
    offerNumber: 2,
    previousCustomerOfferMinor: 4_000_000,
    previousCounterPriceMinor: 4_666_667,
  });
  assert.equal(next.decision, 'COUNTER');
  assert.equal(next.counterPriceMinor, 4_666_667);
  // A repeated offer that already meets the round's price is accepted; one that falls short on the last round is declined.
  assert.equal(engine.decide({ ...base, customerOfferMinor: 4_000_000, offerNumber: 3, previousCustomerOfferMinor: 4_000_000 }).decision, 'ACCEPT');
  const last = engine.decide({ ...base, customerOfferMinor: 3_900_000, offerNumber: 3, previousCustomerOfferMinor: 3_900_000 });
  assert.equal(last.decision, 'DECLINE');
});
