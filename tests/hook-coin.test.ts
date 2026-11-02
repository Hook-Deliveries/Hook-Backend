import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateHookCoinEarnMinor } from '../src/lib/hook-coin';

test('calculates Hook credit from the configured subtotal percentage', () => {
  assert.equal(calculateHookCoinEarnMinor(38_500_00, { percent: 1 }), 38_500);
});

test('honours disabled, zero and capped earning settings', () => {
  assert.equal(calculateHookCoinEarnMinor(50_000_00, { enabled: false, percent: 5 }), 0);
  assert.equal(calculateHookCoinEarnMinor(50_000_00, { percent: 0 }), 0);
  assert.equal(calculateHookCoinEarnMinor(50_000_00, { percent: 5, maxMinor: 100_000 }), 100_000);
});

test('treats a zero cap as unlimited and rejects invalid subtotals', () => {
  assert.equal(calculateHookCoinEarnMinor(10_000_00, { percent: 2, maxMinor: 0 }), 20_000);
  assert.equal(calculateHookCoinEarnMinor(Number.NaN, { percent: 2 }), 0);
  assert.equal(calculateHookCoinEarnMinor(-10, { percent: 2 }), 0);
});
