import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageBindingProvisioner } from '../../access/provisioning.js';
import { ProvisioningFailure } from '../../access/usage_bindings.js';
import { Telemetry } from '../../observability/telemetry.js';
import { identity, now, usage_mapping } from '../fixtures/contracts.js';
import { MemoryBindings, MemoryGateway } from './support/usage_fakes.js';

const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'recovery_fixture' }, { sink: () => undefined });
const create = (store: MemoryBindings, gateway: MemoryGateway, clock: { value: number }) => createUsageBindingProvisioner(
  store, telemetry(), { target: { stage: usage_mapping.stage }, budgets: {
    schema_version: 1, provisioning_budget_ms: 10_000, sdk_timeout_ms: 3_000, lease_seconds: 60,
    max_attempts: 5, backoff_min_ms: 2_000, backoff_max_ms: 30_000,
  } }, async () => ({ rest_api_id: usage_mapping.rest_api_id, stage: usage_mapping.stage }), gateway, { now: () => clock.value, random: () => 0 },
);
const input = { identity, subscriberId: 'subscriber_fixture' };

test('a stalled owner whose lease was taken over cannot overwrite the new owner\'s binding', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  let signalStarted!: () => void, releaseStalled!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const hold = new Promise<void>(resolve => { releaseStalled = resolve; });
  gateway.onCreate = async () => { signalStarted(); await hold; };
  const stalled = create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_stalled' });
  await started;

  clock.value = now + 61;
  gateway.onCreate = async () => undefined;
  const takeover = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_takeover' });
  assert.equal(takeover.state, 'configured');
  const bound = [...store.rows.values()].find(row => row.entity_type === 'usage_binding' || row.entity_type === 'subscriber_binding')!;
  assert.equal(bound.api_key_value, takeover.apiKeyValue);

  releaseStalled();
  await assert.rejects(stalled, error => error instanceof ProvisioningFailure || error instanceof Error);
  const after = [...store.rows.values()].find(row => row.entity_type === 'usage_binding' || row.entity_type === 'subscriber_binding')!;
  assert.equal(after.api_key_value, takeover.apiKeyValue, 'the late owner must not replace the configured key');
  assert.equal(after.state, 'configured');
});
