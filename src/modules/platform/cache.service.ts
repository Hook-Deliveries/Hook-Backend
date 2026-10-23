import { publicCatalogCache } from '@lib/ttl-cache';
import { getRedis, redisKey } from '@config/redis';

/**
 * Two-tier read cache for PUBLIC, non-financial data (catalog, categories,
 * geography).
 *
 *   L1  in-process TtlCache: fastest, per node, cleared on every node by the
 *       realtime invalidation channel.
 *   L2  Redis: shared by every API node, so a cold node or a fresh deploy does
 *       not stampede MongoDB.
 *
 * Correctness rules:
 *  - Never use it for price, stock, quote validity, payment status, balances,
 *    permissions or checkout totals. Those are read from MongoDB every time.
 *  - L2 keys embed a namespace VERSION. Invalidation bumps the version; old
 *    entries simply stop being read and expire on their own TTL.
 *  - A lookup captures the version (and a local epoch) BEFORE the caller
 *    reads MongoDB. If an invalidation lands while the caller is loading,
 *    store() writes under the old, already-dead version, so stale data can
 *    never be published under the new one.
 *  - Redis being unset, slow or down only means a miss: the caller loads from
 *    MongoDB and carries on. Nothing here can fail a request.
 */

const MAX_VALUE_BYTES = 512 * 1024;
const L2_JITTER = 0.2;

const stats = { l1Hits: 0, l2Hits: 0, misses: 0, stores: 0, redisErrors: 0, skippedLarge: 0 };
const epochs = new Map<string, number>();

function epoch(ns: string) {
  return epochs.get(ns) || 0;
}

const versionKey = (ns: string) => redisKey('cache', ns, 'version');
const dataKey = (ns: string, version: string, key: string) => redisKey('cache', ns, `v${version}`, key);

function noteRedisError(error: unknown) {
  stats.redisErrors += 1;
  if (stats.redisErrors === 1 || stats.redisErrors % 100 === 0) {
    console.warn('[cache] Redis error, serving from MongoDB:', error instanceof Error ? error.message : error);
  }
}

export type CacheLookup<T> = {
  hit: boolean;
  value?: T;
  /** Publishes the loaded value to both tiers, unless an invalidation happened meanwhile. */
  store: (value: T, ttlMs?: number) => Promise<void>;
};

const inflight = new Map<string, Promise<unknown>>();

// The namespace version is read on every lookup; remember it briefly so a hit costs one Redis round trip, not two.
const versionMemo = new Map<string, { value: string; until: number }>();
const VERSION_MEMO_MS = 3_000;

export const sharedCache = {
  /**
   * Looks a key up in L1 then L2. On a miss the caller loads from MongoDB and
   * calls store(). Public catalog keys are namespaced 'catalog'.
   */
  async lookup<T>(ns: string, key: string, defaultTtlMs = 20_000): Promise<CacheLookup<T>> {
    const startEpoch = epoch(ns);
    const l1 = publicCatalogCache.get(key) as T | undefined;
    if (l1 !== undefined) {
      stats.l1Hits += 1;
      return { hit: true, value: l1, store: async () => undefined };
    }

    let version = '0';
    const redis = getRedis();
    if (redis) {
      try {
        const memo = versionMemo.get(ns);
        if (memo && memo.until > Date.now()) version = memo.value;
        else {
          version = (await redis.get(versionKey(ns))) || '0';
          versionMemo.set(ns, { value: version, until: Date.now() + VERSION_MEMO_MS });
        }
        const raw = await redis.get(dataKey(ns, version, key));
        if (raw) {
          const value = JSON.parse(raw) as T;
          stats.l2Hits += 1;
          if (epoch(ns) === startEpoch) publicCatalogCache.set(key, value, Math.min(defaultTtlMs, 15_000));
          return { hit: true, value, store: async () => undefined };
        }
      } catch (error) {
        noteRedisError(error);
      }
    }

    stats.misses += 1;
    return {
      hit: false,
      store: async (value, ttlMs = defaultTtlMs) => {
        // An invalidation since the lookup means the loaded data may predate it.
        if (epoch(ns) !== startEpoch) return;
        publicCatalogCache.set(key, value as never, ttlMs);
        if (!redis) return;
        try {
          const payload = JSON.stringify(value);
          if (payload.length > MAX_VALUE_BYTES) {
            stats.skippedLarge += 1;
            return;
          }
          const jittered = Math.round(ttlMs * (1 + (Math.random() * 2 - 1) * L2_JITTER));
          // Same lifetime as L1 (plus jitter), so shared entries are no staler
          // than the per-process ones they replace.
          await redis.set(dataKey(ns, version, key), payload, 'PX', Math.max(jittered, 1_000));
          stats.stores += 1;
        } catch (error) {
          noteRedisError(error);
        }
      },
    };
  },

  /**
   * Convenience for loaders that do not need the lookup handle. Concurrent
   * misses for one key share a single load (request coalescing).
   */
  async remember<T>(ns: string, key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const lookup = await this.lookup<T>(ns, key, ttlMs);
    if (lookup.hit) return lookup.value as T;
    const flightKey = `${ns}::${key}`;
    const existing = inflight.get(flightKey) as Promise<T> | undefined;
    if (existing) return existing;
    const flight = (async () => {
      const value = await loader();
      await lookup.store(value, ttlMs);
      return value;
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, flight);
    return flight;
  },

  /** Every node calls this when it learns a namespace changed: drop local state. */
  noteInvalidated(ns: string) {
    epochs.set(ns, epoch(ns) + 1);
    versionMemo.delete(ns);
    inflight.clear();
  },

  /** Only the node that observed the change calls this: kills L2 for everyone. */
  async bumpVersion(ns: string) {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.incr(versionKey(ns));
      versionMemo.delete(ns);
    } catch (error) {
      noteRedisError(error);
    }
  },

  stats() {
    const reads = stats.l1Hits + stats.l2Hits + stats.misses;
    return { ...stats, hitRate: reads ? Number(((stats.l1Hits + stats.l2Hits) / reads).toFixed(3)) : 0 };
  },
};
