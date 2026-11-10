import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityPartition } from '../../contracts/identity.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { AccessTokens, OAuthTokenFailure, type TokenStore } from '../../access/tokens.js';
import { authCodeKey, grantFamilyKey, refreshCredentialKey, subscriberBindingKey, transactionKey } from '../../access/grants.js';
import type { AccessRow, StateKey } from '../../access/model.js';
import { Telemetry } from '../../observability/telemetry.js';
import { entitlement, environment, identity, now, usage_mapping } from '../fixtures/contracts.js';
import { accessRecords } from '../fixtures/storage.js';

const clientId = 'host_fixture';
const resource = 'https://api.example.invalid/mcp';
const redirectUri = 'https://client.example.invalid/callback';
const code = 'C'.repeat(43);
const verifier = 'pkce_verifier_fixture_012345678901234567890';
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
const rowKey = (key: { PK: string; SK: string }) => `${key.PK}\0${key.SK}`;

class MemoryTokenStore implements TokenStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  paid: AccessRow = structuredClone(entitlement);
  beforeCommit: (() => void) | undefined;
  async get(key: StateKey) { const row = this.rows.get(rowKey(key)); return row && structuredClone(row); }
  async entitlement() { return structuredClone(this.paid); }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }> = []) {
    this.beforeCommit?.(); this.beforeCommit = undefined;
    for (const check of checks) {
      if (check.projection) {
        if (this.paid.revision !== check.expectedRevision || this.paid.allowed !== true) throw conflict();
      } else {
      const previous = this.rows.get(rowKey(check.key));
        if (check.expectedRevision === undefined ? previous !== undefined : previous?.revision !== check.expectedRevision) throw conflict();
      }
    }
    for (const { row, expectedRevision } of writes) {
      const previous = this.rows.get(rowKey({ PK: row.PK as string, SK: row.SK as string }));
      if (expectedRevision === undefined ? previous !== undefined : previous?.revision !== expectedRevision) throw conflict();
      validateAccessRecord(row, this.environment);
    }
    for (const { row } of writes) this.rows.set(rowKey({ PK: row.PK as string, SK: row.SK as string }), structuredClone(row));
  }
}
function conflict() { return Object.assign(new Error('conditional conflict'), { name: 'TransactionCanceledException' }); }

function setup() {
  const store = new MemoryTokenStore(), clock = { value: now }, signed: Array<Record<string, unknown>> = [];
  let signGate: { arrived: number; ready: Promise<void>; release: () => void } | undefined;
  const txId = 'oauth_tx_fixture', grantId = 'oauth_grant_fixture', subscriberId = 'subscriber_fixture';
  const txKey = transactionKey(environment, txId);
  const downstream = { client_id: clientId, redirect_uri: redirectUri, resource, scopes: ['mcp:invoke'],
    code_challenge: challenge, code_challenge_method: 'S256', state: 'host_state_fixture',
    issuer: 'https://access.example.invalid', client_config_version: 'clients_fixture' };
  const transaction: AccessRow = { PK: txKey.PK, SK: txKey.SK, schema_version: 1, entity_type: 'transaction', revision: 1,
    environment, purpose: 'onboarding', phase: 'code_issued', downstream, identity, subscriber_id: subscriberId,
    grant_id: grantId, created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };
  const cKey = authCodeKey(environment, code);
  const codeRow: AccessRow = { PK: cKey.PK, SK: cKey.SK, schema_version: 1, entity_type: 'authorization_code', revision: 1,
    environment, tx_id: txId, subscriber_id: subscriberId, client_id: clientId, resource, redirect_uri: redirectUri,
    scopes: ['mcp:invoke'], code_challenge: challenge, code_challenge_method: 'S256', grant_id: grantId,
    issued_at: now, transaction_expires_at: now + 1800, expires_at: now + 60, delete_after: now + 60 + 86400, consumed: false };
  const bindingKey = subscriberBindingKey(environment, subscriberId, usage_mapping.rest_api_id, usage_mapping.stage);
  const binding: AccessRow = structuredClone(accessRecords.subscriber_binding!);
  store.rows.set(rowKey(txKey), transaction); store.rows.set(rowKey(cKey), codeRow); store.rows.set(rowKey(bindingKey), binding);
  const service = new AccessTokens(store, async claims => {
    signed.push(structuredClone(claims));
    if (signGate) {
      const gate = signGate;
      gate.arrived++;
      if (gate.arrived === 2) gate.release();
      await gate.ready;
    }
    return `jwt_${signed.length}`;
  }, {
    issuer: 'https://access.example.invalid', resource, clientIds: [clientId, 'other_fixture'], clockSkewSeconds: 0,
    accessTtlSeconds: 3600, restApiId: usage_mapping.rest_api_id, stage: usage_mapping.stage,
  }, new Telemetry({ service: 'access', environment: 'test', release: 'token_fixture' }, { sink: () => undefined }), () => clock.value);
  return { service, store, clock, signed, grantId, bindingKey, txKey, codeKey: cKey,
    holdNextTwoSignatures() {
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      signGate = { arrived: 0, ready, release };
    } };
}

