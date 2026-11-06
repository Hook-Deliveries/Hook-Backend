import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { fulfilmentService } from '../src/modules/fulfilment/fulfilment.service';
import { FezLogisticsProvider } from '../src/modules/fulfilment/logistics/fez.provider';
import { Shipment } from '../src/models/fulfilment/fulfilment.model';
import { Order } from '../src/models/orders/order.model';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function stubFez(routes: Record<string, (body: any) => Response>) {
  const calls: Array<{ path: string; body: any }> = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = String(url).replace(process.env.FEZ_BASE_URL as string, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/user/authenticate') return json(200, { status: 'Success', authDetails: { authToken: 't', expireToken: '2099-01-01 10:00:00' } });
    if (path === '/states') return json(200, { status: 'Success', states: [{ state: 'Lagos' }, { state: 'Akwa Ibom' }, { state: 'FCT' }] });
    return routes[path](body);
  });
  return calls;
}

before(async () => {
  Object.assign(process.env, { LOGISTICS_FEZ_ENABLED: 'true', FEZ_SECRET_KEY: 'fez-secret', FEZ_USER_ID: 'u', FEZ_PASSWORD: 'p', FEZ_BASE_URL: 'https://fez.test/v1' });
  await startDatabase();
});
after(stopDatabase);
beforeEach(async () => { mock.restoreAll(); await resetDatabase(); });

async function seed(status: string) {
  const orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-F-1', userId: 'u1', commerceStatus: 'READY_FOR_DISPATCH', timeline: [], sourceStateId: 'st', createdAt: new Date(), updatedAt: new Date() } as any);
  await Shipment.collection.insertOne({ publicId: 'SHP-F-1', orderId: String(orderId), sourceStateId: 'st', hubId: 'hub', status, version: 1, trackingEvents: [], provider: 'fez', externalReference: 'FEZ123', createdAt: new Date(), updatedAt: new Date() } as any);
}

const shipmentStatus = async () => ((await Shipment.findOne({ publicId: 'SHP-F-1' }).lean()) as any).status;

test('fez webhook: finds the shipment by orderNumber and accepts a skipped step', async () => {
  await seed('BOOKED_WITH_PROVIDER');
  const payload = { orderNumber: 'FEZ123', status: 'Delivered' };
  const signature = createHmac('sha256', 'fez-secret').update('FEZ123Delivered1700000000').digest('hex');
  const result: any = await fulfilmentService.logisticsWebhook('fez', 'FEZ123:Delivered', payload, signature, '1700000000');
  assert.equal(result.accepted, true);
  assert.equal(await shipmentStatus(), 'DELIVERED');
});

test('fez webhook: a bad signature changes nothing', async () => {
  await seed('BOOKED_WITH_PROVIDER');
  await assert.rejects(fulfilmentService.logisticsWebhook('fez', 'e', { orderNumber: 'FEZ123', status: 'Delivered' }, 'a'.repeat(64), '1'));
  assert.equal(await shipmentStatus(), 'BOOKED_WITH_PROVIDER');
});

test('fez webhook: one delivered shipment of two leaves the order partially delivered', async () => {
  await seed('IN_TRANSIT');
  const { orderId } = (await Shipment.findOne({ publicId: 'SHP-F-1' }).lean()) as any;
  await Shipment.collection.insertOne({ publicId: 'SHP-F-2', orderId, sourceStateId: 'st2', hubId: 'hub2', status: 'IN_TRANSIT', version: 1, trackingEvents: [], provider: 'fez', externalReference: 'FEZ456', createdAt: new Date(), updatedAt: new Date() } as any);
  const deliver = (orderNumber: string) => {
    const signature = createHmac('sha256', 'fez-secret').update(`${orderNumber}Delivered1`).digest('hex');
    return fulfilmentService.logisticsWebhook('fez', `${orderNumber}:Delivered`, { orderNumber, status: 'Delivered' }, signature, '1');
  };
  await deliver('FEZ123');
  let order = await Order.findById(orderId).lean() as any;
  assert.equal(order.commerceStatus, 'PARTIALLY_DELIVERED');
  assert.equal(order.deliveredAt, undefined);
  await deliver('FEZ456');
  order = await Order.findById(orderId).lean() as any;
  assert.equal(order.commerceStatus, 'DELIVERED');
  assert.ok(order.deliveredAt);
});

test('fez sync: polling applies the tracked status when no webhook arrived', async () => {
  await seed('BOOKED_WITH_PROVIDER');
  stubFez({ '/order/track/FEZ123': () => json(200, { status: 'Success', order: { orderStatus: 'Dispatched' }, history: [] }) });
  await fulfilmentService.syncFezShipments();
  assert.equal(await shipmentStatus(), 'IN_TRANSIT');
});

test('fez quote: sends pickup state and weight, and maps Abuja to FCT', async () => {
  const calls = stubFez({ '/order/cost': () => json(200, { status: 'Success', totalCost: 1997.5 }) });
  const quote = await new FezLogisticsProvider().quote({ stateName: 'Abuja', weightGrams: 2500, hub: { stateName: 'Lagos State' } });
  assert.deepEqual(calls.find((call) => call.path === '/order/cost')?.body, { state: 'FCT', pickUpState: 'Lagos', weight: 3 });
  assert.equal(quote.quoteMinor, 199750);
});

test('fez book: a duplicate uniqueID adopts the existing Fez order', async () => {
  stubFez({ '/order': () => json(400, { status: 'Error', description: 'Error creating orders', orderNos: { CON1: 'Unique ID already exists' }, duplicateUniqueIds: { CON1: 'FEZ999' } }) });
  const booking = await new FezLogisticsProvider().book({
    orderId: 'ORD-1', bookingIdempotencyKey: 'CON1', totalMinor: 500000,
    deliveryAddressSnapshot: { recipientName: 'A B', phone: '0801', line1: '1 Road', cityName: 'Ikeja', stateName: 'lagos' },
  });
  assert.equal(booking.externalReference, 'FEZ999');
});

test('fez book: an unknown state fails with a clear error before anything is booked', async () => {
  const calls = stubFez({ '/order': () => json(201, { status: 'Success', orderNos: {} }) });
  await assert.rejects(new FezLogisticsProvider().book({
    orderId: 'ORD-1', deliveryAddressSnapshot: { recipientName: 'A', phone: '1', line1: 'x', stateName: 'Gotham' },
  }), /not a Fez delivery state/);
  assert.equal(calls.some((call) => call.path === '/order'), false);
});
