import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parameterRestApiTarget } from '../../billing/adapters/aws.js';

test('the deployed target is read from the REST API ID and stage parameters, cached five minutes, never cached on failure', async () => {
  const values: Record<string, string> = { '/mcp/test/access-api/rest-api-id': 'abc123def4', '/mcp/test/access-api/stage': 'test' };
  const calls: string[] = []; let clock = 0; let fail = true;
  const ssm = { send: async (command: any) => {
    calls.push(command.input.Name);
    if (fail) throw new Error('SSM_PROVIDER_SENTINEL');
    return { Parameter: { Value: values[command.input.Name] } };
  } };
  const target = parameterRestApiTarget('/mcp/test/access-api/rest-api-id', '/mcp/test/access-api/stage', ssm as any, () => clock);
  await assert.rejects(target());
  fail = false;
  assert.deepEqual(await target(), { rest_api_id: 'abc123def4', stage: 'test' });
  assert.deepEqual(await target(), { rest_api_id: 'abc123def4', stage: 'test' });
  assert.equal(calls.length, 4);
  clock = 300_001; await target();
  assert.equal(calls.length, 6);
});

test('the target reader accepts only the exact published parameter names', () => {
  assert.throws(() => parameterRestApiTarget('/mcp/test/access-api/other', '/mcp/test/access-api/stage'), /invalid_rest_api_target_configuration/);
  assert.throws(() => parameterRestApiTarget('/mcp/test/access-api/rest-api-id', '/mcp/test/access-api/other'), /invalid_rest_api_target_configuration/);
});
