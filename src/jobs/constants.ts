import { redisKey } from '@config/redis';

/**
 * Kept free of service imports on purpose: services call wakeOutbox(), and
 * queue.ts pulls in every job (and so every service). Importing those from here
 * would create a require cycle that crashes the API at boot.
 */
export const QUEUE_NAME = 'hook-jobs';
export const bullPrefix = () => redisKey('bull').replace(/:$/, '');
