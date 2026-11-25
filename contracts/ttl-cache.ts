/**
 * One cache rule for every AWS read and derived value in the service:
 *  - a successful value is reused until its TTL elapses, measured from the start of the load (a slow load never extends it);
 *  - concurrent callers share one in-flight load;
 *  - a failed load is never cached, so the next call retries;
 *  - a clock that is not finite, or that moved backwards before the load, is a miss.
 * Use Infinity for values that live for the execution environment (for example a key ARN read once per environment).
 */
export interface TtlCacheOptions { ttlMs: number; now?: () => number }

export function createTtlCache<T>(load: () => Promise<T>, options: TtlCacheOptions): () => Promise<T> {
  const { ttlMs } = options;
  const now = options.now ?? Date.now;
  if (!(ttlMs > 0)) throw new Error('invalid_cache_ttl');
  let value: { result: T; loadedAt: number; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  return async (): Promise<T> => {
    const clock = now();
    if (value && Number.isFinite(clock) && clock >= value.loadedAt && clock < value.expiresAt) return value.result;
    pending ??= (async () => {
      const started = clock;
      const result = await load();
      value = { result, loadedAt: started, expiresAt: Number.isFinite(started) ? started + ttlMs : -Infinity };
      return result;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
