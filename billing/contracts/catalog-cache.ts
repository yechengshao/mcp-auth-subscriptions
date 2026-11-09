import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { validateCatalog, type Catalog, type Scope } from './validate.js';

export interface ParameterValue { version: number; value: unknown }
export interface CatalogValue { ssm_version: number; catalog: Catalog }
/** The eventual SSM adapter must apply exact IAM, tracing and redacted dependency logs. */
export type CatalogLoader = (signal: AbortSignal) => Promise<ParameterValue>;
export function createCatalogCache(loader: CatalogLoader, scope: Scope, options: {
  max_age_ms?: number; fetch_timeout_ms?: number; now?: () => number;
} = {}) {
  const maxAge = options.max_age_ms ?? 60000;
  const timeout = options.fetch_timeout_ms ?? 3000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(maxAge) || maxAge <= 0 || maxAge > 60000 ||
      !Number.isInteger(timeout) || timeout <= 0 || timeout > 3000) throw new Error('invalid_catalog_cache_config');
  let cached: CatalogValue | undefined, expiresAt = 0, loadedAt = 0;
  let pending: Promise<CatalogValue> | undefined;
  // Only the most recent release is retained: no unbounded in-process catalog history.
  let lastRelease: { version: string; fingerprint: string } | undefined;
  async function load(): Promise<CatalogValue> {
    const started = now();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => loader(abort.signal)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          abort.abort(); reject(new Error('catalog_unavailable'));
        }, timeout); }),
      ]);
      if (!Number.isSafeInteger(result.version) || result.version <= 0) throw new Error('invalid_parameter_version');
      const catalog = validateCatalog(result.value, scope);
      const fingerprint = createHash('sha256').update(canonicalJson(catalog)).digest('hex');
      if (lastRelease?.version === catalog.catalog_version && lastRelease.fingerprint !== fingerprint) throw new Error('mutable_catalog_release');
      // A stalled/rewound clock cannot extend validity beyond the configured maximum.
      const finished = now();
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started >= maxAge) throw new Error('expired_catalog_load');
      const value = { ssm_version: result.version, catalog };
      lastRelease = { version: catalog.catalog_version, fingerprint };
      loadedAt = started; expiresAt = started + maxAge; cached = value;
      return value;
    } catch {
      cached = undefined;
      throw new Error('catalog_unavailable'); // Provider errors/values never escape to logs or callers.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return {
    async read(): Promise<CatalogValue> {
      const clock = now();
      if (cached && Number.isFinite(clock) && clock >= loadedAt && clock < expiresAt) return structuredClone(cached);
      if (!pending) pending = load().finally(() => { pending = undefined; });
      return structuredClone(await pending);
    },
  };
}
