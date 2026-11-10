import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSessionContext, validateManagementContext, validateProfile, validateRefreshRecord } from '../../access/contracts/validate.js';
import { session, transaction, now, identity, entitlement, PK } from '../fixtures/contracts.js';

test('shared session correlates server records and expires before delayed TTL deletion', () => {
  const check = (value: unknown, tx: unknown = transaction, clock = now) => validateSessionContext(value, tx, 'test', clock);
  check(session);
  for (const value of [{ ...session, purpose: 'onboarding' }, { ...session, tx_id: 'other' },
    { ...session, environment: 'prod' }, { ...session, PK: 'raw_session_token' },
    { ...session, expires_at: now + 1801 }, { ...session, delete_after: now + 1800 },
    { ...session, authentication_stage: 'pending_identity' }, { ...session, token: 'raw_secret' }]) assert.throws(() => check(value));
  assert.throws(() => check(session, transaction, now + 1800));
  assert.throws(() => check(session, transaction, now - 1));
  assert.throws(() => check(session, { ...transaction, expires_at: now + 1700 }));
});
test('management transactions have a fixed local destination and cannot carry OAuth grants', () => {
  for (const extra of [{ local_destination: 'https://evil.invalid' }, { downstream: { client_id: 'fake' } },
    { phase: 'code_issued' }, { grant_id: 'fake' }]) assert.throws(() => validateSessionContext(session, { ...transaction, ...extra }, 'test', now));
});
test('onboarding uses the same mechanism but requires PKCE and registered-client context', () => {
  const onboarding = { ...session, purpose: 'onboarding', grant_id: 'grant_fixture' };
  const { local_destination: _destination, ...tx } = transaction;
  const downstream = { client_id: 'client', redirect_uri: 'https://client.example.invalid/callback',
    resource: 'https://api.example.invalid/mcp', scopes: ['mcp'], code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256', state: 'original_state', issuer: 'https://auth.example.invalid', client_config_version: 'v1' };
  const context = { ...tx, purpose: 'onboarding', grant_id: 'grant_fixture', downstream };
  validateSessionContext(onboarding, context, 'test', now);
  assert.throws(() => validateSessionContext(onboarding, { ...context, downstream: { ...downstream, code_challenge_method: 'plain' } }, 'test', now));
  assert.throws(() => validateSessionContext(onboarding, tx, 'test', now));
});
test('verified ownership plus current eligibility is mandatory for management with either session purpose', () => {
  const check = (value: unknown, paid: unknown) => validateManagementContext(value, transaction, paid, 'test', now);
  check(session, entitlement);
  const { identity: _identity, subscriber_id: _subscriber, ...pending } = session;
  assert.throws(() => check({ ...pending, authentication_stage: 'pending_identity' }, entitlement));
  for (const paid of [{ ...entitlement, allowed: false }, { ...entitlement, valid_until: now },
    { ...entitlement, identity_subject: 'other' }, null]) assert.throws(() => check(session, paid));
});
test('durable identity profiles reject TTL and wrong-owner storage keys', () => {
  const profile = { PK, SK: 'PROFILE', schema_version: 1, entity_type: 'identity_profile', revision: 1,
    environment: 'test', identity, subscriber_id: 'subscriber_fixture' };
  validateProfile(profile, 'test');
  assert.throws(() => validateProfile({ ...profile, delete_after: now }, 'test'));
  assert.throws(() => validateProfile({ ...profile, PK: 'wrong' }, 'test'));
});
test('refresh records cannot outlive paid family or erase replay evidence early', () => {
  const value = { PK: `ENV#test#REFRESH#${'d'.repeat(64)}`, SK: 'TOKEN', schema_version: 1,
    entity_type: 'refresh_credential', revision: 1, environment: 'test', grant_id: 'grant_fixture',
    subscriber_id: 'subscriber_fixture', client_id: 'client_fixture', resource: 'https://api.example.invalid/mcp',
    sequence: 1, status: 'active', issued_at: now, expires_at: now + 3600, family_expires_at: now + 3600,
    latest_access_expires_at: now + 3600, delete_after: now + 3600 + 86400 };
  validateRefreshRecord(value, 'test', now);
  for (const extra of [{ status: 'consumed' }, { expires_at: now + 7200 },
    { delete_after: now + 3600 }, { token: 'raw_secret' }]) assert.throws(() => validateRefreshRecord({ ...value, ...extra }, 'test', now));
  assert.throws(() => validateRefreshRecord(value, 'test', now + 3600));
});
test('validation errors do not echo injected credentials', () => {
  assert.throws(() => validateSessionContext({ ...session, private_key: 'DO_NOT_LOG' }, transaction, 'test', now),
    error => error instanceof Error && !error.message.includes('DO_NOT_LOG'));
});

test('session verification cannot bypass the transaction identity stage', () => {
  assert.throws(() => validateSessionContext(session, { ...transaction, phase: 'pending_identity' }, 'test', now));
});
