import dotenv from 'dotenv';
import { assertSafeEnvironment } from './config/env';
import { assertRedisConfig, closeRedis, redisConfigured, redactRedisUrl, connectRedis } from './config/redis';
import { disconnectDatabase, initializeDatabase } from './config/data-source';
import { realtime } from './modules/platform/realtime.service';
import { startQueueWorker } from './jobs/queue';
import { startInProcessJobs, stopInProcessJobs } from './jobs/in-process';

dotenv.config({ quiet: true });

/**
 * Background worker entry point (`npm run worker`). Runs the outbox drain,
 * reconciliation and every scheduled job so API instances only serve requests.
 * Run as many replicas as you like: BullMQ schedulers keep each tick single.
 */
let closeQueue: (() => Promise<void>) | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received. Stopping Hook worker...`);
  // A stuck connection must not keep a redeploy waiting: give a clean stop 15s, then leave.
  setTimeout(() => process.exit(1), 15_000).unref();
  stopInProcessJobs();
  await closeQueue?.().catch(() => undefined);
  realtime.close();
  await closeRedis();
  await disconnectDatabase();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function main() {
  assertSafeEnvironment();
  const production = process.env.NODE_ENV === 'production';
  assertRedisConfig({ required: production });
  const redisStatus = await connectRedis();
  if (redisStatus.state === 'connected') console.log(`✅ Redis Connected: ${redisStatus.target}`);
  await initializeDatabase();
  // Lets outbox consumers publish realtime events to sockets held by API nodes.
  realtime.attachEmitterOnly();

  if (redisConfigured()) {
    const queue = await startQueueWorker();
    closeQueue = queue.close;
    console.log(`⚙️ Hook worker running on BullMQ (${redactRedisUrl()})`);
  } else {
    startInProcessJobs();
    console.log('⚙️ Hook worker running with in-process timers (REDIS_URL not set)');
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start Hook worker:', error instanceof Error ? error.message : error);
  process.exit(1);
});
