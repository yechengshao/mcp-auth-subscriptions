import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, type ParameterValue } from '../../billing/contracts/catalog-cache.js';
import { catalog, scope } from '../fixtures/contracts.js';

test('catalog cache coalesces concurrent loads and returns isolated versioned snapshots', async () => {
  let resolve!: (value: ParameterValue) => void;
  let loads = 0, clock = 0;
  const cache = createCatalogCache(() => { loads++; return new Promise(done => { resolve = done; }); }, scope, { now: () => clock });
  const first = cache.read(), second = cache.read();
  await Promise.resolve();
  assert.equal(loads, 1);
  resolve({ version: 7, value: catalog });
  const [a, b] = await Promise.all([first, second]);
  a.catalog.plans.basic!.display.name = 'mutated';
  assert.equal(b.catalog.plans.basic!.display.name, 'Fixture basic');
  clock = 59999;
  assert.equal((await cache.read()).ssm_version, 7);
  assert.equal(loads, 1);
});
test('expired cache never falls back to stale offers when SSM is unavailable', async () => {
  let clock = 0, calls = 0;
  const cache = createCatalogCache(async () => {
    calls++;
    if (calls > 1) throw new Error('SENTINEL_PROVIDER_SECRET');
    return { version: 1, value: catalog };
  }, scope, { now: () => clock });
  await cache.read(); clock = 60000;
  await assert.rejects(cache.read(), { message: 'catalog_unavailable' });
  await assert.rejects(cache.read(), { message: 'catalog_unavailable' });
  assert.equal(calls, 3);
});
test('refresh rejects malformed scope/version, in-place release edits and backward clocks', async () => {
  for (const replacement of [{ version: 0, value: catalog }, { version: 2, value: { ...catalog, environment: 'prod' } },
    { version: 2, value: { ...catalog, plans: {} } }]) {
    const cache = createCatalogCache(async () => replacement, scope);
    await assert.rejects(cache.read(), { message: 'catalog_unavailable' });
  }
  let clock = 0, next = catalog;
  const cache = createCatalogCache(async () => ({ version: 1, value: next }), scope, { now: () => clock });
  await cache.read(); clock = 60000;
  next = structuredClone(catalog); next.plans.basic.display.name = 'changed-without-release';
  await assert.rejects(cache.read(), { message: 'catalog_unavailable' });
  next = { ...next, catalog_version: 'fixture_v2' };
  assert.equal((await cache.read()).catalog.catalog_version, 'fixture_v2');
  clock = -1;
  // Rewinding invalidates the old cache and triggers a new, validated load.
  assert.equal((await cache.read()).catalog.catalog_version, 'fixture_v2');
});
test('fetch timeout aborts bounded work and late completion cannot populate the cache', async () => {
  let resolve!: (value: ParameterValue) => void;
  let signal!: AbortSignal, calls = 0;
  const cache = createCatalogCache(async abort => {
    calls++; signal = abort;
    if (calls === 1) return new Promise(done => { resolve = done; });
    return { version: 2, value: { ...catalog, catalog_version: 'fixture_v2' } };
  }, scope, { fetch_timeout_ms: 5 });
  await assert.rejects(cache.read(), { message: 'catalog_unavailable' });
  assert.ok(signal.aborted);
  resolve({ version: 1, value: catalog });
  assert.equal((await cache.read()).ssm_version, 2);
  for (const options of [{ max_age_ms: 60001 }, { fetch_timeout_ms: 3001 }, { max_age_ms: 0 }]) {
    assert.throws(() => createCatalogCache(async () => ({ version: 1, value: catalog }), scope, options));
  }
});

test('catalog immutability compares content independent of JSON property order', async () => {
  let clock = 0, reordered = false;
  const cache = createCatalogCache(async () => ({ version: 1,
    value: reordered ? Object.fromEntries(Object.entries(catalog).reverse()) : catalog,
  }), scope, { now: () => clock });
  await cache.read(); clock = 60000; reordered = true;
  assert.equal((await cache.read()).catalog.catalog_version, 'fixture_v1');
});
