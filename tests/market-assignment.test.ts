import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { fulfilmentService } from '../src/modules/fulfilment/fulfilment.service';
import { FulfilmentTask } from '../src/models/fulfilment/fulfilment.model';
import { Notification } from '../src/models/notifications/notification.model';
import { Order } from '../src/models/orders/order.model';
import { OrderItem } from '../src/models/orders/order-item.model';
import { Product } from '../src/models/products/product.model';
import { DispatchHub, Market } from '../src/models/platform/network.model';
import { MarketAssociateMarketAssignment, MarketAssociateProfile, StaffProfile } from '../src/models/platform/operations-accounts.model';
import { User } from '../src/models/users/user.model';

const id = () => new mongoose.Types.ObjectId();
const STATE = 'state-oyo';

before(async () => { await startDatabase(); });
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); });

async function world() {
  const hubId = id(); const marketId = id();
  await DispatchHub.collection.insertOne({ _id: hubId, publicId: 'HUB-1', name: 'Ibadan Hub', stateId: STATE, cityId: 'c', address: '1 Road', status: 'active' });
  await Market.collection.insertOne({ _id: marketId, publicId: 'MKT-1', name: 'Bodija Market', normalizedName: 'bodija market', stateId: STATE, cityId: 'c', hubId: String(hubId), address: 'x', status: 'active' });
  for (const n of [1, 2, 3]) await Product.collection.insertOne({ _id: id(), publicId: `PRD-${n}`, slug: `product-${marketId}-${n}`, title: `Product ${n}`, marketId: String(marketId), status: 'published' });
  return { hubId: String(hubId), marketId: String(marketId) };
}

async function associate(name: string, status = 'active') {
  const accountId = String(id());
  const profile = id();
  await MarketAssociateProfile.collection.insertOne({ _id: profile, publicId: `MA-${name}`, accountId, stateIds: [STATE], hubIds: [], availability: 'available', status });
  return { profileId: String(profile), accountId };
}

async function assign(profileId: string, marketId: string, extra: Record<string, unknown> = {}) {
  const _id = id();
  await MarketAssociateMarketAssignment.collection.insertOne({ _id, publicId: `ASG-${String(_id).slice(-4)}`, marketAssociateId: profileId, marketId, stateId: STATE, status: 'active', priority: 100, isPrimary: false, activeFrom: new Date(Date.now() - 1000), assignmentReason: 'test', createdBy: 'admin', history: [], ...extra });
  return String(_id);
}

/** A paid order whose only market had nobody to fulfil it, so its task is blocked. */
async function waitingOrder(marketId: string, publicId = 'ORD-1') {
  const orderId = id(); const itemId = id();
  await Order.collection.insertOne({ _id: orderId, publicId, orderCode: publicId, userId: 'u', commerceStatus: 'IN_FULFILMENT', commercePaymentStatus: 'CONFIRMED', sourceStateId: STATE, timeline: [], fulfilmentSummary: { taskCount: 1, blocked: true }, customerProgress: [{ key: 'fulfilment', label: 'Operations review required', at: new Date() }], createdAt: new Date() });
  await OrderItem.collection.insertOne({ _id: itemId, publicId: `ITM-${publicId}`, orderId: String(orderId), productId: 'p', productTitle: 'Slides', quantity: 1, marketId, stateId: STATE });
  await FulfilmentTask.collection.insertOne({ _id: id(), publicId: `TSK-${publicId}`, orderId: String(orderId), sourceStateId: STATE, marketId, status: 'BLOCKED', orderItemIds: [String(itemId)], version: 1, idempotencyKey: `order:${orderId}:market:${marketId}`, evidence: [], assignmentHistory: [] });
  return String(orderId);
}

const mine = (accountId: string) => Notification.find({ userId: accountId }).sort({ createdAt: 1 }).lean() as Promise<any[]>;

test('assigning an associate hands them the orders already waiting for the market, and tells them', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId);
  const ma = await associate('ada');
  const assignmentId = await assign(ma.profileId, marketId); // not primary: that no longer matters

  const result = await fulfilmentService.onMarketAssociateAssigned(assignmentId);
  assert.equal(result.assignedTasks, 1);

  const task = await FulfilmentTask.findOne({ orderId }).lean() as any;
  assert.equal(task.status, 'ALERTED');
  assert.equal(task.marketAssociateId, ma.profileId);
  assert.equal(task.hubId, 'HUB-1');
  assert.equal(task.assignmentHistory[0].action, 'auto_assigned');

  const order = await Order.findById(orderId).lean() as any;
  assert.equal(order.fulfilmentSummary.blocked, false);
  assert.equal(order.customerProgress[0].label, 'Hook is sourcing your items');

  const alerts = await mine(ma.accountId);
  assert.deepEqual(alerts.map((row) => row.type).sort(), ['market_assigned', 'order_assigned']);
  const assigned = alerts.find((row) => row.type === 'market_assigned');
  assert.equal(assigned.title, "You're now assigned to Bodija Market");
  assert.match(assigned.body, /3 products in this market are ready for you\. 1 order is waiting for pickup\./);
  assert.equal(assigned.data.href, '/market-associate/markets/MKT-1');
});

