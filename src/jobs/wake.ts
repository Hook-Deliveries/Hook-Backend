import { Queue } from 'bullmq';
import { createBullConnection, redisConfigured } from '@config/redis';
import { QUEUE_NAME, bullPrefix } from './constants';

let queue: Queue | undefined;
let connection: ReturnType<typeof createBullConnection> | undefined;

/**
 * Nudges the worker to drain the outbox now instead of at its next 3 second
 * tick, so a confirmed payment reaches fulfilment and the customer's inbox in
 * well under a second. Purely a latency optimisation:
 *  - the outbox rows are already committed in MongoDB, so if Redis is down or
 *    the nudge is lost the scheduled drain delivers them anyway;
 *  - a fixed jobId collapses a burst of nudges into one pending job;
 *  - it never blocks or fails the caller.
 */
export function wakeOutbox() {
  if (!redisConfigured() || process.env.OUTBOX_WAKE === 'false') return;
  try {
    connection ??= createBullConnection();
    queue ??= new Queue(QUEUE_NAME, {
      connection,
      prefix: bullPrefix(),
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    });
    queue.on('error', () => undefined);
    void Promise.race([
      queue.add('outbox-drain', { wake: true }, { jobId: 'outbox-wake' }),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]).catch(() => undefined);
  } catch {
    // best effort
  }
}

export async function closeWakeQueue() {
  const current = queue;
  const conn = connection;
  queue = undefined;
  connection = undefined;
  await current?.close().catch(() => undefined);
  if (conn) await conn.quit().catch(() => conn.disconnect());
}
