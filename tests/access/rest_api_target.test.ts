import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestApiTarget } from '../../access/rest-api-target.js';

const NAME = '/mcp/test/access-api/rest-api-id';

function fakeClient(value: string | undefined, calls: { count: number }, fail = false) {
  return { send: async () => { calls.count++; if (fail) throw new Error('SSM_PROVIDER_SENTINEL'); return { Parameter: value === undefined ? undefined : { Value: value } }; } } as any;
}

test('the REST API ID is read from SSM, cached for five minutes, and paired with the configured stage', async () => {
  const calls = { count: 0 }; let clock = 0;
  const resolve = createRestApiTarget(NAME, 'test', fakeClient('abc123def4', calls), () => clock);
  assert.deepEqual(await resolve(), { rest_api_id: 'abc123def4', stage: 'test' });
  assert.deepEqual(await Promise.all([resolve(), resolve()]), [
    { rest_api_id: 'abc123def4', stage: 'test' }, { rest_api_id: 'abc123def4', stage: 'test' }]);
  assert.equal(calls.count, 1);
  clock = 300_001; await resolve();
  assert.equal(calls.count, 2);
});

test('a missing, malformed or failing parameter fails closed and is not cached', async () => {
  const calls = { count: 0 }; let fail = true;
  const client = { send: async () => { calls.count++; if (fail) throw new Error('SSM_PROVIDER_SENTINEL'); return { Parameter: { Value: 'bad value!' } }; } } as any;
  const resolve = createRestApiTarget(NAME, 'test', client);
  await assert.rejects(resolve());
  fail = false;
  await assert.rejects(resolve(), /invalid_rest_api_target/);
  assert.equal(calls.count, 2);
  await assert.rejects(createRestApiTarget(NAME, 'test', fakeClient(undefined, { count: 0 }))(), /invalid_rest_api_target/);
});

test('configuration is validated before any call: exact parameter name and identifier stage only', () => {
  for (const bad of ['/mcp/test/access-api/other', '/mcp/test/access/rest-api-id', '/mcp/staging/access-api/rest-api-id', undefined]) {
    assert.throws(() => createRestApiTarget(bad, 'test'), /invalid_rest_api_target_configuration/);
  }
  assert.throws(() => createRestApiTarget(NAME, 'bad stage!'), /invalid_rest_api_target_configuration/);
});