test('doing it again changes nothing and does not alert twice', async () => {
  const { marketId } = await world();
  await waitingOrder(marketId);
  const ma = await associate('ada');
  const assignmentId = await assign(ma.profileId, marketId);
  await fulfilmentService.onMarketAssociateAssigned(assignmentId);
  const again = await fulfilmentService.onMarketAssociateAssigned(assignmentId);
  assert.equal(again.assignedTasks, 0);
  assert.equal((await mine(ma.accountId)).length, 2);
});

test('an associate who has not activated their account is not given orders until they do', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId);
  const ma = await associate('invited', 'invited');
  const assignmentId = await assign(ma.profileId, marketId);
  assert.equal((await fulfilmentService.onMarketAssociateAssigned(assignmentId)).assignedTasks, 0);
  assert.equal(((await FulfilmentTask.findOne({ orderId }).lean()) as any).status, 'BLOCKED');
  await MarketAssociateProfile.updateOne({ _id: ma.profileId }, { $set: { status: 'active' } });
  await fulfilmentService.onMarketAssociateActivated(ma.profileId);
  assert.equal(((await FulfilmentTask.findOne({ orderId }).lean()) as any).marketAssociateId, ma.profileId);
});

test('orders for other markets and tasks that already have an associate are left alone', async () => {
  const { marketId } = await world();
  const otherMarket = String(id());
  const elsewhere = await waitingOrder(otherMarket, 'ORD-OTHER');
  const taken = await waitingOrder(marketId, 'ORD-TAKEN');
  await FulfilmentTask.updateOne({ orderId: taken }, { $set: { marketAssociateId: 'someone-else' } });
  const ma = await associate('ada');
  const result = await fulfilmentService.onMarketAssociateAssigned(await assign(ma.profileId, marketId));
  assert.equal(result.assignedTasks, 0);
  assert.equal(((await FulfilmentTask.findOne({ orderId: elsewhere }).lean()) as any).status, 'BLOCKED');
  assert.equal(((await FulfilmentTask.findOne({ orderId: taken }).lean()) as any).marketAssociateId, 'someone-else');
});

test('a paused or ended assignment gives nothing', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId);
  const ma = await associate('ada');
  const result = await fulfilmentService.onMarketAssociateAssigned(await assign(ma.profileId, marketId, { status: 'paused' }));
  assert.equal(result.assignedTasks, 0);
  assert.equal(((await FulfilmentTask.findOne({ orderId }).lean()) as any).status, 'BLOCKED');
});

test('new orders go to the highest-priority active associate, skipping ones who cannot work', async () => {
  const { marketId } = await world();
  const inactive = await associate('inactive', 'suspended');
  const low = await associate('low');
  const high = await associate('high');
  await assign(inactive.profileId, marketId, { priority: 1 });
  await assign(low.profileId, marketId, { priority: 50 });
  await assign(high.profileId, marketId, { priority: 10, isPrimary: false });

  const orderId = id(); const itemId = id();
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-NEW', userId: 'u', commerceStatus: 'APPROVED_FOR_FULFILMENT', sourceStateId: STATE, timeline: [], createdAt: new Date() });
  await OrderItem.collection.insertOne({ _id: itemId, publicId: 'ITM-NEW', orderId: String(orderId), productId: 'p', productTitle: 'Slides', quantity: 1, marketId, stateId: STATE });
  await fulfilmentService.consumeApprovedOrder({ aggregateId: String(orderId) });

  const task = await FulfilmentTask.findOne({ orderId: String(orderId) }).lean() as any;
  assert.equal(task.marketAssociateId, high.profileId, 'priority 10 beats 50, and the suspended priority-1 associate is skipped');
  assert.equal(task.status, 'ALERTED');
  assert.equal((await mine(high.accountId)).filter((row) => row.type === 'order_assigned').length, 1);
});

test('on equal priority the primary associate wins', async () => {
  const { marketId } = await world();
  const a = await associate('a');
  const b = await associate('b');
  await assign(a.profileId, marketId, { priority: 100, isPrimary: false });
  await assign(b.profileId, marketId, { priority: 100, isPrimary: true });
  const orderId = id();
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-TIE', userId: 'u', commerceStatus: 'APPROVED_FOR_FULFILMENT', sourceStateId: STATE, timeline: [], createdAt: new Date() });
  await OrderItem.collection.insertOne({ _id: id(), publicId: 'ITM-TIE', orderId: String(orderId), productId: 'p', productTitle: 'Slides', quantity: 1, marketId, stateId: STATE });
  await fulfilmentService.consumeApprovedOrder({ aggregateId: String(orderId) });
  assert.equal(((await FulfilmentTask.findOne({ orderId: String(orderId) }).lean()) as any).marketAssociateId, b.profileId);
});

