import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { fulfilmentService } from '../src/modules/fulfilment/fulfilment.service';
import { FulfilmentTask, HubPackage, RunnerPackage, Shipment } from '../src/models/fulfilment/fulfilment.model';
import { Order } from '../src/models/orders/order.model';
import { OrderItem } from '../src/models/orders/order-item.model';
import { DispatchHub } from '../src/models/platform/network.model';
import { OperationState } from '../src/models/platform/geography.model';
import { LogisticsProvider } from '../src/models/logistics/logistics-provider.model';
import { Notification } from '../src/models/notifications/notification.model';
import { User } from '../src/models/users/user.model';
import { StaffProfile } from '../src/models/platform/operations-accounts.model';

const staff = { accountId: 'staff-1', accountType: 'staff', stateIds: [] as string[], hubIds: [] as string[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const id = () => new mongoose.Types.ObjectId();
const CUSTOMER = String(new mongoose.Types.ObjectId());

type FezCall = { path: string; body: any };

/** A stand-in for the Fez API that records what was sent and hands out order numbers. */
function stubFez(options: { duplicateOf?: Record<string, string> } = {}) {
  const calls: FezCall[] = [];
  let counter = 0;
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(process.env.FEZ_BASE_URL as string, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/user/authenticate') return json(200, { status: 'Success', authDetails: { authToken: 't', expireToken: '2099-01-01 10:00:00' } });
    if (path === '/states') return json(200, { status: 'Success', states: [{ state: 'Lagos' }, { state: 'Oyo' }, { state: 'FCT' }] });
    if (path === '/order/cost') return json(200, { status: 'Success', totalCost: 2500 });
    if (path === '/order') {
      const uniqueID = body[0].uniqueID;
      if (options.duplicateOf?.[uniqueID]) return json(400, { status: 'Error', description: 'Error creating orders', duplicateUniqueIds: { [uniqueID]: options.duplicateOf[uniqueID] } });
      return json(201, { status: 'Success', orderNos: { [uniqueID]: `FEZ${++counter}` } });
    }
    if (path === '/order/cancel') return json(200, { status: 'Success' });
    throw new Error(`unexpected Fez call ${path}`);
  });
  return calls;
}

before(async () => {
  Object.assign(process.env, { LOGISTICS_FEZ_ENABLED: 'true', FEZ_SECRET_KEY: 'fez-secret', FEZ_USER_ID: 'u', FEZ_PASSWORD: 'p', FEZ_BASE_URL: 'https://fez.test/v1' });
  await startDatabase();
});
after(stopDatabase);
beforeEach(async () => { mock.restoreAll(); await resetDatabase(); });

/** An order with `associates` Market Associates, each with one packed package waiting at the hub gate. */
async function seed(associates = 1, paid = true) {
  const orderId = id();
  const stateId = 'state-lagos';
  await OperationState.collection.insertOne({ _id: id(), publicId: stateId, name: 'Lagos' });
  const hub = await DispatchHub.collection.insertOne({ _id: id(), publicId: 'HUB-1', name: 'Ikeja Hub', stateId, cityId: 'c', address: '1 Hub Road', contact: { phone: '08011112222' }, status: 'active' });
  await LogisticsProvider.collection.insertOne({ _id: id(), publicId: 'LP-1', code: 'FEZ', name: 'Fez Delivery', feeMinor: 0, status: 'active', integration: 'fez', sortOrder: 0 });
  await LogisticsProvider.collection.insertOne({ _id: id(), publicId: 'LP-2', code: 'GUO', name: 'GUO Transport', feeMinor: 0, status: 'active', integration: 'manual', sortOrder: 1 });
  await Order.collection.insertOne({
    _id: orderId, publicId: 'ORD-1001', userId: CUSTOMER, commerceStatus: 'IN_FULFILMENT', commercePaymentStatus: paid ? 'CONFIRMED' : 'PENDING', commercePaymentMethod: 'PREPAID',
    deliveryFeeMinor: 300000, totalMinor: 1_300_000, timeline: [], sourceStateId: stateId, createdAt: new Date(),
    logisticsProviderSnapshot: { code: 'FEZ', name: 'Fez Delivery' },
    addressSnapshot: { recipientName: 'Ada Obi', phone: '08030000000', line1: '5 Palm Street', cityName: 'Ibadan', stateName: 'Oyo' },
  });
  const packages: Array<{ taskId: string; packageId: string; itemId: string; code: string }> = [];
  for (let n = 1; n <= associates; n++) {
    const taskId = id(); const itemId = id(); const packageId = id(); const code = `${1000 + n}`; const associateId = String(id());
    await OrderItem.collection.insertOne({ _id: itemId, publicId: `ITM-${n}`, orderId: String(orderId), productId: 'p', productTitle: `Product ${n}`, quantity: 2, unitPriceMinor: 250000, totalPriceMinor: 500000, fulfilmentGroupId: `GRP-${n}` });
    await FulfilmentTask.collection.insertOne({ _id: taskId, publicId: `TSK-${n}`, orderId: String(orderId), sourceStateId: stateId, marketId: `m${n}`, hubId: 'HUB-1', marketAssociateId: associateId, orderItemIds: [String(itemId)], status: 'READY_FOR_HUB', version: 1, idempotencyKey: `k${n}` });
    await RunnerPackage.collection.insertOne({ _id: packageId, publicId: `RPK-${n}`, orderId: String(orderId), taskId: String(taskId), marketAssociateId: associateId, hubId: 'HUB-1', status: 'READY_FOR_HUB', scanCredentialHash: sha(code), scanCredentialHint: '**', itemIds: [String(itemId)], version: 1 });
    packages.push({ taskId: String(taskId), packageId: `RPK-${n}`, itemId: String(itemId), code });
  }
  return { orderId: String(orderId), hubId: String(hub.insertedId), packages };
}

const receive = (pkg: { packageId: string; code: string }) =>
  fulfilmentService.receivePackage(staff, pkg.packageId, { hubId: 'HUB-1', scanCredential: pkg.code, idempotencyKey: `recv-${pkg.packageId}` });

test('receiving a package with the associate\'s code makes it ready to ship and moves the order on', async () => {
  const { packages } = await seed(2);
  await receive(packages[0]);
  const first = await HubPackage.findOne({}).lean() as any;
  assert.equal(first.status, 'QC_PASSED');
  assert.equal((await Order.findOne({ publicId: 'ORD-1001' }).lean() as any).commerceStatus, 'PARTIALLY_RECEIVED');
  await receive(packages[1]);
  assert.equal((await Order.findOne({ publicId: 'ORD-1001' }).lean() as any).commerceStatus, 'READY_FOR_DISPATCH');
  const queue: any[] = await fulfilmentService.shippingQueue(staff, {});
  assert.equal(queue.length, 1);
  assert.equal(queue[0].packagesAtHub, 2);
  assert.equal(queue[0].complete, true);
  assert.equal(queue[0].packages.length, 2);
});

test('a wrong code does not receive the package', async () => {
  const { packages } = await seed(1);
  await assert.rejects(fulfilmentService.receivePackage(staff, packages[0].packageId, { hubId: 'HUB-1', scanCredential: '0000', idempotencyKey: 'bad-code-1' }), /Invalid package handover code/);
  assert.equal(await HubPackage.countDocuments(), 0);
});

test('booking sends Fez the goods value only, books once, and an order that is not paid cannot ship', async () => {
  const { packages } = await seed(1);
  await receive(packages[0]);
  const calls = stubFez();
  const preview: any = await fulfilmentService.shippingPreview(staff, 'ORD-1001', { weightGrams: 1500 });
  assert.equal(preview.quoteMinor, 250000);
  assert.equal(preview.customerPaidMinor, 300000);
  assert.equal(preview.marginMinor, 50000);
  assert.equal(preview.goodsValueMinor, 500000);
  assert.equal(preview.canBook, true);

  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1500, idempotencyKey: 'book-key-0001' });
  const sent = calls.find((call) => call.path === '/order')!.body[0];
  assert.equal(sent.valueOfItem, '5000', 'goods only, not the 13,000 order total');
  assert.equal(sent.weight, 2);
  assert.equal(shipment.status, 'BOOKED_WITH_PROVIDER');
  assert.equal(shipment.trackingNumber, 'FEZ1');
  assert.equal(shipment.receiptNumber, 'RCT-1001');
  assert.equal((await HubPackage.findOne({}).lean() as any).status, 'SHIPPED');

  // The same request again returns the same shipment and does not call Fez a second time.
  const again: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1500, idempotencyKey: 'book-key-0001' });
  assert.equal(again.publicId, shipment.publicId);
  assert.equal(calls.filter((call) => call.path === '/order').length, 1);
  // A different request has nothing left to ship.
  await assert.rejects(fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1500, idempotencyKey: 'book-key-0002' }), /not at the hub or are already on a shipment/);
});

