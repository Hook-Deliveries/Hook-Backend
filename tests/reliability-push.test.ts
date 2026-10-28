import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { DeviceToken } from '../src/models/notifications/device-token.model';
import { PushTicket } from '../src/models/notifications/push-ticket.model';
import { Notification } from '../src/models/notifications/notification.model';
import { processPushReceipts, sendPushMessages, sendPushToUser } from '../src/modules/notifications/push.service';
import { createCommerceNotification } from '../src/modules/notifications/commerce-notification.service';

before(startDatabase);
after(stopDatabase);
beforeEach(async () => { mock.restoreAll(); delete process.env.EXPO_ACCESS_TOKEN; delete process.env.PUSH_ENABLED; await resetDatabase(); });

type Call = { url: string; body: any; headers: Record<string, string> };
function fakeExpo(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    const call = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    calls.push(call);
    return new Response(JSON.stringify({ data: respond(call) }), { status: 200 });
  });
  return calls;
}
const device = (userId: string, n: number) => DeviceToken.create({ userId, expoPushToken: `ExponentPushToken[t${n}]`, isActive: true } as any);
// createdAt is immutable in Mongoose, so age the tickets through the raw collection.
const later = (ms: number) => PushTicket.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - ms) } });

test('a send goes out in batches of 100 with the Android channel and priority, and keeps the tickets', async () => {
  const calls = fakeExpo((call) => call.body.map((_: unknown, i: number) => ({ status: 'ok', id: `${call.body[i].to}-id` })));
  await sendPushMessages(Array.from({ length: 150 }, (_, i) => ({ to: `ExponentPushToken[b${i}]`, title: 't', body: 'b' })));
  assert.deepEqual(calls.map((call) => call.body.length), [100, 50]);
  assert.equal(calls[0].body[0].channelId, 'default');
  assert.equal(calls[0].body[0].priority, 'high');
  assert.equal(await PushTicket.countDocuments({}), 150);
});

test('the Expo access token is sent when configured, and only then', async () => {
  const calls = fakeExpo(() => []);
  await sendPushMessages([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }]);
  assert.equal(calls[0].headers.Authorization, undefined);
  process.env.EXPO_ACCESS_TOKEN = 'secret-token';
  await sendPushMessages([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }]);
  assert.equal(calls[1].headers.Authorization, 'Bearer secret-token');
});

test('a token Expo rejects at send time is switched off, so it is not sent to again', async () => {
  await device('u1', 1); await device('u1', 2);
  fakeExpo(() => [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }, { status: 'ok', id: 'ok-2' }]);
  await sendPushToUser('u1', { title: 't', body: 'b' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = await DeviceToken.find({}).sort({ expoPushToken: 1 }).lean() as any[];
  assert.deepEqual(rows.map((row) => row.isActive), [false, true]);
});

test('receipts find dead tokens later, and finished tickets are cleaned up', async () => {
  await device('u1', 1); await device('u1', 2); await device('u1', 3);
  fakeExpo((call) => call.url.includes('getReceipts')
    ? { 'id-1': { status: 'ok' }, 'id-2': { status: 'error', details: { error: 'DeviceNotRegistered' } } }
    : call.body.map((_: unknown, i: number) => ({ status: 'ok', id: `id-${i + 1}` })));
  await sendPushToUser('u1', { title: 't', body: 'b' });
  assert.deepEqual(await processPushReceipts(), { checked: 0, deactivated: 0 }, 'too early to ask');

  await later(20 * 60_000);
  const result = await processPushReceipts();
  assert.equal(result.deactivated, 1);
  const rows = await DeviceToken.find({}).sort({ expoPushToken: 1 }).lean() as any[];
  assert.deepEqual(rows.map((row) => row.isActive), [true, false, true]);
  // id-3 had no receipt yet: it stays to be asked again; the two answered are gone
  assert.deepEqual((await PushTicket.find({}).lean() as any[]).map((ticket) => ticket.ticketId), ['id-3']);
});

test('a network failure never throws, and PUSH_ENABLED=false sends nothing', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.doesNotReject(() => sendPushMessages([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }]));
  mock.restoreAll();
  const calls = fakeExpo(() => []);
  process.env.PUSH_ENABLED = 'false';
  await sendPushMessages([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }]);
  assert.equal(calls.length, 0);
});

test('a new notification pushes once; a replay of the same event does not buzz the phone again', async () => {
  await device('u1', 1);
  const calls = fakeExpo(() => [{ status: 'ok', id: 'x' }]);
  const input = { eventKey: 'order:ORD-1:payment-confirmed', userId: 'u1', title: 'Payment confirmed', body: 'Thanks', type: 'payment_confirmed', data: { orderId: 'ORD-1' } };
  await createCommerceNotification(input);
  await createCommerceNotification(input);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await Notification.countDocuments({ eventKey: input.eventKey }), 1);
  assert.equal(calls.length, 1);
  // The push tells the app where to go, and still carries orderId for older app versions.
  const { notificationId, ...data } = calls[0].body[0].data;
  assert.deepEqual(data, { type: 'payment_confirmed', group: 'orders', screen: 'order', params: { orderId: 'ORD-1' }, orderId: 'ORD-1' });
  assert.ok(notificationId, 'the push carries the notification id so a tap can be recorded');
});