const staffActor = { accountId: 'staff-1', accountType: 'staff', stateIds: [] as string[], hubIds: [] as string[] };

test('a task left "alerted" with nobody on it is given to the market\'s associate', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId);
  await FulfilmentTask.updateOne({ orderId }, { $set: { status: 'ALERTED' } }); // what an unblock used to leave behind
  const ma = await associate('ada');
  await assign(ma.profileId, marketId);
  const result = await fulfilmentService.reconcileUnheldTasks();
  assert.equal(result.handedOver, 1);
  const task = await FulfilmentTask.findOne({ orderId }).lean() as any;
  assert.equal(task.marketAssociateId, ma.profileId);
  assert.equal(task.status, 'ALERTED');
  assert.equal((await fulfilmentService.reconcileUnheldTasks()).handedOver, 0, 'nothing left to do the second time');
});

test('unblocking a task with nobody on it matches the market\'s associate, or says none is assigned', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId);
  const taskPublicId = ((await FulfilmentTask.findOne({ orderId }).lean()) as any).publicId;
  await assert.rejects(fulfilmentService.unblockTask(staffActor, taskPublicId, { reason: 'release it' }), /No active Market Associate is assigned to this Market/);
  assert.equal(((await FulfilmentTask.findOne({ orderId }).lean()) as any).status, 'BLOCKED', 'still blocked, not released into the void');

  const ma = await associate('ada');
  await assign(ma.profileId, marketId);
  const released: any = await fulfilmentService.unblockTask(staffActor, taskPublicId, { reason: 'release it' });
  assert.equal(released.status, 'ALERTED');
  assert.equal(released.marketAssociateId, ma.profileId);
  assert.equal(released.hubId, 'HUB-1');
});

test('the order shows who holds each part of it, and who it is still waiting for', async () => {
  const { marketId } = await world();
  const held = await waitingOrder(marketId, 'ORD-HELD');
  const ma = await associate('ada');
  await FulfilmentTask.updateOne({ orderId: held }, { $set: { status: 'SOURCING', marketAssociateId: ma.profileId, hubId: 'HUB-1', acceptedAt: new Date() } });
  const rows: any[] = await fulfilmentService.orderFulfilment(held);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market.name, 'Bodija Market');
  assert.equal(rows[0].status, 'SOURCING');
  assert.equal(rows[0].waitingForAssociate, false);
  assert.ok(rows[0].acceptedAt);

  const waiting = await waitingOrder(marketId, 'ORD-WAIT');
  const [row]: any[] = await fulfilmentService.orderFulfilment(waiting);
  assert.equal(row.waitingForAssociate, true);
  assert.equal(row.marketAssociate, null);
});

test('when an associate accepts and then fulfils an order, the admin is told at each step', async () => {
  const { marketId } = await world();
  const orderId = await waitingOrder(marketId, 'ORD-LIVE');
  const ma = await associate('ada');
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(ma.accountId), accountType: 'marketassociate', isActive: true, firstName: 'Ada', lastName: 'Obi', email: 'ada@hook.test' });
  const adminId = id();
  await User.collection.insertOne({ _id: adminId, accountType: 'staff', role: 'super_admin', isActive: true, email: 'boss@hook.test', permissions: [] });
  await StaffProfile.collection.insertOne({ _id: id(), publicId: 'STF-boss', accountId: String(adminId), roleIds: [], scopeType: 'global', stateIds: [], hubIds: [], status: 'active' });

  const item: any = await OrderItem.findOne({ orderId }).lean();
  await FulfilmentTask.updateOne({ orderId }, { $set: { status: 'ALERTED', marketAssociateId: ma.profileId, hubId: 'HUB-1', itemVerifications: [{ orderItemId: String(item._id), matched: true, actualQuantity: 1, unitCostMinor: 1000 }] } });
  const task: any = await FulfilmentTask.findOne({ orderId }).lean();

  await fulfilmentService.marketAssociateTransition(ma.accountId, task.publicId, 'accept', task.version);
  let alerts: any[] = await Notification.find({ userId: String(adminId) }).lean();
  const accepted = alerts.find((row) => row.title === 'Associate accepted the order');
  assert.ok(accepted, 'the admin is told it was accepted');
  assert.match(accepted.body, /Ada Obi accepted ORD-LIVE at Bodija Market\./);

  const fresh: any = await FulfilmentTask.findOne({ orderId }).lean();
  await fulfilmentService.marketAssociateTransition(ma.accountId, task.publicId, 'submit', fresh.version, {});
  alerts = await Notification.find({ userId: String(adminId) }).lean();
  const fulfilled = alerts.find((row) => row.title.startsWith('Order fulfilled'));
  assert.ok(fulfilled, 'the admin is told it was fulfilled');
  assert.equal(fulfilled.data.href, `/dashboard/fulfilment/tasks/${task.publicId}`);
});
