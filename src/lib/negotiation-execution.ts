import { AsyncLocalStorage } from 'node:async_hooks';
const execution = new AsyncLocalStorage<string>();
export function withNegotiationExecution<T>(owner: string, work: () => Promise<T>) { return execution.run(owner, work); }
/** Fence stale workers after a lease is recovered by another command. */
export function negotiationWriteFence() {
  const owner = execution.getStore();
  return owner ? { 'commandLock.owner': owner, 'commandLock.expiresAt': { $gt: new Date() } } : {};
}
