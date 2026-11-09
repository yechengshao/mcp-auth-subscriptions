import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessRecordSchemas, validateAccessRecord } from '../../access/contracts/storage.js';
import { accessRecords } from '../fixtures/storage.js';
import { now } from '../fixtures/contracts.js';

assert.deepEqual(Object.keys(accessRecords).sort(), Object.keys(accessRecordSchemas).sort());
for (const [kind, value] of Object.entries(accessRecords)) {
  test(`access ${kind}: scoped v1 key, closed fields and explicit cleanup policy`, () => {
    validateAccessRecord(value, 'test');
    for (const changes of [{ PK: 'wrong' }, { SK: 'wrong' }, { schema_version: 2 }, { environment: 'prod' },
      { revision: -1 }, { raw_token: 'SENTINEL_PRIVATE' }]) assert.throws(() => validateAccessRecord({ ...value, ...changes }, 'test'));
    assert.throws(() => validateAccessRecord({ ...value, delete_after: now }, 'test'));
  });
}
test('upstream attempts remove PKCE verifier after consumption and require it before consumption', () => {
  const value = accessRecords.upstream_attempt!;
  const { pkce_verifier: _verifier, ...withoutVerifier } = value;
  assert.throws(() => validateAccessRecord(withoutVerifier, 'test'));
  assert.throws(() => validateAccessRecord({ ...value, consumed: true }, 'test'));
  validateAccessRecord({ ...withoutVerifier, consumed: true }, 'test');
});
test('one-use code lifetime cannot extend beyond 60 seconds or its original transaction', () => {
  const value = accessRecords.authorization_code!;
  for (const changes of [{ expires_at: now }, { expires_at: now + 61 },
    { transaction_expires_at: now + 59 }]) assert.throws(() => validateAccessRecord({ ...value, ...changes }, 'test'));
  validateAccessRecord({ ...value, consumed: true }, 'test'); // Tombstones remain readable, not redeemable.
});
test('family revocation records require both a category and timestamp', () => {
  const value = accessRecords.grant_family!;
  assert.throws(() => validateAccessRecord({ ...value, status: 'revoked' }, 'test'));
  assert.throws(() => validateAccessRecord({ ...value, revoked_at: now }, 'test'));
  validateAccessRecord({ ...value, status: 'revoked', revoked_at: now, revocation_reason: 'replay' }, 'test');
});
test('uncertain mutation generation cannot be represented as configured readiness', () => {
  const value = accessRecords.subscriber_binding!;
  const mutation = value.mutation as Record<string, unknown>;
  for (const changes of [{ mutation: { ...mutation, status: 'uncertain' } },
    { mutation: { ...mutation, desired_entitlement_revision: 2 } }, { api_key_id: undefined },
    { mutation: { ...mutation, step: 'create_key' } },
    { mutation: { ...mutation, api_key_id: 'wrong_key' } },
    { mutation: { ...mutation, target: { usage_plan_id: 'wrong_plan', rest_api_id: 'fixture_rest', stage: 'test' } } },
    { mutation: { generation: 2, desired_entitlement_revision: 2, status: 'dispatching' } }]) assert.throws(() => validateAccessRecord({ ...value, ...changes }, 'test'));
  validateAccessRecord({ ...value, state: 'error', error_class: 'uncertain_effect', mutation: { ...mutation, status: 'uncertain' } }, 'test');
});
test('schema failures never disclose candidate keys or upstream secrets', () => {
  for (const kind of ['subscriber_binding', 'upstream_attempt']) {
    assert.throws(() => validateAccessRecord({ ...accessRecords[kind], extra: 'SENTINEL_PRIVATE' }, 'test'),
      error => error instanceof Error && !error.message.includes('SENTINEL_PRIVATE') && !error.stack?.includes('SENTINEL_PRIVATE'));
  }
});

test('access budgets bound SDK calls, leases and backoff', async () => {
  const { validateAccessBudgets } = await import('../../access/contracts/configuration.js');
  const value = { schema_version: 1, provisioning_budget_ms: 10000, sdk_timeout_ms: 3000,
    lease_seconds: 60, max_attempts: 5, backoff_min_ms: 2000, backoff_max_ms: 30000 };
  validateAccessBudgets(value);
  for (const change of [{ sdk_timeout_ms: 10000 }, { lease_seconds: 10 },
    { max_attempts: 0 }, { backoff_min_ms: 31000 }]) assert.throws(() => validateAccessBudgets({ ...value, ...change }));
});

test('verified transactions retain immutable identity and cannot cross-bind sessions', async () => {
  const { validateSessionContext } = await import('../../access/contracts/validate.js');
  const value = accessRecords.transaction!;
  assert.throws(() => validateSessionContext(accessRecords.session, { ...value,
    identity: { issuer: 'https://other.example.invalid', subject: 'other' } }, 'test', now));
  const { identity: _identity, ...missingIdentity } = value;
  assert.throws(() => validateAccessRecord(missingIdentity, 'test'));
});
