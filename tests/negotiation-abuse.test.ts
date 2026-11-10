import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { NegotiatedQuote } from '../src/models/catalog/catalog.model';
import { Negotiation } from '../src/models/negotiations/negotiation.model';
import { assertMayStartNegotiation, evaluateAttempts } from '../src/modules/negotiation/negotiation-abuse.service';
import { resetDatabase, startDatabase, stopDatabase } from './helpers/replset';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-11-09T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const limits = { cooldownMinutes: 30, maxSessionsPerDay: 3 };

test('no earlier attempts means the customer can start', () => {
  assert.deepEqual(evaluateAttempts([], limits, NOW), { blocked: false });
});

test('a recent attempt blocks until the cooldown has passed', () => {
  const verdict = evaluateAttempts([{ endedAt: ago(10 * MINUTE) }], limits, NOW);
  assert.deepEqual(verdict, { blocked: true, reason: 'COOLDOWN', retryAfterSeconds: 20 * 60 });
  assert.deepEqual(evaluateAttempts([{ endedAt: ago(31 * MINUTE) }], limits, NOW), { blocked: false });
});

test('a cooldown of zero turns the wait off', () => {
  assert.deepEqual(evaluateAttempts([{ endedAt: ago(MINUTE) }], { cooldownMinutes: 0, maxSessionsPerDay: 3 }, NOW), { blocked: false });
});

test('the daily limit blocks until the oldest attempt leaves the 24 hour window', () => {
  const attempts = [{ endedAt: ago(2 * HOUR) }, { endedAt: ago(5 * HOUR) }, { endedAt: ago(20 * HOUR) }];
  const verdict = evaluateAttempts(attempts, limits, NOW);
  // The 20-hour-old attempt frees a slot in 4 hours.
  assert.deepEqual(verdict, { blocked: true, reason: 'DAILY_LIMIT', retryAfterSeconds: 4 * 60 * 60 });
});

test('attempts older than a day never count', () => {
  const attempts = [{ endedAt: ago(25 * HOUR) }, { endedAt: ago(30 * HOUR) }, { endedAt: ago(40 * HOUR) }, { endedAt: ago(50 * HOUR) }];
  assert.deepEqual(evaluateAttempts(attempts, limits, NOW), { blocked: false });
});

test('two attempts under the limit are fine once the cooldown is over', () => {
  assert.deepEqual(evaluateAttempts([{ endedAt: ago(3 * HOUR) }, { endedAt: ago(2 * HOUR) }], limits, NOW), { blocked: false });
});

// ── Persistence ──────────────────────────────────────────────────────────────────────────
const PRODUCT = '64b0000000000000000000a1';
const VARIANT = '64b0000000000000000000b1';
const key = { customerId: 'customer_1', productId: PRODUCT, variantId: VARIANT };

before(async () => {
  await startDatabase();
  await Negotiation.init();
});
after(stopDatabase);
afterEach(resetDatabase);

let counter = 0;
function session(over: Record<string, unknown> = {}) {
  counter += 1;
  return Negotiation.create({
    publicId: `neg_ab_${counter}`, ...key, quantity: 1, currency: 'NGN', status: 'closed', offerCount: 2,
    maximumOffers: 3, version: 2, transcript: [], ...over,
  });
}

test('a customer who just finished negotiating this item is asked to wait', async () => {
  await session();
  await assert.rejects(assertMayStartNegotiation('customer_1', PRODUCT, VARIANT, limits), (error: any) => {
    assert.equal(error.code, 'NEGOTIATION_COOLDOWN');
    assert.equal(error.statusCode, 429);
    assert.ok(error.details.retryAfterSeconds > 0);
    return true;
  });
});

test('other customers and other items are not affected', async () => {
  await session();
  await assertMayStartNegotiation('customer_2', PRODUCT, VARIANT, limits);
  await assertMayStartNegotiation('customer_1', PRODUCT, '64b0000000000000000000b2', limits);
});

test('sessions that were not the customer\'s doing never count', async () => {
  await session({ offerCount: 0 }); // browsed, never made an offer
  await session({ endReason: 'PRODUCT_UNAVAILABLE' }); // the product went off sale
  await session({ initiatingPartnerId: 'partner_1' }); // a Partner at the counter
  const cancelledQuote = await NegotiatedQuote.create({
    publicId: 'quo_ab_1', negotiationId: 'n1', customerId: 'customer_1', productId: PRODUCT, variantId: VARIANT, quantity: 1,
    currency: 'NGN', originalPriceMinor: 5_000_000, agreedPriceMinor: 4_300_000, expiresAt: new Date(Date.now() + HOUR),
    status: 'cancelled', voidReason: 'FLOOR_RAISED',
  });
  await session({ status: 'agreed', quoteId: String(cancelledQuote._id) }); // the price was cancelled by an admin change
  await assertMayStartNegotiation('customer_1', PRODUCT, VARIANT, limits);
});

test('a live session is not counted as an attempt', async () => {
  await session({ status: 'active' });
  await assertMayStartNegotiation('customer_1', PRODUCT, VARIANT, limits);
});

test('the database refuses a second live session for the same item and quantity', async () => {
  await session({ status: 'active' });
  await assert.rejects(session({ status: 'active' }), (error: any) => error.code === 11000);
  // A different quantity, a Partner's session, or a finished session are all fine.
  await session({ status: 'active', quantity: 2 });
  await session({ status: 'active', initiatingPartnerId: 'partner_1' });
  await session({ status: 'closed' });
});
