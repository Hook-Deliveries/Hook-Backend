import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { AccountDeletionService } from '../src/modules/identity/account-deletion.service';
import { AccountErasureService, anonymizedEmail } from '../src/modules/identity/account-erasure.service';
import { AuthService } from '../src/modules/identity/auth.service';
import { MongoRepository } from '../src/lib/mongo-repository';
import { hashPassword } from '../src/lib/security';
import { User } from '../src/models/users/user.model';
import { Order } from '../src/models/orders/order.model';
import { Otp } from '../src/models/auth/otp.model';
import { AccountSession } from '../src/models/platform/session.model';
import { AccountDeletionRequest } from '../src/models/support/account-deletion-request.model';
import { CustomerAddress } from '../src/models/commerce/commerce.model';
import { DeviceToken } from '../src/models/notifications/device-token.model';
import { Notification } from '../src/models/notifications/notification.model';
import { FulfilmentRefund } from '../src/models/fulfilment/fulfilment.model';
import { Negotiation } from '../src/models/negotiations/negotiation.model';

before(startDatabase);
after(stopDatabase);

type Sent = { kind: string; email: string; code?: string; cancelUrl?: string };
let sent: Sent[] = [];
const email: any = { sendAccountDeletion: async (payload: Sent) => { sent.push(payload); } };
const deletions = () => new AccountDeletionService(email);
const erasure = () => new AccountErasureService(deletions(), email);

beforeEach(async () => {
  mock.restoreAll();
  sent = [];
  delete process.env.ACCOUNT_DELETION_COOLING_OFF_DAYS;
  await resetDatabase();
  await AccountDeletionRequest.init();
});

async function customer(overrides: Record<string, unknown> = {}) {
  return (await User.create({
    email: 'ada@example.com', password: await hashPassword('Correct-Horse-9'), firstName: 'Ada', lastName: 'Obi',
    phone: '08012345678', role: 'shopper', accountType: 'customer', accountStatus: 'active', isActive: true, publicId: 'CUS-1',
    ...overrides,
  } as any)).toObject() as any;
}
async function order(userId: string, fields: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({
    _id, publicId: `ORD-${String(_id).slice(-6)}`, orderCode: `ORD-${String(_id).slice(-6)}`, userId, commerceStatus: 'DELIVERED', commercePaymentStatus: 'CONFIRMED', timeline: [],
    totalMinor: 500_000, customerSnapshot: { name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678' },
    addressSnapshot: { stateId: 'st1', stateName: 'Lagos', cityName: 'Ikeja', line1: '12 Allen Ave', phone: '0801' },
    deliveryAddress: { street: '12 Allen Ave', city: 'Ikeja', state: 'Lagos', phone: '0801' },
    createdAt: new Date(), updatedAt: new Date(), ...fields,
  } as any);
  return String(_id);
}
const proof = { password: 'Correct-Horse-9' };
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (error: any) => error.code === code);

test('every way of failing to prove ownership looks identical', async () => {
  await customer();
  await User.create({ email: 'staff@example.com', password: await hashPassword('Correct-Horse-9'), firstName: 'S', lastName: 'T', role: 'admin', accountType: 'staff', isActive: true } as any);
  const failures: string[] = [];
  for (const [mail, p] of [['nobody@example.com', proof], ['ada@example.com', { password: 'wrong' }], ['staff@example.com', proof], ['ada@example.com', { code: '123456' }]] as const) {
    await assert.rejects(() => deletions().verifyOwner(mail, p), (error: any) => { failures.push(`${error.statusCode}:${error.code}:${error.message}`); return true; });
  }
  assert.equal(new Set(failures).size, 1, failures.join(' | '));
});

