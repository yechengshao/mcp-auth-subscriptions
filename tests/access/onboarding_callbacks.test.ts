import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessRow } from '../../access/model.js';
import { transitionTransaction } from '../../access/transitions.js';
import { identity, now } from '../fixtures/contracts.js';

const transaction = (phase: string, revision = 1): AccessRow => ({
  PK: 'ENV#test#TX#tx_fixture', SK: 'TRANSACTION', entity_type: 'transaction', revision,
  environment: 'test', purpose: 'onboarding', phase, created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
} as unknown as AccessRow);
const verified = { identity, subscriber_id: 'subscriber_fixture' };

test('a duplicate Cognito callback cannot re-verify identity or rebind the transaction', () => {
  const verifiedRow = transitionTransaction(transaction('pending_identity'), 'identity_verified', verified);
  assert.throws(() => transitionTransaction(verifiedRow, 'identity_verified', verified), /invalid_onboarding_transition/);
  assert.throws(() => transitionTransaction(verifiedRow, 'identity_verified', {
    identity: { issuer: identity.issuer, subject: 'other_subject' }, subscriber_id: 'other_subscriber' }), /invalid_onboarding_transition/);
  assert.equal(verifiedRow.phase, 'identity_verified');
  assert.equal(verifiedRow.revision, 2);
});

test('a late callback for a cancelled transaction is rejected and leaves it cancelled', () => {
  const cancelled = transitionTransaction(transaction('pending_identity'), 'cancelled');
  assert.throws(() => transitionTransaction(cancelled, 'identity_verified', verified), /invalid_onboarding_transition/);
  assert.equal(cancelled.phase, 'cancelled');
});

test('identity cannot be skipped: checkout requires a verified transaction first', () => {
  assert.throws(() => transitionTransaction(transaction('pending_identity'), 'checkout_pending', {
    selected_offer: { plan_id: 'plan_fixture' } }), /invalid_onboarding_transition/);
});
