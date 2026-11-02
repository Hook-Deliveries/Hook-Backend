import dotenv from 'dotenv';
import { assertSafeEnvironment } from './config/env';
import { assertRedisConfig, closeRedis, connectRedis } from './config/redis';
import { disconnectDatabase, initializeDatabase } from './config/data-source';
import { realtime } from './modules/platform/realtime.service';
import { closeEventBus, consumeDomain, EVENT_DOMAINS, eventBusEnabled, type EventDomain } from './modules/platform/event-bus';
import { processOutboxEvent } from './modules/platform/outbox.service';
import { buildOutboxHandlers } from './modules/platform/outbox-handlers';

dotenv.config({ quiet: true });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} received. Stopping Hook consumer...`);
  setTimeout(() => process.exit(1), 15_000).unref();
  await closeEventBus();
  realtime.close();
  await closeRedis();
  await disconnectDatabase();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function main() {
  const domain = process.env.EVENT_DOMAIN as EventDomain;
  if (!(domain in EVENT_DOMAINS)) throw new Error(`EVENT_DOMAIN must be one of: ${Object.keys(EVENT_DOMAINS).join(', ')}`);
  if (!eventBusEnabled()) throw new Error('EVENT_BUS_URL is required for a consumer');
  assertSafeEnvironment();
  assertRedisConfig({ required: process.env.NODE_ENV === 'production' });
  await connectRedis();
  await initializeDatabase();
  realtime.attachEmitterOnly();

  const all = buildOutboxHandlers();
  const handlers = Object.fromEntries(EVENT_DOMAINS[domain].map((type) => [type, all[type]]));
  await consumeDomain(domain, (publicId) => processOutboxEvent(publicId, handlers));
  console.log(`⚙️ Hook ${domain} consumer listening on hook.${domain}`);
}

main().catch((error: unknown) => {
  console.error('Failed to start Hook consumer:', error instanceof Error ? error.message : error);
  process.exit(1);
});
