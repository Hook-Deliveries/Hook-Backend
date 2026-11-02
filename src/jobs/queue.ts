import { Queue, Worker, type Job } from 'bullmq';
import { createBullConnection, getRedis, redisKey } from '@config/redis';
import { JOBS, type JobDefinition } from './definitions';
import { QUEUE_NAME, bullPrefix } from './constants';
import { claimRun } from './claim';

export { QUEUE_NAME, bullPrefix };

/**
 * Registers each recurring job as a BullMQ job scheduler. A scheduler has a
 * fixed id, so starting N workers still produces one job per tick, and only
 * one worker picks each up. If Redis is wiped, the schedulers are simply
 * re-registered on the next worker start; nothing durable lives in Redis
 * (pending business events are in the MongoDB outbox).
 */
export async function startQueueWorker(options: { concurrency?: number; jobs?: JobDefinition[]; queueName?: string } = {}) {
  const jobs = options.jobs ?? JOBS;
  const queueName = options.queueName ?? QUEUE_NAME;
  // BullMQ does not close connection instances it is handed, so keep them.
  const queueConnection = createBullConnection();
  const workerConnection = createBullConnection();
  const queue = new Queue(queueName, {
    connection: queueConnection,
    prefix: bullPrefix(),
    defaultJobOptions: { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 }, attempts: 1 },
  });
  await registerSchedulers(queue, queueName, jobs);

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const definition = jobs.find((item) => item.name === job.name);
      if (!definition) return;
      // A wake-up nudge only asks for an early drain; jobs are idempotent and
      // the outbox uses leases, so it may run right after a scheduled tick.
      if (!job.data?.wake && !(await claimRun(definition, queueName))) return { skipped: true };
      await definition.run();
    },
    {
      connection: workerConnection,
      prefix: bullPrefix(),
      concurrency: options.concurrency ?? 4,
      lockDuration: 120_000,
    },
  );
  worker.on('failed', (job, error) => {
    console.error(`[jobs] ${job?.name} failed`, error.message);
  });
  worker.on('error', (error) => console.error('[jobs] worker error', error.message));

  return {
    async close() {
      await worker.close();
      await queue.close();
      await Promise.all([queueConnection, workerConnection].map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}

/**
 * Two workers booting together (a deploy of N replicas) can both register the
 * same scheduler and leave TWO tick chains running forever. A short Redis lock
 * makes exactly one of them do the registration; the rest wait for it to exist.
 */
async function registerSchedulers(queue: Queue, queueName: string, jobs: JobDefinition[]) {
  const redis = getRedis();
  for (const job of jobs) {
    const pattern = job.cron ? { pattern: job.cron } : { every: job.everyMs as number };
    const lockKey = redisKey('sched-lock', queueName, job.name);
    const acquired = redis ? await redis.set(lockKey, '1', 'PX', 15_000, 'NX').catch(() => null) : 'OK';
    if (acquired) {
      try {
        await queue.upsertJobScheduler(job.name, pattern, { name: job.name });
      } finally {
        if (redis) await redis.del(lockKey).catch(() => undefined);
      }
    } else {
      // Another worker is registering it. Wait (bounded) until it exists.
      for (let i = 0; i < 30 && !(await queue.getJobScheduler(job.name)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}
