import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { fulfilmentService } from '../src/modules/fulfilment/fulfilment.service';
import { Shipment, LogisticsWebhookEvent } from '../src/models/fulfilment/fulfilment.model';
import { Order } from '../src/models/orders/order.model';

before(async () => {
  process.env.LOGISTICS_MANUAL_WEBHOOK_SECRET = 'test-secret';
  await startDatabase();
});
after(stopDatabase);
beforeEach(async () => { mock.restoreAll(); await resetDatabase(); });

const sign = (payload: Record<string, unknown>) => createHmac('sha256', 'test-secret').update(JSON.stringify(payload)).digest('hex');

async function seed() {
  const orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: orderId, publicId: 'ORD-L-1', userId: 'u1', commerceStatus: 'READY_FOR_DISPATCH', timeline: [], sourceStateId: 'st', createdAt: new Date(), updatedAt: new Date() } as any);
  await Shipment.collection.insertOne({
    publicId: 'SHP-L-1', orderId: String(orderId), sourceStateId: 'st', hubId: 'hub', status: 'AWAITING_PICKUP', version: 1,
    trackingEvents: [], provider: 'manual', createdAt: new Date(), updatedAt: new Date(),
  } as any);
  return String(orderId);
}

const deliver = (id: string, payload: Record<string, unknown>) => fulfilmentService.logisticsWebhook('manual', id, payload, sign(payload));

test('logistics webhook: one delivery moves the shipment and order together, a replay is a duplicate', async () => {
  const orderId = await seed();
  const payload = { shipmentId: 'SHP-L-1', status: 'PICKED_UP' };
  const first: any = await deliver('evt-1', payload);
  assert.equal(first.accepted, true);
  const order = await Order.findById(orderId).lean() as any;
  assert.equal(order.commerceStatus, 'IN_TRANSIT');
  assert.equal(order.timeline.length, 1);

  const replay: any = await deliver('evt-1', payload);
  assert.equal(replay.duplicate, true);
  assert.equal(((await Order.findById(orderId).lean()) as any).timeline.length, 1);
  assert.equal(((await Shipment.findOne({ publicId: 'SHP-L-1' }).lean()) as any).version, 2);
});

test('logistics webhook: an event left RECEIVED by a failed attempt is reprocessed on the provider retry', async () => {
  await seed();
  const payload = { shipmentId: 'SHP-L-1', status: 'PICKED_UP' };
  await LogisticsWebhookEvent.create({ provider: 'manual', providerEventId: 'evt-2', payloadHash: 'x', eventType: 'PICKED_UP', signatureVerified: true, status: 'RECEIVED', receivedAt: new Date() });
  const retry: any = await deliver('evt-2', payload);
  assert.equal(retry.accepted, true, 'must not be swallowed as a duplicate');
  assert.equal(((await Shipment.findOne({ publicId: 'SHP-L-1' }).lean()) as any).status, 'PICKED_UP');
  assert.equal(((await LogisticsWebhookEvent.findOne({ providerEventId: 'evt-2' }).lean()) as any).status, 'PROCESSED');
});

test('logistics webhook: concurrent deliveries of one event apply it once', async () => {
  const orderId = await seed();
  const payload = { shipmentId: 'SHP-L-1', status: 'PICKED_UP' };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => deliver('evt-3', payload)));
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  await deliver('evt-3', payload).catch(() => undefined);
  assert.equal(((await Shipment.findOne({ publicId: 'SHP-L-1' }).lean()) as any).version, 2, 'applied exactly once');
  assert.equal(((await Order.findById(orderId).lean()) as any).timeline.length, 1);
});
