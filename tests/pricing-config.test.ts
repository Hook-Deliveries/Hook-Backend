import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pricingConfigSchema } from '../src/validations/commerce.schemas';

test('a pricing change needs a reason and only known fields', () => {
  assert.throws(() => pricingConfigSchema.parse({ vatRatePercent: 7.5 }));
  assert.throws(() => pricingConfigSchema.parse({ vatRatePercent: 7.5, reason: 'ok', mystery: 1 }));
  const parsed = pricingConfigSchema.parse({ vatRatePercent: 7.5, defaultDeliveryFeeMinor: 300_000, reason: 'Annual review' });
  assert.equal(parsed.defaultDeliveryFeeMinor, 300_000);
});

test('VAT stays sensible and unknown fields are rejected', () => {
  assert.throws(() => pricingConfigSchema.parse({ vatRatePercent: 45, reason: 'invalid vat' }));
  assert.throws(() => pricingConfigSchema.parse({ legacyFlag: true, reason: 'not a pricing field' }));
});
