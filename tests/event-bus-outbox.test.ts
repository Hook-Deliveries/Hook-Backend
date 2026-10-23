import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { CommerceOutboxEvent } from '../src/models/commerce/commerce.model';
import { dispatchDueOutbox, emitOutbox, processOutbox, processOutboxEvent } from '../src/services/outbox.service';

before(startDatabase);
after(stopDatabase);
beforeEach(resetDatabase);

async function emitOne(aggregateId = 'ord_1') {
  await emitOutbox([{ aggregateType: 'order', aggregateId, eventType: 'ORDER_CREATED_EFFECTS', payload: {} }]);
  return (await CommerceOutboxEvent.findOne({ aggregateId }).lean())!;
}

test('dispatch publishes each due event once until it is processed or goes stale', async () => {
  const event = await emitOne();
  const sent: string[] = [];
  const publish = async (e: { publicId: string }) => { sent.push(e.publicId); };
  assert.equal(await dispatchDueOutbox(publish), 1);
  assert.equal(await dispatchDueOutbox(publish), 0);
  assert.deepEqual(sent, [event.publicId]);
});

test('a failed publish leaves the event ready to dispatch again', async () => {
  const event = await emitOne();
  await assert.rejects(dispatchDueOutbox(async () => { throw new Error('broker down'); }), /broker down/);
  const stored = await CommerceOutboxEvent.findById(event._id).lean();
  assert.equal(stored!.dispatchedAt, undefined);
  assert.equal(stored!.status, 'pending');
});

test('a consumer runs the handler once per event and marks it published', async () => {
  const event = await emitOne();
  let calls = 0;
  const handlers = { ORDER_CREATED_EFFECTS: async () => { calls += 1; } };
  assert.equal(await processOutboxEvent(event.publicId, handlers), true);
  assert.equal(await processOutboxEvent(event.publicId, handlers), false);
  assert.equal(calls, 1);
  assert.equal((await CommerceOutboxEvent.findById(event._id).lean())!.status, 'published');
});

test('a consumer ignores event types it does not own', async () => {
  const event = await emitOne();
  assert.equal(await processOutboxEvent(event.publicId, { PAYMENT_CONFIRMED_EFFECTS: async () => undefined }), false);
  assert.equal((await CommerceOutboxEvent.findById(event._id).lean())!.status, 'pending');
});

test('a handler failure reschedules the event and clears its dispatch mark', async () => {
  const event = await emitOne();
  await dispatchDueOutbox(async () => undefined);
  await processOutboxEvent(event.publicId, { ORDER_CREATED_EFFECTS: async () => { throw new Error('email down'); } });
  const stored = await CommerceOutboxEvent.findById(event._id).lean();
  assert.equal(stored!.status, 'pending');
  assert.equal(stored!.dispatchedAt, undefined);
  assert.equal(stored!.attempts, 1);
});

test('the in-worker drain still processes events when the bus is not used', async () => {
  await emitOne('ord_a');
  await emitOne('ord_b');
  let calls = 0;
  await processOutbox({ ORDER_CREATED_EFFECTS: async () => { calls += 1; } }, 5);
  assert.equal(calls, 2);
});
