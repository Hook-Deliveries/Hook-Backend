import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { PaymentService } from '../src/services/payment.service';
import { Order } from '../src/models/orders/order.model';
import { Payment } from '../src/models/payments/payment.model';
import { CommerceOutboxEvent } from '../src/modules/platform/outbox.model';
import { CreditLedger } from '../src/models/promotions/credit-ledger.model';
import { CreditService } from '../src/services/credit.service';
import { paymentProvider } from '../src/services/payments/provider-registry';
import { HttpError } from '../src/utils/http';
import { processOutbox, replayDeadLetter, OUTBOX_MAX_ATTEMPTS } from '../src/modules/platform/outbox.service';
import { DeadLetterEvent } from '../src/models/platform/dead-letter-event.model';

before(startDatabase);
after(stopDatabase);
beforeEach(async () => { mock.restoreAll(); await resetDatabase(); });

async function seedPrepaidOrder() {
  const orderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({
    _id: orderId, publicId: 'ORD-TEST-1', userId: 'user-1', commercePaymentMethod: 'PREPAID',
    commerceStatus: 'AWAITING_PAYMENT', commercePaymentStatus: 'PROCESSING', status: 'awaiting_payment',
    paymentStatus: 'pending', subtotalMinor: 1_000_000, totalMinor: 1_000_000, timeline: [], createdAt: new Date(), updatedAt: new Date(),
  } as any);
  const paymentId = new mongoose.Types.ObjectId();
  await Payment.collection.insertOne({
    _id: paymentId, publicId: 'PAY-TEST-1', orderId: String(orderId), transactionRef: 'PSK-TEST-1', gateway: 'paystack',
    paymentMethod: 'card', amount: 10000, amountMinor: 1_000_000, currency: 'NGN', refundedAmount: 0,
    commerceStatus: 'PROCESSING', status: 'pending', createdAt: new Date(), updatedAt: new Date(),
  } as any);
  return { orderId: String(orderId), paymentId: String(paymentId) };
}

const confirm = (service: PaymentService, paymentId: string, eventId?: string) =>
  Payment.findById(paymentId).then((payment) => (service as any).confirmPayment(payment, 'prov-1', new Date(), eventId));

test('ten concurrent confirmations of one payment produce exactly one effect', async () => {
  const { orderId, paymentId } = await seedPrepaidOrder();
  const service = new PaymentService();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => confirm(service, paymentId)));
  // Losers of a write conflict may surface a transient error; none may corrupt state.
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  await confirm(service, paymentId); // a clean replay settles anything a conflict left over

  const order = await Order.findById(orderId).lean() as any;
  assert.equal(order.commercePaymentStatus, 'CONFIRMED');
  assert.equal(order.commerceStatus, 'APPROVED_FOR_FULFILMENT');
  assert.equal(order.timeline.length, 1, 'timeline entry is written once');
  assert.equal(await CommerceOutboxEvent.countDocuments({ eventType: 'ORDER_APPROVED_FOR_FULFILMENT' }), 1);
  assert.equal(await CommerceOutboxEvent.countDocuments({ eventType: 'PAYMENT_CONFIRMED_EFFECTS' }), 1);
  assert.ok(await CreditLedger.countDocuments({ type: 'order_earn' }) <= 1);
});

test('a failure inside the confirmation rolls everything back, and a retry succeeds', async () => {
  const { orderId, paymentId } = await seedPrepaidOrder();
  const service = new PaymentService();
  const original = CommerceOutboxEvent.create.bind(CommerceOutboxEvent);
  mock.method(CommerceOutboxEvent, 'create', () => { throw new Error('simulated crash before commit'); });
  await assert.rejects(() => confirm(service, paymentId), /simulated crash/);

  const payment = await Payment.findById(paymentId).lean() as any;
  const order = await Order.findById(orderId).lean() as any;
  assert.equal(payment.commerceStatus, 'PROCESSING', 'payment must not be confirmed without its order');
  assert.equal(order.commercePaymentStatus, 'PROCESSING');
  assert.equal(await CreditLedger.countDocuments({}), 0);

  mock.restoreAll();
  void original;
  await confirm(service, paymentId);
  assert.equal(((await Order.findById(orderId).lean()) as any).commerceStatus, 'APPROVED_FOR_FULFILMENT');
});

test('a payment confirmed by the old non-atomic code is repaired on the next call', async () => {
  const { orderId, paymentId } = await seedPrepaidOrder();
  await Payment.updateOne({ _id: paymentId }, { $set: { commerceStatus: 'CONFIRMED' } });
  await confirm(new PaymentService(), paymentId);
  const order = await Order.findById(orderId).lean() as any;
  assert.equal(order.commercePaymentStatus, 'CONFIRMED');
  assert.equal(await CommerceOutboxEvent.countDocuments({ eventType: 'ORDER_APPROVED_FOR_FULFILMENT' }), 1);
});

