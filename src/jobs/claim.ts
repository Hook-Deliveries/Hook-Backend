import { getRedis, redisKey } from '@config/redis';
import { QUEUE_NAME } from './constants';
import type { JobDefinition } from './definitions';

/**
 * Backstop against duplicate ticks and overlapping runs. A run is claimed with
 * a short Redis lock sized to the job's interval, so a second delivery of the
 * same tick is skipped instead of executing twice. Both the BullMQ worker and
 * the in-process runner claim through here, so an API running its own jobs in
 * development and a separate worker never both execute the same tick.
 */
export async function claimRun(job: Pick<JobDefinition, 'name' | 'everyMs'>, queueName = QUEUE_NAME) {
  const redis = getRedis();
  if (!redis) return true;
  const ttl = job.everyMs ? Math.max(Math.floor(job.everyMs * 0.6), 500) : 30_000;
  try {
    return Boolean(await redis.set(redisKey('job-run', queueName, job.name), '1', 'PX', ttl, 'NX'));
  } catch {
    return true;
  }
}