test('authorization-code exchange binds PKCE/client/redirect/resource and atomically issues paid-bound tokens', async () => {
  const value = setup();
  await assert.rejects(value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: `${verifier}x`, resource }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
  assert.equal((await value.store.get(value.codeKey))?.consumed, false);
  const tokens = await value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource });
  assert.equal(tokens.access_token, 'jwt_1');
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, 'mcp:invoke');
  assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(value.signed[0]?.usageIdentifierKey, 'K'.repeat(40));
  assert.equal(value.signed[0]?.exp, now + 3600);
  assert.equal((await value.store.get(value.codeKey))?.consumed, true);
  assert.equal((await value.store.get(value.txKey))?.phase, 'redeemed');
  const family = await value.store.get(grantFamilyKey(environment, value.grantId));
  assert.equal(family?.status, 'active');
  assert.equal(family?.refresh_expires_at, entitlement.valid_until);
  assert.equal(await value.store.get(refreshCredentialKey(environment, tokens.refresh_token)) !== undefined, true);
  assert.equal([...value.store.rows.values()].some(row => row.entity_type === 'refresh_credential' && row.refresh_token), false,
    'raw refresh token must never be persisted');
  await assert.rejects(value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
});

test('refresh rotates the credential without extending the original paid-through deadline; replay revokes the family', async () => {
  const value = setup();
  const first = await value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource });
  value.clock.value += 1000;
  const second = await value.service.refresh({ refreshToken: first.refresh_token, clientId, resource, scope: 'mcp:invoke' });
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal(second.expires_in, 3600);
  const old = await value.store.get(refreshCredentialKey(environment, first.refresh_token));
  const next = await value.store.get(refreshCredentialKey(environment, second.refresh_token));
  assert.equal(old?.status, 'consumed');
  assert.equal(next?.sequence, 1);
  assert.equal(next?.expires_at, entitlement.valid_until);
  await assert.rejects(value.service.refresh({ refreshToken: first.refresh_token, clientId }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
  const family = await value.store.get(grantFamilyKey(environment, value.grantId));
  assert.equal(family?.status, 'revoked');
  assert.equal(family?.revocation_reason, 'replay');
  await assert.rejects(value.service.refresh({ refreshToken: second.refresh_token, clientId }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
});

test('current subscription and exact ready binding are required for refresh; ineligibility revokes the family', async () => {
  const value = setup();
  const first = await value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource });
  value.store.paid = { ...value.store.paid, allowed: false, revision: value.store.paid.revision + 1 };
  await assert.rejects(value.service.refresh({ refreshToken: first.refresh_token, clientId }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
  const family = await value.store.get(grantFamilyKey(environment, value.grantId));
  assert.equal(family?.status, 'revoked');
  assert.equal(family?.revocation_reason, 'subscription_revoked');
});

test('simultaneous refresh reuse detects the losing conditional write and revokes the rotating family', async () => {
  const value = setup();
  const first = await value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource });
  value.holdNextTwoSignatures();
  const attempts = await Promise.allSettled([
    value.service.refresh({ refreshToken: first.refresh_token, clientId }),
    value.service.refresh({ refreshToken: first.refresh_token, clientId }),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason instanceof OAuthTokenFailure &&
    item.reason.oauthError === 'invalid_grant').length, 1);
  const family = await value.store.get(grantFamilyKey(environment, value.grantId));
  assert.equal(family?.status, 'revoked');
  assert.equal(family?.revocation_reason, 'replay');
});

test('concurrent entitlement revision change prevents code redemption from releasing tokens', async () => {
  const value = setup();
  value.store.beforeCommit = () => { value.store.paid = { ...value.store.paid, revision: value.store.paid.revision + 1 }; };
  await assert.rejects(value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource }),
    error => error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant');
  assert.equal((await value.store.get(value.codeKey))?.consumed, false);
  assert.equal(value.signed.length, 1, 'signing may precede commit, but no credential is returned');
  assert.equal([...value.store.rows.values()].some(row => row.entity_type === 'grant_family'), false);
});

test('RFC 7009 revoke is non-disclosing for unknown and foreign-client tokens and revokes owned families', async () => {
  const value = setup();
  const first = await value.service.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource });
  await value.service.revoke({ token: 'unknown', clientId });
  await value.service.revoke({ token: first.refresh_token, clientId: 'other_fixture' });
  assert.equal((await value.store.get(grantFamilyKey(environment, value.grantId)))?.status, 'active');
  await value.service.revoke({ token: first.refresh_token, clientId });
  const family = await value.store.get(grantFamilyKey(environment, value.grantId));
  assert.equal(family?.status, 'revoked');
  assert.equal(family?.revocation_reason, 'client_revoke');
});
