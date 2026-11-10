import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayUsagePlans } from '../../access/adapters/api-gateway.js';
import { Telemetry } from '../../observability/telemetry.js';

const telemetry = (sink: (line: string) => void = () => undefined) => new Telemetry(
  { service: 'access', environment: 'test', release: 'fixture' }, { sink },
);
function client(send: (command: any) => Promise<any>) { return { send } as unknown as APIGatewayClient; }

test('native adapter sends only the stable candidate value and performs no routine read after accepted association', async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const adapter = new ApiGatewayUsagePlans(telemetry(), { client: client(async command => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'CreateApiKeyCommand') return { id: 'key_fixture' };
    if (command.constructor.name === 'CreateUsagePlanKeyCommand') return {};
    throw new Error('unexpected command');
  }) });
  assert.deepEqual(await adapter.createApiKey({ name: 'mcp-test-operation_fixture', value: 'K'.repeat(40) }), { apiKeyId: 'key_fixture' });
  await adapter.associateApiKey({ usagePlanId: 'plan_fixture', apiKeyId: 'key_fixture' });
  assert.deepEqual(calls.map(call => call.name), ['CreateApiKeyCommand', 'CreateUsagePlanKeyCommand']);
  assert.equal(calls[0]?.input.value, 'K'.repeat(40));
  assert.equal(calls[1]?.input.keyType, 'API_KEY');
});

test('exact key recovery paginates by opaque deterministic name and compares the persisted value', async () => {
  const inputs: any[] = [];
  const adapter = new ApiGatewayUsagePlans(telemetry(), { client: client(async command => {
    inputs.push(command.input);
    return command.input.position
      ? { items: [{ id: 'key_exact', name: command.input.nameQuery, value: 'C'.repeat(40) }] }
      : { position: 'next-page', items: [{ id: 'wrong', name: command.input.nameQuery, value: 'D'.repeat(40) }] };
  }) });
  assert.deepEqual(await adapter.findApiKey({ name: 'mcp-test-operation_fixture', value: 'C'.repeat(40) }), { apiKeyId: 'key_exact' });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.includeValues, true);
  assert.equal(inputs[0]?.limit, 100);
  assert.equal(inputs[1]?.position, 'next-page');
});

test('association conflict is accepted only after exact usage-plan read-back', async () => {
  const calls: string[] = [];
  const adapter = new ApiGatewayUsagePlans(telemetry(), { client: client(async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'CreateUsagePlanKeyCommand') {
      const error = new Error('conflict'); Object.assign(error, { $metadata: { httpStatusCode: 409 } }); throw error;
    }
    if (command.constructor.name === 'GetUsagePlansCommand') return { items: [{ id: 'plan_fixture', apiStages: [{ apiId: 'rest_fixture', stage: 'test' }] }] };
    throw new Error('unexpected command');
  }) });
  await adapter.associateApiKey({ usagePlanId: 'plan_fixture', apiKeyId: 'key_fixture' });
  assert.deepEqual(calls, ['CreateUsagePlanKeyCommand', 'GetUsagePlansCommand']);
});

test('native adapter reads only key-associated API stages and deletes the exact old plan association', async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const adapter = new ApiGatewayUsagePlans(telemetry(), { client: client(async command => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetUsagePlansCommand') return { items: [{ id: 'old_plan', apiStages: [
      { apiId: 'rest_fixture', stage: 'test' }, { apiId: 'other_rest', stage: 'prod' },
    ] }] };
    if (command.constructor.name === 'DeleteUsagePlanKeyCommand') return {};
    throw new Error('unexpected command');
  }) });
  assert.deepEqual(await adapter.listAssociations({ apiKeyId: 'key_fixture' }), [
    { usage_plan_id: 'old_plan', rest_api_id: 'rest_fixture', stage: 'test' },
    { usage_plan_id: 'old_plan', rest_api_id: 'other_rest', stage: 'prod' },
  ]);
  await adapter.removeApiKeyAssociation({ usagePlanId: 'old_plan', apiKeyId: 'key_fixture' });
  assert.deepEqual(calls.map(call => call.name), ['GetUsagePlansCommand', 'DeleteUsagePlanKeyCommand']);
  assert.equal(calls[1]?.input.usagePlanId, 'old_plan');
  assert.equal(calls[1]?.input.keyId, 'key_fixture');
});

test('association conflict without exact read-back remains an uncertain effect', async () => {
  const adapter = new ApiGatewayUsagePlans(telemetry(), { client: client(async command => {
    if (command.constructor.name === 'CreateUsagePlanKeyCommand') {
      const error = new Error('conflict'); Object.assign(error, { $metadata: { httpStatusCode: 409 } }); throw error;
    }
    if (command.constructor.name === 'GetUsagePlansCommand') return { items: [] };
    throw new Error('unexpected command');
  }) });
  await assert.rejects(adapter.associateApiKey({ usagePlanId: 'plan_fixture', apiKeyId: 'key_fixture' }),
    error => error instanceof Error && (error as Error & { kind?: string }).kind === 'uncertain');
});
