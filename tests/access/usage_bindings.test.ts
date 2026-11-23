import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessRow, StateKey } from '../../access/model.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { UsageBindingProvisioner, ProvisioningFailure, type ApiGatewayUsagePlanPort, type UsageBindingStore } from '../../access/usage_bindings.js';
import { createUsageBindingProvisioner } from '../../access/provisioning.js';
import { Telemetry } from '../../observability/telemetry.js';
import { identity, now, usage_mapping } from '../fixtures/contracts.js';
import { MemoryBindings, MemoryGateway, key } from './support/usage_fakes.js';
import { accessRecords } from '../fixtures/storage.js';

const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: () => undefined });
const create = (store: MemoryBindings, gateway: MemoryGateway, clock: { value: number }) => createUsageBindingProvisioner(
  store, telemetry(), { target: { rest_api_id: usage_mapping.rest_api_id, stage: usage_mapping.stage }, budgets: {
    schema_version: 1, provisioning_budget_ms: 10_000, sdk_timeout_ms: 3_000, lease_seconds: 60,
    max_attempts: 5, backoff_min_ms: 2_000, backoff_max_ms: 30_000,
  } }, gateway, { now: () => clock.value, random: () => 0 },
);
const input = { identity, subscriberId: 'subscriber_fixture', invocationId: 'invoke_fixture' };

test('request-driven provisioning persists one candidate key, associates the configured plan and reuses the binding', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  const provisioner = create(store, gateway, clock);
  const result = await provisioner.ensure(input);
  const saved = [...store.rows.values()][0]!;
  assert.equal(result.state, 'configured');
  assert.equal(result.apiKeyId, 'key_fixture');
  assert.equal(saved.api_key_value, result.apiKeyValue);
  assert.equal(saved.state, 'configured');
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
  assert.deepEqual(gateway.associated[0], { usagePlanId: usage_mapping.usage_plan_id, apiKeyId: 'key_fixture' });

  const again = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_again' });
  assert.equal(again.apiKeyValue, result.apiKeyValue);
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
});

test('concurrent status requests share the persisted provisioning lease while one API call is in flight', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  let signalStarted!: () => void, releaseCreate!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const hold = new Promise<void>(resolve => { releaseCreate = resolve; });
  gateway.onCreate = async () => { signalStarted(); await hold; };
  const first = create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_first' });
  await started;
  await assert.rejects(create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_second' }), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_pending');
  assert.equal(gateway.created.length, 1);
  releaseCreate();
  const result = await first;
  assert.equal(result.state, 'configured');
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
});

test('unknown CreateApiKey result is recovered by the exact persisted name and candidate value', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  gateway.fail.set('create', { kind: 'uncertain', afterEffect: true });
  await assert.rejects(create(store, gateway, clock).ensure(input), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_support_required');
  const savedAfterTimeout = [...store.rows.values()][0]!;
  const candidate = savedAfterTimeout.api_key_value;
  assert.equal(savedAfterTimeout.mutation.status, 'uncertain');
  clock.value += 3;

  const result = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_retry' });
  const saved = [...store.rows.values()][0]!;
  assert.equal(result.apiKeyValue, candidate);
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
  assert.equal(saved.state, 'configured');
});

test('an unresolved key-creation result with no exact match blocks replacement creation', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  gateway.fail.set('create', { kind: 'uncertain', afterEffect: false });
  await assert.rejects(create(store, gateway, clock).ensure(input));
  clock.value += 3;
  await assert.rejects(create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_retry' }), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_support_required');
  const saved = [...store.rows.values()][0]!;
  assert.equal(saved.mutation.status, 'repair_required');
  assert.equal(saved.error_class, 'uncertain_effect');
  assert.equal(gateway.created.length, 0);
});

test('a definite AWS rejection preserves the candidate for a later safe retry', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  gateway.fail.set('create', { kind: 'dependency', afterEffect: false });
  await assert.rejects(create(store, gateway, clock).ensure(input), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_retry');
  const first = [...store.rows.values()][0]!;
  const candidate = first.api_key_value;
  assert.equal(first.mutation.status, 'idle');
  clock.value = first.next_attempt_at + 1;

  const result = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_retry' });
  assert.equal(result.apiKeyValue, candidate);
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.created[0]?.value, candidate);
  assert.equal(gateway.associated.length, 1);
});