test('a paid order in progress, or a pending refund, blocks the request; unpaid orders do not', async () => {
  const user = await customer();
  const id = user.id;
  await order(id, { commerceStatus: 'AWAITING_PAYMENT', commercePaymentStatus: 'PENDING' });
  assert.equal((await deletions().request(await deletions().verifyOwner('ada@example.com', proof), { source: 'web' })).state, 'scheduled');
  await AccountDeletionRequest.deleteMany({});
  await User.updateOne({ _id: id }, { $set: { accountStatus: 'active' } });

  const inFlight = await order(id, { commerceStatus: 'IN_TRANSIT' });
  await assert.rejects(
    () => deletions().request(user, { source: 'web' }),
    (error: any) => error.code === 'ACCOUNT_DELETION_BLOCKED' && error.details.orders.length === 1,
  );
  await Order.updateOne({ _id: inFlight }, { $set: { commerceStatus: 'DELIVERED' } });
  await FulfilmentRefund.collection.insertOne({ orderId: inFlight, status: 'PROVIDER_PENDING', amountMinor: 1, publicId: 'RF-1', idempotencyKey: 'k', createdAt: new Date(), updatedAt: new Date() } as any);
  await rejects(() => deletions().request(user, { source: 'web' }), 'ACCOUNT_DELETION_BLOCKED');
});

test('requesting closes the account, signs out every device and schedules erasure 14 days out', async () => {
  const user = await customer();
  const id = user.id;
  await AccountSession.create({ accountId: id, accountType: 'customer', familyId: 'f', refreshTokenHash: 'h', expiresAt: new Date(Date.now() + 1e9), lastUsedAt: new Date() } as any);
  await DeviceToken.create({ userId: id, expoPushToken: 'ExponentPushToken[abc]', isActive: true } as any);

  const view = await deletions().request(user, { reason: 'moving away', source: 'web' });
  assert.equal(view.state, 'scheduled');
  assert.equal(view.canCancel, true);
  const days = (new Date(view.scheduledFor!).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days < 14.1, `scheduled ${days} days out`);
  assert.equal(((await User.findById(id).lean()) as any).accountStatus, 'deletion_requested');
  assert.ok(((await AccountSession.findOne({ accountId: id }).lean()) as any).revokedAt);
  assert.equal(((await DeviceToken.findOne({ userId: id }).lean()) as any).isActive, false);
  const mail = sent.find((item) => item.kind === 'scheduled')!;
  assert.match(mail.cancelUrl!, /\/delete-account\/cancel\?token=/);
});

test('asking again, even simultaneously, never creates a second request', async () => {
  const user = await customer();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => deletions().request(user, { source: 'web' })));
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  assert.equal(await AccountDeletionRequest.countDocuments({ userId: user.id, status: 'cooling_off' }), 1);
  assert.equal(sent.filter((item) => item.kind === 'scheduled').length, 1, 'one confirmation email');
});

test('the customer can cancel with their password, and sign in again', async () => {
  const user = await customer();
  await deletions().request(user, { source: 'web' });
  const owner = await deletions().verifyOwner('ada@example.com', proof);
  assert.equal((await deletions().cancel({ user: owner })).state, 'none');
  assert.equal(((await User.findById(user.id).lean()) as any).accountStatus, 'active');
  assert.equal(((await AccountDeletionRequest.findOne({ userId: user.id }).lean()) as any).status, 'cancelled');
  assert.ok(sent.some((item) => item.kind === 'restored'));
  // and a fresh request afterwards is allowed
  assert.equal((await deletions().request(await deletions().verifyOwner('ada@example.com', proof), { source: 'web' })).state, 'scheduled');
});

test('the emailed cancel link works once', async () => {
  const user = await customer();
  await deletions().request(user, { source: 'web' });
  const token = new URL(sent.find((item) => item.kind === 'scheduled')!.cancelUrl!).searchParams.get('token')!;
  await deletions().cancel({ token });
  assert.equal(((await User.findById(user.id).lean()) as any).accountStatus, 'active');
  await rejects(() => deletions().cancel({ token }), 'NOT_FOUND');
  await rejects(() => deletions().cancel({ token: 'x'.repeat(43) }), 'NOT_FOUND');
});

test('signing in during the cooling-off window says so and gives the date, but only after the password is right', async () => {
  const user = await customer();
  await deletions().request(user, { source: 'web' });
  const auth = new AuthService(new MongoRepository(User) as any);
  await assert.rejects(
    () => auth.login('ada@example.com', proof.password, 'customer'),
    (error: any) => error.code === 'ACCOUNT_DELETION_SCHEDULED' && Boolean(error.details.scheduledFor),
  );
  await assert.rejects(() => auth.login('ada@example.com', 'wrong', 'customer'), (error: any) => error.message === 'Invalid email or password');
});

