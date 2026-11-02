import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commerceCartItemSchema, commerceImportSchema, selectedVariantsSchema } from '../src/validations/commerce.schemas';

/**
 * A powerbank's options are capacity and colour; a wig's are length and texture. The cart and the guest-cart
 * import must accept them, not only colour and size.
 */
test('the cart accepts any option a category asks for', () => {
  const parsed = commerceCartItemSchema.parse({ productId: 'PRD-2026-000001', quantity: 1, variantId: 'VAR-2026-000001', selectedVariants: { color: 'Black', capacity: '10,000 mAh' } });
  assert.equal(parsed.selectedVariants?.capacity, '10,000 mAh');
  const wig = commerceCartItemSchema.parse({ productId: 'PRD-2026-000002', quantity: 1, selectedVariants: { length: '18"', texture: 'Body wave', color: 'Blonde' } });
  assert.equal(wig.selectedVariants?.texture, 'Body wave');
});

test('a guest cart with one option-heavy line still imports as a whole', () => {
  const parsed = commerceImportSchema.parse({
    schemaVersion: 1,
    cartItems: [
      { clientLineId: 'a', productId: 'PRD-2026-000001', quantity: 1, selectedVariants: { phoneModel: 'iPhone 15 Pro', color: 'Black' } },
      { clientLineId: 'b', productId: 'PRD-2026-000002', quantity: 2, selectedVariants: { color: 'Red', size: '42' } },
    ],
    likedProductIds: [],
  });
  assert.equal(parsed.cartItems.length, 2);
});

test('option keys must be plain names and values short', () => {
  assert.throws(() => selectedVariantsSchema.parse({ 'bad key!': 'x' }));
  assert.throws(() => selectedVariantsSchema.parse({ capacity: 'x'.repeat(81) }));
  assert.throws(() => selectedVariantsSchema.parse(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']))));
});
