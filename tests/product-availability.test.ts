import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availabilityWindowEnd, isOnSale, startOfLagosDay } from '../src/lib/product-availability';

// Lagos is UTC+1, so 23:30 UTC on 1 Nov is 00:30 on 2 Nov in Lagos.
test('a confirmation counts from the Lagos day it was made on', () => {
  const lateEvening = new Date('2026-11-01T23:30:00Z');
  assert.equal(startOfLagosDay(lateEvening).toISOString(), '2026-11-01T23:00:00.000Z');
});

test('a one-day window ends with the verification day', () => {
  const verified = new Date('2026-11-02T10:00:00Z');
  assert.equal(availabilityWindowEnd(verified, 1).toISOString(), '2026-11-02T22:59:59.999Z');
});

test('longer windows count the verification day as the first day', () => {
  const verified = new Date('2026-11-02T10:00:00Z');
  assert.equal(availabilityWindowEnd(verified, 4).toISOString(), '2026-11-05T22:59:59.999Z');
});

test('a product is on sale only while live, confirmed and inside its window', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const live = { status: 'published', availabilityStatus: 'available', availabilityValidUntil: new Date('2026-11-02T22:59:59.999Z') };
  assert.equal(isOnSale(live, now), true);
  assert.equal(isOnSale({ ...live, availabilityStatus: 'limited' }, now), true);
  assert.equal(isOnSale({ ...live, availabilityStatus: 'unconfirmed' }, now), false);
  assert.equal(isOnSale({ ...live, status: 'paused' }, now), false);
  assert.equal(isOnSale({ ...live, availabilityValidUntil: new Date('2026-11-02T11:59:00Z') }, now), false);
  assert.equal(isOnSale({ ...live, availabilityValidUntil: undefined }, now), true);
});