test('an unpaid order cannot be booked', async () => {
  const { packages } = await seed(1, false);
  await receive(packages[0]);
  await assert.rejects(fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0003' }), /no confirmed payment/);
});

test('two associates\' packages can ship separately, with their own receipt numbers', async () => {
  const { packages } = await seed(2);
  await receive(packages[0]);
  await receive(packages[1]);
  stubFez();
  const [first, second] = (await HubPackage.find({}).sort({ createdAt: 1 }).lean() as any[]).map((pack) => pack.publicId);
  const a: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { hubPackageIds: [first], weightGrams: 1000, idempotencyKey: 'book-key-0004' });
  assert.equal(a.receiptNumber, 'RCT-1001');
  // What is left is the next parcel and already has its number.
  const waitingReceipt: any = await fulfilmentService.orderReceipt(staff, 'ORD-1001', {});
  assert.equal(waitingReceipt.receiptNumber, 'RCT-1001-P2');
  assert.equal(waitingReceipt.status, 'READY');
  assert.equal(waitingReceipt.items.length, 1);
  const b: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { hubPackageIds: [second], weightGrams: 2000, idempotencyKey: 'book-key-0005' });
  assert.equal(b.receiptNumber, 'RCT-1001-P2');
  assert.equal(await Shipment.countDocuments(), 2);
  assert.equal((await fulfilmentService.shippingQueue(staff, {})).length, 0);
});

