import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { commerceCartItemSchema } from '../src/validations/commerce.schemas';
import { ensureLegacyProductOptions } from '../src/modules/catalog/legacy-product-options.service';
import { legacyProductOptions } from '../src/lib/legacy-product-options';
import { ProductVariant } from '../src/models/catalog/catalog.model';
afterEach(() => mock.restoreAll());
test('cart accepts the reported legacy option payload', () => {
  assert.equal(commerceCartItemSchema.safeParse({ productId: 'PRD-2026-000086', variantId: 'legacy_opt_1e796bd152aa9d8431f08134e4025941', quantity: 2, selectedVariants: { color: '#FFFFFF', size: '45' } }).success, true);
  assert.equal(commerceCartItemSchema.safeParse({ productId: 'PRD-2026-000086', variantId: 'legacy_opt_invalid_identifier_that_is_too_long', quantity: 2 }).success, false);
});
test('direct cart materializes only product-defined legacy options', async () => {
  const product = { _id: 'product', colors: ['#FFFFFF'], sizes: ['45', '46'] };
  mock.method(ProductVariant, 'exists', async () => null);
  const write = mock.method(ProductVariant, 'bulkWrite', async () => ({}));
  await ensureLegacyProductOptions(product, legacyProductOptions(product)[0].publicId);
  assert.equal(write.mock.callCount(), 1);
  await assert.rejects(ensureLegacyProductOptions(product, `legacy_opt_${'0'.repeat(32)}`), /options changed/);
  assert.equal(write.mock.callCount(), 1);
});
test('already materialized legacy options do not rewrite the option grid', async () => {
  const product = { _id: 'product', colors: ['#FFFFFF'], sizes: ['45', '46'] };
  const exists = mock.method(ProductVariant, 'exists', async () => ({ _id: 'existing' }));
  const write = mock.method(ProductVariant, 'bulkWrite', async () => ({}));
  await ensureLegacyProductOptions(product, legacyProductOptions(product)[0].publicId);
  assert.equal(exists.mock.callCount(), 1);
  assert.equal(write.mock.callCount(), 0);
  await assert.rejects(ensureLegacyProductOptions(product, `legacy_opt_${'0'.repeat(32)}`), /options changed/);
});
