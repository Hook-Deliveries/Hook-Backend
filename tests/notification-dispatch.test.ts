import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { Notification } from '../src/models/notifications/notification.model';
import { User } from '../src/models/users/user.model';
import { Cart } from '../src/models/cart/cart.model';
import { CartItem } from '../src/models/cart/cart-item.model';
import { Product } from '../src/models/products/product.model';
import { dispatchNotification, getPreferences, isQuietHour, updatePreferences, DEFAULT_PREFERENCES } from '../src/modules/notifications/notification-dispatch.service';
import { scanAbandonedCarts } from '../src/modules/notifications/engagement-notifications.service';

process.env.PUSH_ENABLED = 'false';

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

// 12:00 in Lagos (UTC+1) and 23:00 in Lagos.
const NOON = new Date('2026-02-10T11:00:00Z');
const NIGHT = new Date('2026-02-10T22:00:00Z');
const user = () => User.collection.insertOne({ _id: new mongoose.Types.ObjectId(), firstName: 'Ada', createdAt: new Date(), updatedAt: new Date() } as any).then((result) => String(result.insertedId));

test('quiet hours run 9pm to 8am Lagos time, across midnight', () => {
  const quiet = DEFAULT_PREFERENCES.quietHours;
  assert.equal(isQuietHour(new Date('2026-02-10T20:30:00Z'), quiet), true); // 21:30 Lagos
  assert.equal(isQuietHour(new Date('2026-02-10T06:59:00Z'), quiet), true); // 07:59 Lagos
  assert.equal(isQuietHour(new Date('2026-02-10T07:00:00Z'), quiet), false); // 08:00 Lagos
  assert.equal(isQuietHour(new Date('2026-02-10T11:00:00Z'), quiet), false); // 12:00 Lagos
  assert.equal(isQuietHour(new Date('2026-02-10T20:30:00Z'), { ...quiet, enabled: false }), false);
});

test('an engagement push is deferred in quiet hours, sent by day, and never sent twice for the same event', async () => {
  const userId = await user();
  const send = (now: Date, key = 'evt-1') => dispatchNotification({ type: 'cart_abandoned_1', userId, eventKey: key, params: { title: 'Sneaker', count: 1 }, now });
  assert.equal(await send(NIGHT), 'deferred');
  assert.equal(await Notification.countDocuments({ userId }), 0, 'a deferred notification leaves no trace, so the next run can send it');
  assert.equal(await send(NOON), 'sent');
  assert.equal(await send(NOON), 'suppressed', 'replay of the same event does not send again');
  assert.equal(await Notification.countDocuments({ userId }), 1);
});

test('at most one engagement push a day and three a week', async () => {
  const userId = await user();
  const types = ['cart_abandoned_1', 'negotiation_idle', 'new_products', 'price_drop'];
  const results: string[] = [];
  for (let day = 0; day < 4; day += 1) {
    const now = new Date(NOON.getTime() + day * 24 * 3_600_000);
    results.push(await dispatchNotification({ type: types[day], userId, eventKey: `k-${day}`, now }));
    // A second one the same day is held back.
    assert.equal(await dispatchNotification({ type: 'winback_14', userId, eventKey: `extra-${day}`, now }), 'suppressed');
  }
  assert.deepEqual(results, ['sent', 'sent', 'sent', 'suppressed'], 'the fourth in a week is held back');
});

test('transactional notifications ignore quiet hours and caps', async () => {
  const userId = await user();
  assert.equal(await dispatchNotification({ type: 'cart_abandoned_1', userId, eventKey: 'a', now: NOON }), 'sent');
  assert.equal(await dispatchNotification({ type: 'order_created', userId, eventKey: 'b', params: { title: 'Order placed', body: 'ok' }, now: NIGHT }), 'sent');
  assert.equal(await dispatchNotification({ type: 'order_shipped', userId, eventKey: 'c', now: NIGHT }), 'sent');
});

test('a customer can switch a group off, but not orders or security', async () => {
  const userId = await user();
  await updatePreferences(userId, { groups: { reminders: false } as any });
  assert.equal(await dispatchNotification({ type: 'cart_abandoned_1', userId, eventKey: 'off', now: NOON }), 'disabled');
  const locked = await updatePreferences(userId, { groups: { orders: false } as any });
  assert.equal(locked.groups.orders, true);
  assert.equal((await getPreferences(userId)).groups.reminders, false);
});

test('the abandoned-cart scan reminds once per stage and leaves people who already bought', async () => {
  const userId = await user();
  const productId = new mongoose.Types.ObjectId();
  await Product.collection.insertOne({ _id: productId, title: 'Trail Sneaker', createdAt: new Date(), updatedAt: new Date() } as any);
  const cartId = new mongoose.Types.ObjectId();
  const stale = new Date(NOON.getTime() - 4 * 3_600_000);
  await Cart.collection.insertOne({ _id: cartId, status: 'active', ownerType: 'customer', userId, createdAt: stale, updatedAt: stale } as any);
  await CartItem.collection.insertOne({ _id: new mongoose.Types.ObjectId(), cartId: String(cartId), productId: String(productId), quantity: 1, createdAt: stale, updatedAt: stale } as any);

  const first = await scanAbandonedCarts(NOON);
  assert.equal(first.sent, 1);
  const again = await scanAbandonedCarts(NOON);
  assert.equal(again.sent, 0, 'the same cart is not reminded again for the same stage');
  const note = await Notification.findOne({ userId }).lean();
  assert.match(String(note?.body), /Trail Sneaker/);
  assert.equal((note?.data as any)?.count, 1);
});
