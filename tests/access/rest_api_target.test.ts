import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestApiTarget } from '../../access/rest-api-target.js';

const RESTAPI = '/mcp/test/access-api/rest-api-id';
const STAGE = '/mcp/test/access-api/stage';

function fakeClient(values: Record<string, string | undefined>, calls: { count: number }, fail: { value: boolean } = { value: false }) {
  return { send: async (command: any) => {
    calls.count++;
    if (fail.value) throw new Error('SSM_PROVIDER_SENTINEL');
    const value = values[command.input.Name];
    return { Parameter: value === undefined ? undefined : { Value: value } };
  } } as any;
}

test('the REST API ID and stage are read together, cached for five minutes, and returned as one target', async () => {
  const calls = { count: 0 }; let clock = 0;
  const resolve = createRestApiTarget(RESTAPI, STAGE, fakeClient({ [RESTAPI]: 'abc123def4', [STAGE]: 'test' }, calls), () => clock);
  assert.deepEqual(await resolve(), { rest_api_id: 'abc123def4', stage: 'test' });
  assert.deepEqual(await Promise.all([resolve(), resolve()]), [
    { rest_api_id: 'abc123def4', stage: 'test' }, { rest_api_id: 'abc123def4', stage: 'test' }]);
  assert.equal(calls.count, 2);
  clock = 300_001; await resolve();
  assert.equal(calls.count, 4);
});

test('a missing, malformed or failing parameter fails closed and is not cached', async () => {
  const calls = { count: 0 }; const fail = { value: true };
  const resolve = createRestApiTarget(RESTAPI, STAGE, fakeClient({ [RESTAPI]: 'abc123def4', [STAGE]: 'test' }, calls, fail));
  await assert.rejects(resolve());
  fail.value = false;
  assert.deepEqual(await resolve(), { rest_api_id: 'abc123def4', stage: 'test' });
  const missing = createRestApiTarget(RESTAPI, STAGE, fakeClient({ [RESTAPI]: 'bad value!', [STAGE]: 'test' }, { count: 0 }));
  await assert.rejects(missing(), /invalid_rest_api_target/);
});

test('configuration accepts only the exact published parameter names before any call', () => {
  assert.throws(() => createRestApiTarget('/mcp/test/access-api/other', STAGE), /invalid_rest_api_target_configuration/);
  assert.throws(() => createRestApiTarget(RESTAPI, '/mcp/test/access/stage'), /invalid_rest_api_target_configuration/);
  assert.throws(() => createRestApiTarget(undefined, STAGE), /invalid_rest_api_target_configuration/);
});
