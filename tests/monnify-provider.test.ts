import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { MonnifyProvider } from '../src/modules/payments/providers/monnify.provider';
import { HttpError } from '../src/utils/http';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MONNIFY_API_KEY = 'test-api-key';
  process.env.MONNIFY_SECRET_KEY = 'test-secret-key';
  process.env.MONNIFY_CONTRACT_CODE = 'test-contract';
  process.env.MONNIFY_BASE_URL = 'https://sandbox.monnify.com';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mock.restoreAll();
});

function mockLoginThen(responses: Array<{ ok?: boolean; body: unknown }>) {
  let call = 0;
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(String(url));
    const step = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: step.ok ?? true,
      json: async () => step.body,
    } as Response;
  });
  return urls;
}

test('parseWebhook accepts a correctly signed payload and rejects a tampered one', () => {
  const provider = new MonnifyProvider();
  const body = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'REF-1' }, transactionReference: 'TXN-1' }));
  const signature = createHash('sha512').update(`test-secret-key${body.toString('utf8')}`).digest('hex');

  const parsed = provider.parseWebhook(body, signature);
  assert.equal(parsed.eventType, 'SUCCESSFUL_TRANSACTION');
  assert.equal(parsed.reference, 'REF-1');
  assert.equal(parsed.providerEventId, 'TXN-1');

  assert.throws(
    () => provider.parseWebhook(body, 'not-the-right-signature-0000000000000000000000000000000000000000000000000000000000000000000000'),
    (error: HttpError) => error.statusCode === 401 && error.code === 'WEBHOOK_SIGNATURE_INVALID',
  );
});

test('verify() queries by paymentReference (not the transactionReference-only path endpoint) and maps PAID to success', async () => {
  const urls = mockLoginThen([
    { body: { requestSuccessful: true, responseBody: { accessToken: 'tok', expiresIn: 3600 } } },
    { body: { requestSuccessful: true, responseBody: {
      paymentReference: 'REF-1', paymentStatus: 'PAID', amountPaid: '5000.00', currency: 'NGN',
      transactionReference: 'TXN-1', paidOn: '01/01/2026 01:02:03 PM',
    } } },
  ]);
  const provider = new MonnifyProvider();
  const result = await provider.verify('REF-1');
  assert.equal(result.status, 'success');
  assert.equal(result.amountMinor, 500000);
  assert.equal(result.currency, 'NGN');
  assert.equal(result.providerId, 'TXN-1');
  assert.equal(result.paidAt?.toISOString(), new Date(2026, 0, 1, 13, 2, 3).toISOString());
  assert.match(urls[1], /\/api\/v2\/merchant\/transactions\/query\?paymentReference=REF-1$/);
});

test('verify() maps a non-paid status through without forcing "success"', async () => {
  mockLoginThen([
    { body: { requestSuccessful: true, responseBody: { accessToken: 'tok', expiresIn: 3600 } } },
    { body: { requestSuccessful: true, responseBody: {
      paymentReference: 'REF-2', paymentStatus: 'PENDING', amountPaid: '0.00', currency: 'NGN', transactionReference: 'TXN-2',
    } } },
  ]);
  const provider = new MonnifyProvider();
  const result = await provider.verify('REF-2');
  assert.equal(result.status, 'pending');
});

test('refund() refuses to run until MONNIFY_DISBURSEMENT_ENABLED is set', async () => {
  delete process.env.MONNIFY_DISBURSEMENT_ENABLED;
  const provider = new MonnifyProvider();
  await assert.rejects(
    () => provider.refund({ reference: 'REF-1', amountMinor: 1000 }),
    (error: HttpError) => error.statusCode === 503 && error.code === 'PAYMENT_PROVIDER_UNAVAILABLE',
  );
});

test('readiness() reports configured only once all three credentials are set', () => {
  delete process.env.MONNIFY_CONTRACT_CODE;
  const provider = new MonnifyProvider();
  assert.equal(provider.readiness().configured, false);
  process.env.MONNIFY_CONTRACT_CODE = 'test-contract';
  assert.equal(new MonnifyProvider().readiness().configured, true);
});
