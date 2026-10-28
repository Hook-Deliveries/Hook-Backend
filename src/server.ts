import dotenv from 'dotenv';
import type { Server } from 'http';
import mongoose from 'mongoose';
import { createApp } from './app';
import { assertSafeEnvironment } from './config/env';
import { disconnectDatabase, initializeDatabase } from './config/data-source';
import { ensurePlatformAccessCatalog } from './modules/platform/platform-bootstrap.service';
import { startInProcessJobs, stopInProcessJobs } from './jobs/in-process';
import { assertRedisConfig, closeRedis, connectRedis, describeRedis, type RedisStatus } from './config/redis';
import { closeWakeQueue } from './jobs/wake';
import { realtime } from './modules/platform/realtime.service';

dotenv.config({ quiet: true });

function printRuntimeServices() {
  const brevoReady = Boolean(
    process.env.BREVO_API_KEY &&
    !process.env.BREVO_API_KEY.includes('placeholder') &&
    process.env.BREVO_FROM_EMAIL,
  );

  console.log(brevoReady
    ? '📧 Brevo Email Service initialized'
    : '📧 Email Service initialized (console fallback)');
}

let redisStatus: RedisStatus = { state: 'not_configured' };

function printReady(port: number, apiPrefix: string) {
  const env = process.env.NODE_ENV || 'development';
  const serverUrl = env === 'production' && process.env.APP_URL?.startsWith('http')
    ? process.env.APP_URL
    : `http://localhost:${port}`;
  const apiUrl = `${serverUrl}/${apiPrefix}`;
  const docsUrl = `http://localhost:${port}/docs`;
  const rows = [
    ['Server', serverUrl],
    ['API', apiUrl],
    ['Docs', docsUrl],
    ['Env', env],
    ['DB', `MongoDB · ${mongoose.connection.name}`],
    ['Cache', describeRedis(redisStatus)],
  ] as const;
  // Each row renders as the label padded to 8 columns, then the value, inside 2+2 columns of margin.
  const width = Math.max(46, ...rows.map(([, value]) => 8 + value.length + 6));
  const line = (value: string) => `║  ${value.padEnd(width - 4)}║`;

  console.log(`
  ╔${'═'.repeat(width - 2)}╗
  ║${'HOOK API  ·  v1.0.0'.padStart(Math.floor((width - 2 + 19) / 2)).padEnd(width - 2)}║
  ╠${'═'.repeat(width - 2)}╣
${rows.map(([label, value]) => line(`${label.padEnd(8)}${value}`)).join('\n')}
  ╚${'═'.repeat(width - 2)}╝

  Routes
    GET   /health
    POST  /${apiPrefix}/auth/login
    GET   /${apiPrefix}/products
    GET   /${apiPrefix}/cart
    GET   /${apiPrefix}/orders
    GET   /${apiPrefix}/admin/dashboard
  `);
}

let server: Server | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received. Shutting down Hook API...`);
  stopInProcessJobs();
  realtime.close();

  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  await closeWakeQueue();
  await closeRedis();
  await disconnectDatabase();
  console.log('✅ Hook API stopped cleanly');
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function bootstrap() {
  assertSafeEnvironment();
  assertRedisConfig({ required: false });
  redisStatus = await connectRedis();
  if (redisStatus.state === 'connected') console.log(`✅ Redis Connected: ${redisStatus.target}`);
  else if (redisStatus.state === 'unreachable') console.warn(`⚠️ Redis unreachable at ${redisStatus.target}: caching, shared rate limits and queues are off; MongoDB is used instead`);
  else console.log('ℹ️ Redis not configured: caching, shared rate limits and queues are off');
  printRuntimeServices();
  await initializeDatabase();
  await ensurePlatformAccessCatalog();
  // Schedulers and the outbox drain belong to the worker process
  // (`npm run worker`) so N API instances do not run N copies of every job.
  // In-process jobs stay on by default outside production for one-command dev;
  // set WORKER_IN_PROCESS=true to force them on, false to force them off.
  const inProcess = process.env.WORKER_IN_PROCESS
    ? process.env.WORKER_IN_PROCESS === 'true'
    : process.env.NODE_ENV !== 'production';
  if (inProcess) {
    startInProcessJobs();
    console.log('⚙️ Background jobs running in-process (use `npm run worker` in production)');
  } else {
    console.log('⚙️ Background jobs are handled by the worker process');
  }

  const app = createApp();
  const port = Number(process.env.PORT || 4000);
  const apiPrefix = process.env.API_PREFIX || 'api/v1';

  server = app.listen(port, () => {
    printReady(port, apiPrefix);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  realtime.attach(server);
  startCacheWarmer(port, apiPrefix);
}

/**
 * Keeps the default public reads (the ones every app launch asks for) hot in
 * the cache, so a customer never pays for a cold database round trip.
 * Set CACHE_WARMER=off to disable.
 */
function startCacheWarmer(port: number, apiPrefix: string) {
  if (process.env.CACHE_WARMER === 'off' || process.env.NODE_ENV === 'test') return;
  const paths = ['/public/categories', '/public/categories?withProducts=true', '/public/markets', '/public/banners?placement=home', '/public/banners?placement=category', '/public/products?limit=20', '/public/discover?limit=30'];
  const warm = () => Promise.allSettled(paths.map((path) => fetch(`http://127.0.0.1:${port}/${apiPrefix}${path}`).then((response) => response.arrayBuffer())));
  setTimeout(() => void warm(), 3_000).unref();
  setInterval(() => void warm(), 15_000).unref();
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error('Failed to start Hook API');
  console.error(`Reason: ${message}`);
  console.error('');
  console.error('Database tip: npm run dev uses the complete MONGODB_URI from .env.');
  process.exit(1);
});
