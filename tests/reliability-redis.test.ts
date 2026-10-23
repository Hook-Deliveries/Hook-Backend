import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';

dotenv.config({ quiet: true });
// Every key this suite writes lives under a unique prefix and is removed at the end.
const PREFIX = `hook:test:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}:`;
process.env.REDIS_KEY_PREFIX = PREFIX;
const enabled = Boolean(process.env.REDIS_URL);
const opts = { skip: enabled ? false : 'REDIS_URL is not set' };

import { getRedis, closeRedis, createBullConnection, redisKey, warmRedis } from '../src/config/redis';
import { sharedCache } from '../src/modules/platform/cache.service';
import { publicCatalogCache } from '../src/lib/ttl-cache';
import { startQueueWorker, bullPrefix } from '../src/jobs/queue';
import { wakeOutbox, closeWakeQueue } from '../src/jobs/wake';
import { rateLimit } from '../src/middleware/security';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => { if (enabled) assert.equal(await warmRedis(8_000), true, 'Redis did not become ready'); });
after(async () => {
  if (!enabled) return;
  await closeWakeQueue();
  const redis = getRedis()!;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
  await closeRedis();
});

test('cache: a stored value is served from Redis after the local tier is cleared', opts, async () => {
  const first = await sharedCache.lookup<any>('t1', 'k');
  assert.equal(first.hit, false);
  await first.store({ hello: 'world' }, 10_000);
  publicCatalogCache.clear();
  const second = await sharedCache.lookup<any>('t1', 'k');
  assert.equal(second.hit, true);
  assert.deepEqual(second.value, { hello: 'world' });
});

test('cache: bumping the version invalidates every node at once', opts, async () => {
  const seed = await sharedCache.lookup<any>('t2', 'k');
  await seed.store({ v: 1 }, 10_000);
  await sharedCache.bumpVersion('t2');
  publicCatalogCache.clear();
  assert.equal((await sharedCache.lookup<any>('t2', 'k')).hit, false);
});

test('cache: data loaded before an invalidation is never published after it', opts, async () => {
  publicCatalogCache.clear();
  const lookup = await sharedCache.lookup<any>('t3', 'k');
  assert.equal(lookup.hit, false);
  // ...the caller is reading MongoDB when an admin changes the catalog:
  sharedCache.noteInvalidated('t3');
  await sharedCache.bumpVersion('t3');
  await lookup.store({ stale: true }, 10_000);
  publicCatalogCache.clear();
  assert.equal((await sharedCache.lookup<any>('t3', 'k')).hit, false, 'stale value must not be served');
});

test('cache: concurrent misses share one load', opts, async () => {
  publicCatalogCache.clear();
  let loads = 0;
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    sharedCache.remember('t4', 'hot', 10_000, async () => { loads += 1; await sleep(50); return { n: 1 }; })));
  assert.equal(loads, 1);
  assert.ok(results.every((value) => value.n === 1));
});

test('cache: a Redis failure degrades to the loader instead of failing the request', opts, async () => {
  publicCatalogCache.clear();
  const redis = getRedis()!;
  mock.method(redis, 'get', async () => { throw new Error('command timed out'); });
  mock.method(redis, 'set', async () => { throw new Error('command timed out'); });
  try {
    const value = await sharedCache.remember('t5', 'k', 10_000, async () => ({ fromMongo: true }));
    assert.deepEqual(value, { fromMongo: true });
  } finally {
    mock.restoreAll();
  }
});

test('rate limiter: the counter lives in Redis, so limits hold across instances', opts, async () => {
  const limiter = rateLimit(`t${Date.now()}`, { windowMs: 5_000, max: 2 });
  const call = () => new Promise<unknown>((resolve) => {
    const req: any = { ip: '203.0.113.9', socket: {}, user: undefined };
    const res: any = { setHeader() {} };
    limiter(req, res, (error?: unknown) => resolve(error));
  });
  assert.equal(await call(), undefined);
  assert.equal(await call(), undefined);
  const third: any = await call();
  assert.equal(third?.statusCode, 429);
});

test('bullmq: two workers running the same schedule execute each tick once', opts, async () => {
  const runs: number[] = [];
  const jobs = [{ name: 'tick', everyMs: 400, run: async () => { runs.push(Date.now()); } }];
  const queueName = `test-jobs-${Date.now().toString(36)}`;
  const a = await startQueueWorker({ jobs, queueName });
  const b = await startQueueWorker({ jobs, queueName });
  await sleep(2_600);
  await a.close();
  await b.close();
  assert.ok(runs.length >= 3, `expected several runs, got ${runs.length}`);
  const gaps = runs.slice(1).map((time, index) => time - runs[index]);
  assert.ok(Math.min(...gaps) >= 150, `ticks were duplicated across workers (gaps ${gaps.join(',')})`);
  const conn = createBullConnection();
  const queue = new Queue(queueName, { connection: conn, prefix: bullPrefix() });
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await conn.quit();
});

test('bullmq: a burst of outbox wake-ups collapses into one pending job', opts, async () => {
  for (let i = 0; i < 8; i += 1) wakeOutbox();
  const conn = createBullConnection();
  const queue = new Queue('hook-jobs', { connection: conn, prefix: bullPrefix() });
  // The remote Redis can be slow to receive the adds, so wait for the first one to land (up to 8s) instead of guessing a fixed delay.
  let counts = await queue.getJobCounts('waiting', 'delayed', 'active');
  for (let i = 0; i < 16 && counts.waiting + counts.delayed + counts.active === 0; i += 1) {
    await sleep(500);
    counts = await queue.getJobCounts('waiting', 'delayed', 'active');
  }
  await sleep(1_000);
  counts = await queue.getJobCounts('waiting', 'delayed', 'active');
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await conn.quit();
  assert.equal(counts.waiting + counts.delayed + counts.active, 1);
  void redisKey;
});