test('once erasure has started the request can no longer be cancelled', async () => {
  const user = await customer();
  await deletions().request(user, { source: 'web' });
  await AccountDeletionRequest.updateOne({ userId: user.id }, { $set: { status: 'erasing' } });
  await rejects(() => deletions().cancel({ user }), 'ACCOUNT_DELETION_IN_PROGRESS');
});

test('a support-closed account cannot be reopened by the customer', async () => {
  const user = await customer({ accountStatus: 'deletion_requested', isActive: false });
  await rejects(() => deletions().request(user, { source: 'web' }), 'ACCESS_DENIED');
});

test('google/apple accounts use an emailed code, which is single-use and burns after five wrong tries', async () => {
  await customer({ password: undefined, authProvider: 'google', googleId: 'g-1' });
  await rejects(() => deletions().verifyOwner('ada@example.com', { code: '000000' }), 'INVALID_CREDENTIALS');

  await deletions().sendCode('ada@example.com');
  const code = sent.find((item) => item.kind === 'code')!.code!;
  assert.match(code, /^\d{6}$/);
  assert.ok(!(await Otp.findOne({ type: 'account_deletion' }).lean() as any).code.includes(code), 'stored hashed');
  await deletions().sendCode('ada@example.com'); // throttled: no second email
  assert.equal(sent.filter((item) => item.kind === 'code').length, 1);

  await deletions().verifyOwner('ada@example.com', { code });
  await rejects(() => deletions().verifyOwner('ada@example.com', { code }), 'INVALID_CREDENTIALS'); // spent

  await Otp.deleteMany({});
  await deletions().sendCode('ada@example.com').catch(() => undefined);
  await Otp.updateMany({}, { $set: { createdAt: new Date(0) } });
  await deletions().sendCode('ada@example.com');
  const second = sent.filter((item) => item.kind === 'code').pop()!.code!;
  const wrong = second === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i += 1) await rejects(() => deletions().verifyOwner('ada@example.com', { code: wrong }), 'INVALID_CREDENTIALS');
  await rejects(() => deletions().verifyOwner('ada@example.com', { code: second }), 'INVALID_CREDENTIALS');

  // a password account can never be deleted with a code alone
  await User.updateOne({ email: 'ada@example.com' }, { $set: { password: await hashPassword('Correct-Horse-9') } });
  await deletions().sendCode('ada@example.com');
  assert.equal(sent.filter((item) => item.kind === 'code').length, 2, 'no code is sent for a password account');
});

async function scheduledAndDue() {
  const user = await customer();
  const id = user.id;
  const delivered = await order(id);
  await CustomerAddress.create({ publicId: 'ADR-1', customerId: id, label: 'Home', recipientName: 'Ada', phone: '0801', line1: '12 Allen', stateId: 's', stateCode: 'LA', stateName: 'Lagos', cityName: 'Ikeja', isDefault: true, status: 'active' } as any);
  await Notification.create({ userId: id, title: 't', body: 'b', type: 'x', eventKey: 'e1' } as any);
  await Negotiation.collection.insertOne({ customerId: id, publicId: 'NEG-1', transcript: [{ role: 'customer', message: 'my number is 0801' }, { role: 'system', message: 'ok' }], createdAt: new Date(), updatedAt: new Date() } as any);
  await deletions().request(user, { source: 'web' });
  await AccountDeletionRequest.updateOne({ userId: id }, { $set: { coolingOffUntil: new Date(Date.now() - 1000) } });
  return { id, delivered };
}

