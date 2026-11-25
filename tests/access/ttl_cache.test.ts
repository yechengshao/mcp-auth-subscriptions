import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTtlCache } from '../../contracts/ttl-cache.js';

test('a value is reused within its TTL and reloaded after it, measured from the start of the load', async () => {
  let clock = 0, loads = 0;
  const read = createTtlCache(async () => { loads++; clock += 40; return loads; }, { ttlMs: 100, now: () => clock });
  assert.equal(await read(), 1);
  clock = 50; assert.equal(await read(), 1);
  clock = 100; assert.equal(await read(), 2);
  assert.equal(loads, 2);
});

test('concurrent callers share one in-flight load', async () => {
  let loads = 0;
  const read = createTtlCache(async () => { loads++; await new Promise(resolve => setTimeout(resolve, 5)); return 'v'; }, { ttlMs: 1000 });
  assert.deepEqual(await Promise.all([read(), read(), read()]), ['v', 'v', 'v']);
  assert.equal(loads, 1);
});

test('a failed load is never cached, so the next call retries', async () => {
  let loads = 0, fail = true;
  const read = createTtlCache(async () => { loads++; if (fail) throw new Error('provider_sentinel'); return 'ok'; }, { ttlMs: 1000 });
  await assert.rejects(read(), /provider_sentinel/);
  fail = false;
  assert.equal(await read(), 'ok');
  assert.equal(await read(), 'ok');
  assert.equal(loads, 2);
});

test('an infinite TTL lives for the execution environment and a rewound or non-finite clock is a miss', async () => {
  let loads = 0, clock = 1000;
  const forever = createTtlCache(async () => ++loads, { ttlMs: Infinity, now: () => clock });
  await forever(); clock = 10 ** 12; await forever();
  assert.equal(loads, 1);
  let rewound = 500, reloads = 0;
  const cache = createTtlCache(async () => ++reloads, { ttlMs: 1000, now: () => rewound });
  await cache(); rewound = 400; await cache();
  assert.equal(reloads, 2);
  assert.throws(() => createTtlCache(async () => 1, { ttlMs: 0 }), /invalid_cache_ttl/);
});
