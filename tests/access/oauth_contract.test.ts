// T014: the billing-owned entitlement projection that access consumes must carry a stable subscription_id
// and must be rejected when it is missing, malformed, owned by another identity, or no longer eligible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntitlement } from '../../contracts/entitlement.js';
import { entitlement, environment, identity } from '../fixtures/contracts.js';

const now = (entitlement.valid_until as number) - 1000;
const check = (value: Record<string, unknown>, at = now) =>
  validateEntitlement(value, environment, identity.issuer, identity.subject, at);

// Stability across revisions is a billing-side guarantee; here we pin presence and string type only.
test('valid billing entitlement projection passes with a subscription_id string', () => {
  assert.equal(typeof entitlement.subscription_id, 'string');
  assert.doesNotThrow(() => check(entitlement as unknown as Record<string, unknown>));
});

test('entitlement projection without subscription_id is rejected', () => {
  const { subscription_id: _omitted, ...withoutId } = entitlement as Record<string, unknown>;
  assert.throws(() => check(withoutId));
});

test('malformed subscription_id is rejected by the projection schema', () => {
  assert.throws(() => check({ ...entitlement, subscription_id: 'not a valid id' } as unknown as Record<string, unknown>));
  assert.throws(() => check({ ...entitlement, subscription_id: '' } as unknown as Record<string, unknown>));
});

test('projection owned by another identity or environment is rejected', () => {
  assert.throws(() => check({ ...entitlement, identity_subject: 'someone-else' } as unknown as Record<string, unknown>), /entitlement_owner_mismatch/);
  assert.throws(() => check({ ...entitlement, environment: 'production' } as unknown as Record<string, unknown>), /entitlement_owner_mismatch/);
});

test('ineligible or expired projection is rejected even with a valid subscription_id', () => {
  assert.throws(() => check({ ...entitlement, allowed: false } as unknown as Record<string, unknown>), /not_eligible/);
  assert.throws(() => check(entitlement as unknown as Record<string, unknown>, (entitlement.valid_until as number) + 1), /not_eligible/);
});