test('an association timeout is reconciled by exact key and plan before readiness is recorded', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  gateway.fail.set('associate', { kind: 'uncertain', afterEffect: true });
  await assert.rejects(create(store, gateway, clock).ensure(input), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_support_required');
  const pending = [...store.rows.values()][0]!;
  assert.equal(pending.api_key_id, 'key_fixture');
  assert.equal(pending.state, 'error');
  assert.equal(pending.mutation.status, 'uncertain');
  clock.value += 3;

  const result = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_retry' });
  assert.equal(result.state, 'configured');
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
});

test('a billing revision change during key creation blocks association until the latest revision is checked', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  gateway.onCreate = () => { store.paid = { ...store.paid, revision: 2, updated_at: now + 1 }; };
  await assert.rejects(create(store, gateway, clock).ensure(input));
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 0);
  const pending = [...store.rows.values()][0]!;
  assert.equal(pending.api_key_id, 'key_fixture');
  assert.notEqual(pending.state, 'configured');

  gateway.onCreate = undefined;
  clock.value += 2;
  const result = await create(store, gateway, clock).ensure({ ...input, invocationId: 'invoke_latest' });
  assert.equal(result.entitlementRevision, 2);
  assert.equal(gateway.created.length, 1);
  assert.equal(gateway.associated.length, 1);
});

test('an upgrade reuses the stable subscriber key and moves its association only after the new entitlement is current', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  const previous: AccessRow = { ...accessRecords.subscriber_binding!, lease_until: now - 1 };
  store.rows.set(key(previous as { PK: string; SK: string }), structuredClone(previous));
  gateway.associated.push({ usagePlanId: usage_mapping.usage_plan_id, apiKeyId: 'key_fixture' });
  store.paid = { ...store.paid, revision: 2, plan_id: 'premium', usage_mapping: {
    ...usage_mapping, usage_plan_id: 'premium_usage',
  }, updated_at: now + 1 };

  const result = await create(store, gateway, clock).ensure({ ...input, invocationId: 'upgrade_fixture' });
  const saved = await store.get({ PK: previous.PK as string, SK: previous.SK as string });
  assert.equal(result.apiKeyId, 'key_fixture');
  assert.equal(result.usageMapping.usage_plan_id, 'premium_usage');
  assert.equal(saved?.plan_id, 'premium');
  assert.equal(saved?.state, 'configured');
  assert.equal(gateway.created.length, 0);
  assert.deepEqual(gateway.removeCalls, [{ usagePlanId: usage_mapping.usage_plan_id, apiKeyId: 'key_fixture' }]);
  assert.deepEqual(gateway.associated, [{ usagePlanId: 'premium_usage', apiKeyId: 'key_fixture' }]);
});

test('an uncertain old-plan removal is read-reconciled and never blindly repeated', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  const previous: AccessRow = { ...accessRecords.subscriber_binding!, lease_until: now - 1 };
  store.rows.set(key(previous as { PK: string; SK: string }), structuredClone(previous));
  gateway.associated.push({ usagePlanId: usage_mapping.usage_plan_id, apiKeyId: 'key_fixture' });
  store.paid = { ...store.paid, revision: 2, plan_id: 'premium', usage_mapping: { ...usage_mapping, usage_plan_id: 'premium_usage' } };
  gateway.fail.set('remove', { kind: 'uncertain', afterEffect: false });

  await assert.rejects(create(store, gateway, clock).ensure({ ...input, invocationId: 'upgrade_timeout' }));
  clock.value += 3;
  await assert.rejects(create(store, gateway, clock).ensure({ ...input, invocationId: 'upgrade_retry' }), (error: unknown) =>
    error instanceof ProvisioningFailure && error.code === 'activation_support_required');
  const saved = await store.get({ PK: previous.PK as string, SK: previous.SK as string });
  assert.equal(saved?.mutation.status, 'repair_required');
  assert.equal(gateway.removeCalls.length, 1);
  assert.equal(gateway.associated.length, 1);
});

test('usage-plan mapping must match the deployed REST API stage before provisioning starts', async () => {
  const store = new MemoryBindings(), gateway = new MemoryGateway(), clock = { value: now };
  const service = new UsageBindingProvisioner(store, gateway, telemetry(), { rest_api_id: 'other_rest', stage: usage_mapping.stage }, {}, () => clock.value);
  await assert.rejects(service.ensure(input), (error: unknown) => error instanceof ProvisioningFailure && error.code === 'usage_plan_mismatch');
  assert.equal(store.rows.size, 0);
  assert.equal(gateway.created.length, 0);
});
