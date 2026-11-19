import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { Notification } from '../src/models/notifications/notification.model';
import { DeviceToken } from '../src/models/notifications/device-token.model';
import { WebPushSubscription } from '../src/models/notifications/web-push-subscription.model';
import { Market } from '../src/models/platform/network.model';
import { OperationState } from '../src/models/platform/geography.model';
import { Product } from '../src/models/products/product.model';
import { User } from '../src/models/users/user.model';
import { renderNotification, webPathFor } from '../src/notifications/catalog';
import { announceNewProduct } from '../src/modules/notifications/engagement-notifications.service';

process.env.PUSH_ENABLED = 'false';

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

const NOON = new Date('2026-02-10T11:00:00Z');

test('the copy names the Market and the State and says what went live', () => {
  const { title, body } = renderNotification('new_product', { title: 'Ginger Bob Wig', marketName: 'Wuse Market', stateName: 'Federal Capital Territory', price: '₦90,000' });
  assert.equal(title, 'New from Wuse Market, Federal Capital Territory');
  assert.match(body, /Ginger Bob Wig · ₦90,000 just went live/);
});

test('a tapped notification opens the product on the web', () => {
  assert.equal(webPathFor('product', { productId: 'HK-000154' }), '/product/HK-000154');
  assert.equal(webPathFor('order', { orderId: 'ORD-1' }), '/profile/orders/ORD-1');
  assert.equal(webPathFor('product', {}), '/');
});

async function shopper(kind: 'phone' | 'browser' | 'staff') {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, firstName: 'Ada', accountType: kind === 'staff' ? 'staff' : 'customer', createdAt: new Date(), updatedAt: new Date() } as any);
  const userId = String(_id);
  if (kind === 'phone') await DeviceToken.create({ userId, expoPushToken: `ExponentPushToken[${userId}]`, platform: 'ios', isActive: true } as any);
  else await WebPushSubscription.create({ userId, endpoint: `https://push.example/${userId}`, p256dh: 'p', auth: 'a', isActive: true });
  return userId;
}

test('a product going live reaches phones and browsers once, names its Market and State, and ignores staff', async () => {
  const state = await OperationState.collection.insertOne({ _id: new mongoose.Types.ObjectId(), name: 'Federal Capital Territory', publicId: 'ST-FCT', code: 'FCT', createdAt: new Date(), updatedAt: new Date() } as any);
  const market = await Market.collection.insertOne({ _id: new mongoose.Types.ObjectId(), name: 'Wuse Market', stateId: String(state.insertedId), createdAt: new Date(), updatedAt: new Date() } as any);
  const product = await Product.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), publicId: 'HK-000154', title: 'Ginger Bob Wig', status: 'published', publishedAt: NOON,
    marketId: String(market.insertedId), sourceStateId: String(state.insertedId), sellingPriceMinor: 9_000_000, images: ['https://cdn.example/wig.jpg'], createdAt: new Date(), updatedAt: new Date(),
  } as any);
  assert.ok(product.insertedId);
  const phone = await shopper('phone');
  const browser = await shopper('browser');
  await shopper('staff');

  const report = await announceNewProduct('HK-000154', NOON);
  assert.equal(report.sent, 2, 'a phone and a browser, not the staff account');

  const sent = await Notification.find({ type: 'new_product' }).lean() as any[];
  assert.deepEqual(sent.map((item) => item.userId).sort(), [phone, browser].sort());
  assert.equal(sent[0].title, 'New from Wuse Market, Federal Capital Territory');
  assert.equal(sent[0].data.productId, 'HK-000154');

  const again = await announceNewProduct('HK-000154', NOON);
  assert.equal(again.sent, 0, 'announcing the same product twice never repeats it');
});

test('an old product is never re-announced when it is edited', async () => {
  await Product.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), publicId: 'HK-000001', title: 'Old', status: 'published', publishedAt: new Date(NOON.getTime() - 3 * 3_600_000), createdAt: new Date(), updatedAt: new Date(),
  } as any);
  await shopper('phone');
  const report = await announceNewProduct('HK-000001', NOON);
  assert.equal(report.considered, 0);
});