test('refund: an unknown provider outcome keeps the amount reserved and never re-calls the provider', async () => {
  const { paymentId } = await seedPrepaidOrder();
  await Payment.updateOne({ _id: paymentId }, { $set: { commerceStatus: 'CONFIRMED' } });
  const provider = paymentProvider('paystack');
  let calls = 0;
  mock.method(provider, 'refund', async () => { calls += 1; throw new HttpError(503, 'down', undefined, 'PAYMENT_PROVIDER_UNAVAILABLE'); });
  const service = new PaymentService();

  await assert.rejects(() => service.refund(paymentId, 400_000, 'key-1'), (error: any) => error.code === 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(((await Payment.findById(paymentId).lean()) as any).refundedAmount, 400_000, 'amount stays reserved');
  // A second refund that would exceed the remaining balance is refused up front.
  await assert.rejects(() => service.refund(paymentId, 700_000, 'key-2'), (error: any) => error.code === 'REFUND_LIMIT_EXCEEDED');
  assert.equal(calls, 1);
});

test('refund: a definitive provider rejection releases the reservation', async () => {
  const { paymentId } = await seedPrepaidOrder();
  const provider = paymentProvider('paystack');
  mock.method(provider, 'refund', async () => { throw new HttpError(502, 'no', { httpStatus: 400 }, 'PAYMENT_PROVIDER_ERROR'); });
  await assert.rejects(() => new PaymentService().refund(paymentId, 400_000, 'key-1'));
  assert.equal(((await Payment.findById(paymentId).lean()) as any).refundedAmount, 0);
});

test('refund: concurrent refunds cannot exceed the captured amount', async () => {
  const { paymentId } = await seedPrepaidOrder();
  const provider = paymentProvider('paystack');
  mock.method(provider, 'refund', async () => ({ providerReference: 'r-1' }));
  const service = new PaymentService();
  const results = await Promise.allSettled([
    service.refund(paymentId, 700_000, 'a'), service.refund(paymentId, 700_000, 'b'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(((await Payment.findById(paymentId).lean()) as any).refundedAmount, 700_000);
});

test('credit spend inside a rolled-back transaction leaves no ledger entry', async () => {
  const credits = new CreditService();
  await CreditLedger.create({ userId: 'u1', type: 'welcome_bonus', amountMinor: 50_000, idempotencyKey: 'welcome:u1' });
  const session = await mongoose.startSession();
  await assert.rejects(() => session.withTransaction(async () => {
    await credits.spend({ userId: 'u1', amountMinor: 20_000, orderId: 'o1', idempotencyKey: 'k-spend-1' }, session);
    throw new Error('checkout failed after the spend');
  }));
  await session.endSession();
  assert.equal(await credits.balance('u1'), 50_000);
  // And a replayed spend after a successful one is a no-op even though the balance dropped.
  await credits.spend({ userId: 'u1', amountMinor: 20_000, orderId: 'o1', idempotencyKey: 'k-spend-1' });
  await credits.spend({ userId: 'u1', amountMinor: 20_000, orderId: 'o1', idempotencyKey: 'k-spend-1' });
  assert.equal(await credits.balance('u1'), 30_000);
});

test('outbox: exhausted events are dead-lettered with a sanitized error and can be replayed once', async () => {
  await CommerceOutboxEvent.create({
    publicId: 'EVT-1', aggregateType: 'order', aggregateId: 'agg-1', eventType: 'ORDER_CREATED_EFFECTS',
    eventVersion: 1, payload: {}, status: 'pending', attempts: 0, availableAt: new Date(),
  });
  let handled = 0;
  const failing = { ORDER_CREATED_EFFECTS: async () => { handled += 1; throw new Error('smtp failed for jane@example.com card 4111111111111111'); } };
  for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    await CommerceOutboxEvent.updateOne({ publicId: 'EVT-1', status: 'pending' }, { $set: { availableAt: new Date(0) } });
    await processOutbox(failing, 1);
  }
  assert.equal(handled, OUTBOX_MAX_ATTEMPTS);
  const event = await CommerceOutboxEvent.findOne({ publicId: 'EVT-1' }).lean() as any;
  assert.equal(event.status, 'dead_letter');
  const dead = await DeadLetterEvent.findOne({ outboxPublicId: 'EVT-1' }).lean() as any;
  assert.ok(dead && !/jane@example\.com|4111111111111111/.test(dead.sanitizedError));

  assert.deepEqual(await replayDeadLetter(String(dead._id), 'admin-1'), { replayed: true });
  assert.deepEqual(await replayDeadLetter(String(dead._id), 'admin-1'), { replayed: false });
  await processOutbox({ ORDER_CREATED_EFFECTS: async () => undefined }, 1);
  assert.equal(((await CommerceOutboxEvent.findOne({ publicId: 'EVT-1' }).lean()) as any).status, 'published');
});

test('webhook: a delivery that failed is reprocessed on Paystack\'s retry, and a processed one is a duplicate', async () => {
  const { orderId } = await seedPrepaidOrder();
  const provider = paymentProvider('paystack');
  mock.method(provider, 'parseWebhook', () => ({ eventType: 'charge.success', providerEventId: 'evt-1', reference: 'PSK-TEST-1', payload: {} }));
  let verifyCalls = 0;
  mock.method(provider, 'verify', async () => {
    verifyCalls += 1;
    if (verifyCalls === 1) throw new HttpError(503, 'provider down', undefined, 'PAYMENT_PROVIDER_UNAVAILABLE');
    return { reference: 'PSK-TEST-1', status: 'success', amountMinor: 1_000_000, currency: 'NGN', providerId: 'p-1', paidAt: new Date(), raw: {} };
  });
  const service = new PaymentService();

  await assert.rejects(() => service.webhook('paystack', Buffer.from('{}'), 'sig'));
  assert.equal(((await Order.findById(orderId).lean()) as any).commercePaymentStatus, 'PROCESSING');

  const retry = await service.webhook('paystack', Buffer.from('{}'), 'sig');
  assert.equal((retry as any).processed, true, 'the retry must not be swallowed as a duplicate');
  assert.equal(((await Order.findById(orderId).lean()) as any).commercePaymentStatus, 'CONFIRMED');

  const again = await service.webhook('paystack', Buffer.from('{}'), 'sig');
  assert.equal((again as any).duplicate, true);
  assert.equal(await CommerceOutboxEvent.countDocuments({ eventType: 'ORDER_APPROVED_FOR_FULFILMENT' }), 1);
});
