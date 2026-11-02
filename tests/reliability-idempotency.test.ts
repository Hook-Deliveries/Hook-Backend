import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { withIdempotency } from '../src/middleware/idempotency';
import { IdempotencyRecord } from '../src/models/platform/idempotency-record.model';
import { errorHandler, requestContext, HttpError } from '../src/utils/http';

let server: Server;
let base = '';
let executions = 0;
let failNext = false;

before(async () => {
  await startDatabase();
  await IdempotencyRecord.init();
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((req, _res, next) => { (req as any).user = { sub: 'user-1' }; next(); });
  app.post('/pay', withIdempotency({ operation: 'POST /pay', tier: 'financial' }), async (req, res) => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (failNext) { failNext = false; throw new HttpError(409, 'balance changed', undefined, 'CREDIT_BALANCE_CHANGED'); }
    res.status(201).json({ success: true, data: { charged: req.body.amount, run: executions } });
  });
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await stopDatabase(); });
beforeEach(async () => { executions = 0; failNext = false; await resetDatabase(); await IdempotencyRecord.init(); });

const post = (key: string | undefined, body: unknown) => fetch(`${base}/pay`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body),
});

test('a retry with the same key replays the stored response without running the handler again', async () => {
  const first = await post('key-12345678', { amount: 500 });
  assert.equal(first.status, 201);
  const second = await post('key-12345678', { amount: 500 });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(executions, 1);
});

test('the same key with a different body is rejected as a conflict', async () => {
  await post('key-12345678', { amount: 500 });
  const conflict = await post('key-12345678', { amount: 900 });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(executions, 1);
});

test('concurrent duplicates execute once; the loser is told the request is in progress', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => post('key-12345678', { amount: 500 })));
  assert.equal(executions, 1);
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  for (const response of results.filter((r) => r.status !== 201)) {
    assert.equal(((await response.json()) as any).error.code, 'OPERATION_IN_PROGRESS');
  }
});

test('a failed attempt releases the key so the corrected request can run', async () => {
  failNext = true;
  const failed = await post('key-12345678', { amount: 500 });
  assert.equal(failed.status, 409);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const retry = await post('key-12345678', { amount: 500 });
  assert.equal(retry.status, 201);
  assert.equal(executions, 2);
});

test('a missing key is rejected by default, and only warns when enforcement is switched off', async () => {
  const strict = await post(undefined, { amount: 1 });
  assert.equal(strict.status, 400);
  assert.equal(((await strict.json()) as any).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(executions, 0);

  process.env.IDEMPOTENCY_ENFORCE = 'false';
  try {
    const open = await post(undefined, { amount: 1 });
    assert.equal(open.status, 201);
    assert.ok(open.headers.get('x-idempotency-warning'));
  } finally {
    delete process.env.IDEMPOTENCY_ENFORCE;
  }
});

test('a custom fingerprint lets a retry with a fresh single-use token replay the original result', async () => {
  const { hashRequest } = await import('../src/middleware/idempotency');
  const fingerprint = () => ({ route: 'checkout' });
  const a = hashRequest({ params: {}, query: {}, body: { previewToken: 'one' } } as any, fingerprint);
  const b = hashRequest({ params: {}, query: {}, body: { previewToken: 'two' } } as any, fingerprint);
  assert.equal(a, b);
  const strictA = hashRequest({ params: {}, query: {}, body: { previewToken: 'one' } } as any);
  const strictB = hashRequest({ params: {}, query: {}, body: { previewToken: 'two' } } as any);
  assert.notEqual(strictA, strictB);
});
