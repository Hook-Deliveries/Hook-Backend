import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyProductOptions } from '../src/lib/legacy-product-options';

test('legacy colours and sizes have stable, product-scoped IDs', () => {
  const product = { _id: 'product1', colors: ['Black', 'White', 'Black'], sizes: ['40', '41'] };
  const options = legacyProductOptions(product);
  assert.equal(options.length, 4);
  assert.equal(new Set(options.map((option) => option.publicId)).size, 4);
  assert.deepEqual(legacyProductOptions(product), options);
  assert.notEqual(legacyProductOptions({ ...product, _id: 'product2' })[0].publicId, options[0].publicId);
  assert.deepEqual(legacyProductOptions({ _id: 'empty' }), []);
});
