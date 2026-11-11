import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { notifyStaffByPermission, syncStaffNotifications } from '../src/modules/notifications/staff-notifications.service';
import { Notification } from '../src/models/notifications/notification.model';
import { StaffNotificationCursor } from '../src/models/notifications/staff-notification-cursor.model';
import { Order } from '../src/models/orders/order.model';
import { Payment } from '../src/models/payments/payment.model';
import { User } from '../src/models/users/user.model';
import { FulfilmentRefund, FulfilmentTask, Shipment } from '../src/models/fulfilment/fulfilment.model';

import { Role } from '../src/models/platform/access.model';
import { StaffProfile } from '../src/models/platform/operations-accounts.model';

const id = () => new mongoose.Types.ObjectId();
type Grant = { permissions?: string[]; superAdmin?: boolean; scopeType?: 'global' | 'state'; stateIds?: string[] };

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

/** A real staff account with a role carrying exactly these permissions, so the real permission lookup decides. */
async function staff(name: string, grant: Grant) {
  const _id = id();
  const roleId = id();
  await User.collection.insertOne({ _id, accountType: 'staff', role: grant.superAdmin ? 'super_admin' : 'admin', isActive: true, email: `${name}@hook.test`, firstName: name, permissions: [] });
  await Role.collection.insertOne({ _id: roleId, key: `ROLE_${name}`, name, isActive: true, permissionKeys: grant.permissions || [] });
  await StaffProfile.collection.insertOne({ _id: id(), publicId: `STF-${name}`, accountId: String(_id), roleIds: [String(roleId)], scopeType: grant.scopeType || 'global', stateIds: grant.stateIds || [], hubIds: [], status: 'active' });
  return String(_id);
}
const grantLater = (name: string, permissions: string[]) => Role.collection.updateOne({ key: `ROLE_${name}` }, { $set: { permissionKeys: permissions } });

async function paidOrder(publicId: string, stateId: string, paidAt = new Date()) {
  const orderId = id();
  await Order.collection.insertOne({ _id: orderId, publicId, userId: 'u', commerceStatus: 'IN_FULFILMENT', commercePaymentStatus: 'CONFIRMED', totalMinor: 1_300_000, sourceStateId: stateId, addressSnapshot: { cityName: 'Ibadan', stateName: 'Oyo' }, createdAt: paidAt, updatedAt: paidAt });
  await Payment.collection.insertOne({ _id: id(), publicId: `PAY-${publicId}`, orderId: String(orderId), commerceStatus: 'CONFIRMED', paidAt, createdAt: paidAt });
}

const mine = (accountId: string) => Notification.find({ userId: accountId }).sort({ createdAt: -1 }).lean() as Promise<any[]>;

test('an admin who missed a paid order is sent it, once, with the time it was paid', async () => {
  const paidAt = new Date(Date.now() - 3 * 3600_000);
  await paidOrder('ORD-1', 'oyo', paidAt);
  const admin = await staff('boss', { superAdmin: true });
  await syncStaffNotifications(admin, { force: true });
  const rows = await mine(admin);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'New paid order');
  assert.match(rows[0].body, /ORD-1 · ₦13,000 · delivering to Ibadan, Oyo/);
  assert.equal(rows[0].data.href, '/dashboard/orders/ORD-1');
  assert.equal(new Date(rows[0].createdAt).getTime(), paidAt.getTime());
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 1, 'a second catch-up adds nothing');
});

test('what the live alert already delivered is not delivered again by the catch-up', async () => {
  await paidOrder('ORD-2', 'oyo');
  const admin = await staff('boss', { superAdmin: true });
  await notifyStaffByPermission({ permission: 'orders.view', stateId: 'oyo', eventKeyPrefix: 'order:ORD-2:paid', title: 'New paid order', body: 'live', type: 'order_paid', data: {} });
  assert.equal((await mine(admin)).length, 1);
  await syncStaffNotifications(admin, { force: true });
  const rows = await mine(admin);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'live');
});

test('each admin is told only what their permissions and State cover', async () => {
  await paidOrder('ORD-3', 'oyo');
  const orders = await staff('orders', { permissions: ['orders.view'] });
  const finance = await staff('finance', { permissions: ['finance.refunds.view'] });
  const lagos = await staff('lagos', { permissions: ['orders.view'], scopeType: 'state', stateIds: ['lagos'] });
  const oyo = await staff('oyo', { permissions: ['orders.view'], scopeType: 'state', stateIds: ['oyo'] });
  for (const account of [orders, finance, lagos, oyo]) await syncStaffNotifications(account, { force: true });
  assert.equal((await mine(orders)).length, 1);
  assert.equal((await mine(finance)).length, 0, 'no orders permission');
  assert.equal((await mine(lagos)).length, 0, 'wrong State');
  assert.equal((await mine(oyo)).length, 1);
});

