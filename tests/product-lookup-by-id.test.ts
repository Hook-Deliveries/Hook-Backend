import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { Product } from '../src/models/products/product.model';
import { onSaleFilter, withOnSale } from '../src/lib/product-availability';
import { startDatabase, stopDatabase } from './helpers/replset';

/**
 * Regression: spreading an id lookup ({ $or: [_id, publicId] }) and onSaleFilter() (which has its own $or) into one
 * query silently dropped the id lookup, so the cart could add a DIFFERENT on-sale product than the one asked for.
 */
before(startDatabase);
after(stopDatabase);

const onSale = { status: 'published', availabilityStatus: 'available' };

test('looking a product up by _id or publicId and on-sale returns that product, not any on-sale product', async () => {
  const first = new mongoose.Types.ObjectId();
  const second = new mongoose.Types.ObjectId();
  await Product.collection.insertMany([
    { _id: first, publicId: 'PRD-A', title: 'First', ...onSale },
    { _id: second, publicId: 'PRD-B', title: 'Second', ...onSale },
  ] as never);
  const byObjectId = { $or: [{ _id: second.toString() }, { publicId: second.toString() }] };

  const wrong = await Product.findOne({ ...byObjectId, ...onSaleFilter() } as never).lean<{ title: string }>();
  assert.equal(wrong?.title, 'First', 'the unsafe spread really did pick the wrong product');

  const right = await Product.findOne({ ...withOnSale(byObjectId) } as never).lean<{ title: string }>();
  assert.equal(right?.title, 'Second');
  const byPublicId = await Product.findOne(withOnSale({ publicId: 'PRD-B' }) as never).lean<{ title: string }>();
  assert.equal(byPublicId?.title, 'Second');
});

test('a product that is off sale is not returned even when asked for by id', async () => {
  const paused = new mongoose.Types.ObjectId();
  await Product.collection.insertOne({ _id: paused, publicId: 'PRD-C', title: 'Paused', status: 'paused', availabilityStatus: 'available' } as never);
  const found = await Product.findOne(withOnSale({ $or: [{ _id: paused.toString() }, { publicId: paused.toString() }] }) as never).lean();
  assert.equal(found, null);
});
