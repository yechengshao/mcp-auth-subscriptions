import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transitionTransaction } from '../../access/transitions.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { identity, environment, now } from '../fixtures/contracts.js';
import type { AccessRow } from '../../access/model.js';

const initial: AccessRow = { PK: 'ENV#test#TX#tx_transition', SK: 'STATE', entity_type: 'transaction',
  schema_version: 1, revision: 1, environment, purpose: 'onboarding', phase: 'pending_identity', grant_id: 'grant_transition',
  downstream: { client_id: 'host_fixture', redirect_uri: 'https://host.example.invalid/callback',
    resource: 'https://access.example.invalid/mcp', scopes: ['mcp:invoke'], state: 'original_state',
    issuer: 'https://access.example.invalid', client_config_version: 'clients_fixture_v1',
    code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' },
  created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };

test('onboarding transitions follow one monotonic graph and retain identity, callback and revision guards', () => {
  const verified = transitionTransaction(initial, 'identity_verified', { identity, subscriber_id: 'subscriber_fixture' });
  const checkout = transitionTransaction(verified, 'checkout_pending', { selected_offer: {
    plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture', intent: 'purchase',
  } });
  const paid = transitionTransaction(checkout, 'payment_pending', { order_id: 'order_fixture' });
  const ready = transitionTransaction(paid, 'code_ready');
  const issued = transitionTransaction(ready, 'code_issued');
  const redeemed = transitionTransaction(issued, 'redeemed');
  assert.deepEqual([verified.revision, checkout.revision, paid.revision, ready.revision, issued.revision, redeemed.revision], [2, 3, 4, 5, 6, 7]);
  assert.equal(redeemed.grant_id, initial.grant_id);
  assert.deepEqual(redeemed.downstream, initial.downstream);
  assert.equal(redeemed.identity, identity);
  assert.throws(() => transitionTransaction(redeemed, 'code_issued'), /invalid_onboarding_transition/);
  assert.throws(() => transitionTransaction(verified, 'checkout_pending', { identity: { issuer: 'https://evil.invalid', subject: 'other' },
    selected_offer: { plan_id: 'basic' } }), /invalid_onboarding_transition/);
});

test('transaction transitions reject skipped phases, missing immutable purchase evidence and identity rebinding', () => {
  assert.throws(() => transitionTransaction(initial, 'payment_pending', { order_id: 'order_fixture' }), /invalid_onboarding_transition/);
  assert.throws(() => transitionTransaction(initial, 'identity_verified', { identity }), /invalid_onboarding_transition/);
  assert.throws(() => transitionTransaction(initial, 'checkout_pending', { selected_offer: {} , grant_id: 'grant_other' }), /invalid_onboarding_transition/);
  assert.throws(() => transitionTransaction({ ...initial, phase: 'unknown' }, 'failed'), /invalid_onboarding_transition/);
});

test('cancelled pre-identity transactions are valid durable state and distinct from verified failures', () => {
  const cancelled = transitionTransaction(initial, 'cancelled');
  assert.equal(cancelled.phase, 'cancelled');
  validateAccessRecord(cancelled, environment);

  const failed = transitionTransaction(initial, 'identity_verified', { identity, subscriber_id: 'subscriber_fixture' });
  const terminalFailure = transitionTransaction(failed, 'failed');
  assert.equal(terminalFailure.phase, 'failed');
  validateAccessRecord(terminalFailure, environment);
  assert.throws(() => transitionTransaction({ ...initial, phase: 'checkout_pending' }, 'cancelled'), /invalid_onboarding_transition/);
});