test('a permission granted later brings in the events it covers', async () => {
  await paidOrder('ORD-4', 'oyo');
  const admin = await staff('growing', { permissions: ['finance.refunds.view'] });
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 0);
  await grantLater('growing', ['finance.refunds.view', 'orders.view']);
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 1);
});

test('a notification the admin cleared does not come back', async () => {
  await paidOrder('ORD-5', 'oyo');
  const admin = await staff('tidy', { superAdmin: true });
  await syncStaffNotifications(admin, { force: true });
  await Notification.deleteMany({ userId: admin });
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 0);
  // ...but a new event after that is still delivered.
  await paidOrder('ORD-6', 'oyo');
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 1);
  assert.ok(await StaffNotificationCursor.findOne({ accountId: admin }));
});

test('orders paid more than two weeks ago are not replayed', async () => {
  await paidOrder('ORD-7', 'oyo', new Date(Date.now() - 20 * 24 * 3600_000));
  const admin = await staff('new', { superAdmin: true });
  await syncStaffNotifications(admin, { force: true });
  assert.equal((await mine(admin)).length, 0);
});

/** One order with a task an associate has taken all the way to "fulfilled", a delivered shipment and a refund. */
async function lifecycle() {
  const orderId = id();
  const at = new Date(Date.now() - 2 * 3600_000);
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-L1', orderCode: 'ORD-L1', userId: 'u', commerceStatus: 'IN_FULFILMENT', commercePaymentStatus: 'CONFIRMED', totalMinor: 500_000, sourceStateId: 'oyo', createdAt: at, updatedAt: at });
  await FulfilmentTask.collection.insertOne({ _id: id(), publicId: 'FUL-L1', orderId: String(orderId), sourceStateId: 'oyo', marketId: 'm', hubId: 'HUB-1', status: 'READY_FOR_HUB', orderItemIds: [], version: 1, idempotencyKey: 'k', acceptedAt: at, productSecuredAt: at, packedAt: at, createdAt: at, updatedAt: at });
  await Shipment.collection.insertOne({ _id: id(), publicId: 'SHP-L1', orderId: String(orderId), sourceStateId: 'oyo', hubId: 'HUB-1', provider: 'fez', courierName: 'Fez Delivery', trackingNumber: 'FEZ1', status: 'DELIVERED', bookedAt: at, pickedUpAt: at, deliveredAt: at, version: 1, createdAt: at, updatedAt: at });
  await FulfilmentRefund.collection.insertOne({ _id: id(), publicId: 'REF-L1', orderId: String(orderId), amountMinor: 200_000, status: 'REFUNDED', reason: 'x', idempotencyKey: 'rk', processedAt: at, createdAt: at, updatedAt: at });
}

test('the whole order lifecycle reaches the admins who follow it, each by their own permissions', async () => {
  await lifecycle();
  const boss = await staff('boss', { superAdmin: true });
  const fulfilment = await staff('fulfilment', { permissions: ['fulfilment.view'] });
  const shipping = await staff('shipping', { permissions: ['logistics.view'] });
  const finance = await staff('finance', { permissions: ['finance.refunds.view'] });
  const nobody = await staff('nobody', { permissions: ['reports.view'] });
  for (const account of [boss, fulfilment, shipping, finance, nobody]) await syncStaffNotifications(account, { force: true });

  const titles = async (account: string) => (await mine(account)).map((row) => row.title).sort();
  assert.deepEqual(await titles(boss), ['Associate accepted the order', 'Items secured at the market', 'Order delivered', 'Order fulfilled — on its way to the hub', 'Picked up by the courier', 'Refund processed', 'Refund requested', 'Shipment booked']);
  assert.deepEqual(await titles(fulfilment), ['Associate accepted the order', 'Items secured at the market', 'Order delivered', 'Order fulfilled — on its way to the hub', 'Picked up by the courier', 'Shipment booked']);
  assert.deepEqual(await titles(shipping), ['Order delivered', 'Picked up by the courier', 'Shipment booked']);
  assert.deepEqual(await titles(finance), ['Refund processed', 'Refund requested']);
  assert.deepEqual(await titles(nobody), []);

  const fulfilled = (await mine(boss)).find((row) => row.title.startsWith('Order fulfilled'));
  assert.equal(fulfilled.data.href, '/dashboard/fulfilment/tasks/FUL-L1');
  assert.equal(fulfilled.data.category, 'fulfilment');
  assert.match(fulfilled.body, /ORD-L1/);
});
