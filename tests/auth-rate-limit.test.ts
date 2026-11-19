import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { authLimiter, sessionLimiter } from '../src/middleware/security';

/** Runs a limiter as Express would and resolves with what it handed to next(): nothing when allowed, an error when limited. */
function hit(limiter: (req: Request, res: Response, next: (error?: unknown) => void) => void, ip: string) {
  const req = { ip, socket: {}, user: undefined } as unknown as Request;
  const res = { setHeader() {} } as unknown as Response;
  return new Promise<any>((resolve) => limiter(req, res, (error?: unknown) => resolve(error)));
}

test('sign-in routes allow a normal amount of use, then stop guessing at the limit', async () => {
  const ip = '203.0.113.10';
  // A signup alone takes several requests, so the limit must leave room for more than a handful of attempts.
  for (let i = 0; i < 40; i += 1) assert.equal(await hit(authLimiter, ip), undefined, `request ${i + 1} is allowed`);
  let limited: any;
  for (let i = 40; i < 70 && !limited; i += 1) limited = await hit(authLimiter, ip);
  assert.equal(limited?.statusCode, 429);
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.match(limited.message, /Too many authentication attempts/);
});

test('session calls such as loading the profile never use up the sign-in allowance', async () => {
  const ip = '203.0.113.20';
  // A portal page makes these calls just by being open, so hundreds in a quarter hour are normal.
  for (let i = 0; i < 200; i += 1) assert.equal(await hit(sessionLimiter, ip), undefined);
  // And they do not count against sign-in for the same address.
  assert.equal(await hit(authLimiter, ip), undefined);
});

test('one address being limited does not limit another', async () => {
  for (let i = 0; i < 80; i += 1) await hit(authLimiter, '203.0.113.30');
  assert.equal(await hit(authLimiter, '203.0.113.31'), undefined);
});
