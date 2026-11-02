import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { startDatabase, resetDatabase, stopDatabase } from './helpers/replset';
import { createPublicRouter } from '../src/routes/public';
import { errorHandler, requestContext } from '../src/utils/http';
import { hashPassword } from '../src/lib/security';
import { User } from '../src/models/users/user.model';
import { AccountDeletionRequest } from '../src/models/support/account-deletion-request.model';

let server: Server;
let base = '';

before(async () => {
  await startDatabase();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(requestContext);
  app.use(createPublicRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await stopDatabase(); });
// Each test uses its own client IP so the per-IP throttle never crosses tests.
let ip = 0;
beforeEach(async () => { ip += 1; await resetDatabase(); await AccountDeletionRequest.init(); });

const call = (path: string, body: unknown) => fetch(`${base}/public/account-deletion/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ip}` },
  body: JSON.stringify(body),
});
async function customer(email = 'ada@example.com') {
  await User.create({ email, password: await hashPassword('Correct-Horse-9'), firstName: 'Ada', lastName: 'Obi', role: 'shopper', accountType: 'customer', accountStatus: 'active', isActive: true } as any);
}

test('the whole web journey: request, check status, change your mind', async () => {
  await customer();
  const requested = await call('request', { email: 'Ada@Example.com', password: 'Correct-Horse-9', reason: 'leaving' });
  assert.equal(requested.status, 200);
  const view = ((await requested.json()) as any).data;
  assert.equal(view.state, 'scheduled');
  assert.equal(view.canCancel, true);

  const status = ((await (await call('status', { email: 'ada@example.com', password: 'Correct-Horse-9' })).json()) as any).data;
  assert.equal(status.state, 'scheduled');

  const cancelled = await call('cancel', { email: 'ada@example.com', password: 'Correct-Horse-9' });
  assert.equal(cancelled.status, 200);
  assert.equal((((await cancelled.json()) as any).data).state, 'none');
  assert.equal(((await User.findOne({ email: 'ada@example.com' }).lean()) as any).accountStatus, 'active');
});

test('bad input and bad credentials get clear, non-leaking answers', async () => {
  await customer();
  assert.equal((await call('request', { email: 'ada@example.com' })).status, 400, 'no proof at all');
  assert.equal((await call('request', { email: 'ada@example.com', password: 'x', code: '123456' })).status, 400, 'both proofs');
  assert.equal((await call('request', { email: 'not-an-email', password: 'x' })).status, 400);
  const wrong = await call('request', { email: 'ada@example.com', password: 'nope' });
  const unknown = await call('request', { email: 'ghost@example.com', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(((await wrong.json()) as any).error, ((await unknown.json()) as any).error);
});

test('the code endpoint never reveals whether an account exists, and is throttled per email', async () => {
  const known = await call('code', { email: 'ada@example.com' });
  const unknown = await call('code', { email: 'ghost@example.com' });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(((await known.json()) as any).message, ((await unknown.json()) as any).message);
  await call('code', { email: 'ada@example.com' });
  await call('code', { email: 'ada@example.com' });
  assert.equal((await call('code', { email: 'ada@example.com' })).status, 429);
});

test('repeated wrong passwords against one account are throttled, even from different addresses', async () => {
  await customer('bob@example.com');
  const statuses: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const response = await fetch(`${base}/public/account-deletion/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
      body: JSON.stringify({ email: 'bob@example.com', password: `guess-${i}` }),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.slice(0, 8).every((status) => status === 401));
  assert.ok(statuses.slice(8).every((status) => status === 429), statuses.join(','));
  // and the right password is locked out too, for now
  const locked = await fetch(`${base}/public/account-deletion/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'Correct-Horse-9' }),
  });
  assert.equal(locked.status, 429);
});