test('two associates\' packages can ship together in one shipment', async () => {
  const { packages } = await seed(2);
  await receive(packages[0]);
  await receive(packages[1]);
  const calls = stubFez();
  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 3000, idempotencyKey: 'book-key-0006' });
  assert.equal(shipment.hubPackageIds.length, 2);
  assert.equal(calls.filter((call) => call.path === '/order').length, 1);
  assert.equal(calls.find((call) => call.path === '/order')!.body[0].valueOfItem, '10000');
});

test('cancelling a Fez booking frees the packages and they can be booked again', async () => {
  const { packages } = await seed(1);
  await receive(packages[0]);
  const calls = stubFez();
  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0007' });
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'CANCELLED' });
  assert.ok(calls.some((call) => call.path === '/order/cancel'), 'Fez is told');
  assert.equal((await HubPackage.findOne({}).lean() as any).status, 'QC_PASSED');
  assert.equal((await fulfilmentService.shippingQueue(staff, {})).length, 1);
  const rebooked: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0008' });
  assert.notEqual(rebooked.publicId, shipment.publicId);
  assert.equal(rebooked.receiptNumber, 'RCT-1001-P2', 'a cancelled number is never reused');
  // The two Fez bookings used different ids.
  const ids = calls.filter((call) => call.path === '/order').map((call) => call.body[0].uniqueID);
  assert.equal(new Set(ids).size, 2);
});

test('a failed Fez booking releases the packages', async () => {
  const { packages } = await seed(1);
  await receive(packages[0]);
  mock.method(globalThis, 'fetch', async (url: string) => {
    const path = String(url).replace(process.env.FEZ_BASE_URL as string, '');
    if (path === '/user/authenticate') return json(200, { status: 'Success', authDetails: { authToken: 't', expireToken: '2099-01-01 10:00:00' } });
    if (path === '/states') return json(200, { status: 'Success', states: [{ state: 'Lagos' }, { state: 'Oyo' }] });
    return json(500, { status: 'Error', description: 'Fez is down' });
  });
  await assert.rejects(fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0009' }));
  assert.equal((await HubPackage.findOne({}).lean() as any).status, 'QC_PASSED');
  assert.equal(await Shipment.countDocuments(), 0);
});

test('a courier other than the customer\'s needs a reason, and a manual courier skips Fez', async () => {
  const { packages } = await seed(1);
  await receive(packages[0]);
  const calls = stubFez();
  await assert.rejects(fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, courierCode: 'GUO', idempotencyKey: 'book-key-0010' }), /reason is required/);
  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, courierCode: 'GUO', substitutionReason: 'Fez cannot reach this area', idempotencyKey: 'book-key-0011' });
  assert.equal(shipment.provider, 'manual');
  assert.equal(shipment.substitutedFrom, 'FEZ');
  assert.equal(calls.some((call) => call.path === '/order'), false);
});