test('erasure removes personal data, keeps the financial record, and finishes exactly once', async () => {
  const { id, delivered } = await scheduledAndDue();
  assert.deepEqual(await erasure().runDue(), { erased: 1, deferred: 0 });

  const user = await User.findById(id).lean() as any;
  assert.equal(user.email, anonymizedEmail(id));
  assert.equal(user.accountStatus, 'anonymized');
  for (const field of ['phone', 'password', 'googleId', 'avatarUrl', 'referralCode']) assert.equal(user[field], undefined, field);
  assert.equal(user.firstName, 'Deleted');
  assert.equal(await CustomerAddress.countDocuments({ customerId: id }), 0);
  assert.equal(await Notification.countDocuments({ userId: id }), 0);
  assert.equal(await DeviceToken.countDocuments({ userId: id }), 0);

  const kept = await Order.findById(delivered).lean() as any;
  assert.equal(kept.totalMinor, 500_000, 'the money record stays');
  assert.deepEqual(kept.customerSnapshot, { name: 'Deleted customer', anonymized: true });
  assert.equal(kept.deliveryAddress.street, '');
  assert.equal(kept.deliveryAddress.city, 'Ikeja');
  assert.equal(kept.addressSnapshot.line1, undefined);
  assert.equal(kept.addressSnapshot.cityName, 'Ikeja');

  const negotiation = await Negotiation.findOne({ customerId: id }).lean() as any;
  assert.equal(negotiation.transcript[0].message, '[removed]');
  assert.equal(negotiation.transcript[1].message, 'ok');

  assert.equal(((await AccountDeletionRequest.findOne({ userId: id }).lean()) as any).status, 'anonymized');
  assert.ok(sent.some((item) => item.kind === 'deleted'));
  assert.deepEqual(await erasure().runDue(), { erased: 0, deferred: 0 }, 'nothing left to do');
  await rejects(() => deletions().verifyOwner('ada@example.com', proof), 'INVALID_CREDENTIALS');
});

test('a crash mid-erasure resumes at the failed step instead of starting over', async () => {
  const { id } = await scheduledAndDue();
  const service = erasure();
  const original = (service as any).scrubOrders.bind(service);
  let failures = 1;
  mock.method(service as any, 'scrubOrders', async (userId: string) => { if (failures-- > 0) throw new Error('simulated crash'); return original(userId); });

  assert.deepEqual(await service.runDue(), { erased: 0, deferred: 0 });
  let request = await AccountDeletionRequest.findOne({ userId: id }).lean() as any;
  assert.equal(request.status, 'erasing');
  assert.deepEqual(request.erasureSteps, ['cancel_unpaid', 'notify', 'delete_personal']);
  assert.equal(await CustomerAddress.countDocuments({ customerId: id }), 0, 'earlier steps are already done');

  await AccountDeletionRequest.updateOne({ userId: id }, { $set: { erasureStartedAt: new Date(Date.now() - 3_600_000) } });
  assert.deepEqual(await service.runDue(), { erased: 1, deferred: 0 });
  request = await AccountDeletionRequest.findOne({ userId: id }).lean() as any;
  assert.equal(request.status, 'anonymized');
  assert.equal(sent.filter((item) => item.kind === 'deleted').length, 1, 'the goodbye email is not repeated');
});

test('an order that starts during the cooling-off window defers erasure instead of being erased', async () => {
  const { id } = await scheduledAndDue();
  await order(id, { commerceStatus: 'IN_FULFILMENT' });
  assert.deepEqual(await erasure().runDue(), { erased: 0, deferred: 1 });
  const request = await AccountDeletionRequest.findOne({ userId: id }).lean() as any;
  assert.equal(request.status, 'cooling_off');
  assert.ok(request.deferredUntil > new Date());
  assert.equal(((await User.findById(id).lean()) as any).email, 'ada@example.com', 'nothing was erased');
  assert.deepEqual(await erasure().runDue(), { erased: 0, deferred: 0 }, 'not retried until the deferral ends');
});

test('an admin can pause erasure, and unpaid orders are cancelled rather than left dangling', async () => {
  const { id } = await scheduledAndDue();
  const unpaid = await order(id, { commerceStatus: 'AWAITING_PAYMENT', commercePaymentStatus: 'PENDING' });
  await AccountDeletionRequest.updateOne({ userId: id }, { $set: { paused: true } });
  assert.deepEqual(await erasure().runDue(), { erased: 0, deferred: 0 });
  await AccountDeletionRequest.updateOne({ userId: id }, { $set: { paused: false } });
  assert.deepEqual(await erasure().runDue(), { erased: 1, deferred: 0 });
  assert.equal(((await Order.findById(unpaid).lean()) as any).commerceStatus, 'CANCELLED');
});

test('one reminder goes out three days before erasure', async () => {
  const user = await customer();
  await deletions().request(user, { source: 'web' });
  await AccountDeletionRequest.updateOne({ userId: user.id }, { $set: { coolingOffUntil: new Date(Date.now() + 2 * 86_400_000) } });
  assert.deepEqual(await erasure().sendReminders(), { sent: 1 });
  assert.deepEqual(await erasure().sendReminders(), { sent: 0 });
  assert.ok(sent.some((item) => item.kind === 'reminder'));
});