test('a Fez shipment\'s courier cannot be relabelled, and its receipt tracks it', async () => {
  const { packages } = await seed(1);
  await receive(packages[0]);
  stubFez();
  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0012' });
  await assert.rejects(fulfilmentService.reassignShipmentCourier(staff, shipment.publicId, { courierCode: 'GUO', reason: 'because' }), /Cancel it, then book again/);
  const receipt: any = await fulfilmentService.orderReceipt(staff, 'ORD-1001', {});
  assert.equal(receipt.courier.trackingNumber, 'FEZ1');
  assert.equal(receipt.parcel.weightGrams, 1000);
  const print: any = await fulfilmentService.recordReceiptPrint(staff, 'ORD-1001', { size: 'a6' });
  assert.equal(print.printCount, 1);
  const reprint: any = await fulfilmentService.recordReceiptPrint(staff, 'ORD-1001', { size: 'a6' });
  assert.equal(reprint.isReprint, true);
});

test('the customer\'s receipt exists once the hub has the goods, and public tracking follows the parcel', async () => {
  const { packages } = await seed(1);
  await assert.rejects(fulfilmentService.customerReceipt(CUSTOMER, 'ORD-1001'), /once your order reaches our hub/);
  await receive(packages[0]);
  const customer: any = await fulfilmentService.customerReceipt(CUSTOMER, 'ORD-1001');
  assert.equal(customer.receiptNumber, 'RCT-1001');
  const before: any = await fulfilmentService.publicParcelTracking('RCT-1001', fulfilmentService.trackingSignature('RCT-1001'));
  assert.equal(before.status, 'AT_HUB');
  stubFez();
  await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, idempotencyKey: 'book-key-0013' });
  const after: any = await fulfilmentService.publicParcelTracking('RCT-1001', fulfilmentService.trackingSignature('RCT-1001'));
  assert.equal(after.status, 'BOOKED_WITH_PROVIDER');
  assert.equal(after.trackingNumber, 'FEZ1');
});

test('receiving a package tells the staff who book shipments, and only them', async () => {
  const { packages } = await seed(1);
  const adminId = id();
  await User.collection.insertOne({ _id: adminId, accountType: 'staff', role: 'super_admin', isActive: true, email: 'boss@hook.test', permissions: [] });
  await StaffProfile.collection.insertOne({ _id: id(), publicId: 'STF-boss', accountId: String(adminId), roleIds: [], scopeType: 'global', stateIds: [], hubIds: [], status: 'active' });
  await receive(packages[0]);
  const alerts = await Notification.find({ userId: String(adminId), type: 'ready_to_ship' }).lean() as any[];
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /ORD-1001 has a package at Ikeja Hub/);
  assert.equal(alerts[0].data.href, '/dashboard/shipping');
});

test('booking, pickup, delivery and cancelling a shipment each tell the staff who follow shipping', async () => {
  const { packages } = await seed(1);
  const adminId = id();
  await User.collection.insertOne({ _id: adminId, accountType: 'staff', role: 'super_admin', isActive: true, email: 'boss2@hook.test', permissions: [] });
  await StaffProfile.collection.insertOne({ _id: id(), publicId: 'STF-boss2', accountId: String(adminId), roleIds: [], scopeType: 'global', stateIds: [], hubIds: [], status: 'active' });
  await receive(packages[0]);
  stubFez();
  const shipment: any = await fulfilmentService.bookShipment(staff, 'ORD-1001', { weightGrams: 1000, courierCode: 'GUO', substitutionReason: 'Fez cannot reach this area', idempotencyKey: 'book-key-0099' });
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'AWAITING_PICKUP' });
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'PICKED_UP' });
  const titles = async () => ((await Notification.find({ userId: String(adminId) }).lean()) as any[]).map((row) => row.title);
  assert.ok((await titles()).includes('Shipment booked'));
  assert.ok((await titles()).includes('Picked up by the courier'));
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'IN_TRANSIT' });
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'OUT_FOR_DELIVERY' });
  await fulfilmentService.updateShipment(staff, shipment.publicId, { status: 'DELIVERED' });
  const all = await titles();
  assert.ok(all.includes('Out for delivery'));
  assert.ok(all.includes('Order delivered'));
  assert.equal(all.filter((title) => title === 'Shipment booked').length, 1, 'never repeated');
});
