import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AccessTokens } from '../../access/tokens.js';
import { createAuthorizer } from '../../authorizer/handler.js';
import { subscriberBindingKey, transactionKey } from '../../access/grants.js';
import { Telemetry } from '../../observability/telemetry.js';
import { TrustedJwks } from '../../security/jwks.js';
import { accessRecords } from '../fixtures/storage.js';
import { entitlement, environment, now, usage_mapping } from '../fixtures/contracts.js';
import { Onboarding, type OnboardingStore } from '../../access/onboarding.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import type { BrowserContext } from '../../access/sessions.js';
import type { AccessRow, StateKey } from '../../access/model.js';
import type { BillingCall, BillingResult } from '../../access/adapters/billing.js';
import type { UsageBindingProvisioner } from '../../access/usage_bindings.js';
import { identity } from '../fixtures/contracts.js';

const verifier = 'client_fixture_pkce_verifier_012345678901234567890';
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
const keyOf = (key: StateKey) => `${key.PK}\0${key.SK}`;

class MemoryOnboardingStore implements OnboardingStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  paid: AccessRow | undefined;
  async get(key: StateKey) { const row = this.rows.get(keyOf(key)); return row && structuredClone(row); }
  async entitlement(owner: { issuer: string; subject: string }) {
    if (this.paid?.identity_issuer !== owner.issuer || this.paid?.identity_subject !== owner.subject) return undefined;
    return structuredClone(this.paid);
  }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{ key: StateKey; expectedRevision?: number; projection?: boolean }> = []) {
    for (const check of checks) {
      const value = check.projection ? this.paid : this.rows.get(keyOf(check.key));
      if (check.expectedRevision === undefined ? value !== undefined : value?.revision !== check.expectedRevision) throw conflict();
    }
    for (const { row, expectedRevision } of writes) {
      const current = this.rows.get(keyOf(row as StateKey));
      if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) throw conflict();
      validateAccessRecord(row, environment);
    }
    for (const { row } of writes) this.rows.set(keyOf(row as StateKey), structuredClone(row));
  }
}
function conflict() { const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; return error; }
class BillingFake {
  readonly calls: BillingCall[] = [];
  readonly replies: BillingResult[] = [];
  async invoke(call: BillingCall) { this.calls.push(structuredClone(call)); const reply = this.replies.shift(); if (!reply) throw new Error('unexpected_billing_call'); return reply; }
}
const result = (outcome: BillingResult['outcome'], payload: Record<string, unknown>): BillingResult => ({
  schema_version: 1, correlation_id: 'journey_corr_fixture', outcome,
  retryable: outcome === 'pending' || outcome === 'retryable_unavailable', message: 'fixture', payload,
});
function transaction(phase: string): AccessRow {
  return { PK: 'ENV#test#TX#tx_journey_fixture', SK: 'STATE', entity_type: 'transaction', schema_version: 1,
    revision: 1, environment, purpose: 'onboarding', phase, grant_id: 'grant_journey_fixture', identity,
    subscriber_id: 'subscriber_fixture', correlation_id: 'journey_corr_fixture', order_id: 'order_fixture',
    downstream: { client_id: 'chatgpt_fixture', redirect_uri: 'https://chatgpt.example.invalid/callback',
      resource: 'https://api.example.invalid/test/mcp', scopes: ['openid', 'mcp:invoke'], code_challenge: challenge,
      code_challenge_method: 'S256', state: 'state_from_client_fixture', issuer: 'https://access.example.invalid',
      client_config_version: 'clients_fixture_v1' }, created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };
}
function browser(tx: AccessRow): BrowserContext {
  return { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', session: {
    PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', entity_type: 'session', schema_version: 1,
    revision: 1, environment, purpose: 'onboarding', tx_id: 'tx_journey_fixture', grant_id: tx.grant_id,
    authentication_stage: 'identity_verified', identity, subscriber_id: 'subscriber_fixture', csrf_digest: 'b'.repeat(64),
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  }, transaction: tx };
}
function seed(store: MemoryOnboardingStore, row: AccessRow) { store.rows.set(keyOf(row as StateKey), structuredClone(row)); }

test('payment recovery, activation, OAuth code exchange and refresh form one idempotent client journey', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = transaction('payment_pending');
  seed(store, tx);
  const browserContext = browser(tx);
  billing.replies.push(result('pending', { order_id: 'order_fixture', state: 'pending' }));

  let provisionCount = 0;
  const bindingKey = subscriberBindingKey(environment, 'subscriber_fixture', usage_mapping.rest_api_id, usage_mapping.stage);
  const provisioner = { async ensure() {
    provisionCount++;
    if (!await store.get(bindingKey)) store.rows.set(`${bindingKey.PK}\0${bindingKey.SK}`, {
      ...(structuredClone(accessRecords.subscriber_binding) as AccessRow), PK: bindingKey.PK, SK: bindingKey.SK,
    });
    return { state: 'configured' as const, subscriberId: 'subscriber_fixture', entitlementRevision: store.paid?.revision ?? 1,
      apiKeyId: 'key_fixture', apiKeyValue: 'K'.repeat(40), usageMapping: usage_mapping };
  } } as unknown as UsageBindingProvisioner;
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'client_journey_fixture' }, { sink: () => undefined, now: () => now * 1000 });
  const onboarding = new Onboarding(store, billing as never, provisioner, telemetry, () => now);

  assert.deepEqual(await onboarding.status(browserContext), { state: 'payment_pending', retry_after_seconds: 5 });
  assert.equal(provisionCount, 0, 'payment pending must not provision access');

  store.paid = structuredClone(entitlement);
  assert.deepEqual(await onboarding.status(browserContext), { state: 'activation_ready' });
  assert.equal(provisionCount, 1);
  assert.equal((await store.get(bindingKey))?.state, 'configured');

  const callback = new URL((await onboarding.resume(browserContext)).location);
  const code = callback.searchParams.get('code')!;
  assert.equal(callback.searchParams.get('state'), 'state_from_client_fixture');
  const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const kid = 'journey_signer_fixture';
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  const tokens = new AccessTokens(store, async claims => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid }).sign(pair.privateKey), {
    issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/test/mcp',
    clientIds: ['chatgpt_fixture'], clockSkewSeconds: 5, accessTtlSeconds: 3600, restApiId: usage_mapping.rest_api_id, stage: usage_mapping.stage,
  }, telemetry, () => now);
  const first = await tokens.exchangeCode({ code, clientId: 'chatgpt_fixture',
    redirectUri: 'https://chatgpt.example.invalid/callback', codeVerifier: verifier,
    resource: 'https://api.example.invalid/test/mcp' });
  assert.equal(first.expires_in, 3600);
  assert.equal((await store.get(transactionKey(environment, 'tx_journey_fixture')))?.phase, 'redeemed');

  const requestArn = 'arn:aws:execute-api:us-east-1:000000000000:fixturerest/test/POST/mcp';
  const authorizer = createAuthorizer({ issuer: 'https://access.example.invalid',
    resource: 'https://api.example.invalid/test/mcp', clientIds: ['chatgpt_fixture'], clockSkewSeconds: 5,
    region: 'us-east-1', accountId: '000000000000', apiId: 'fixturerest', stage: 'test',
    routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }] },
    new TrustedJwks(async () => ({ keys: [jwk] })), telemetry, () => now);
  let mcpCalls = 0;
  const callProtectedMcp = async (token: string) => {
    const decision = await authorizer({ type: 'REQUEST', methodArn: requestArn, headers: { authorization: `Bearer ${token}` } }, {});
    if (decision.policyDocument.Statement[0]?.Effect !== 'Allow') throw new Error('mcp_denied');
    mcpCalls++;
    return decision.usageIdentifierKey;
  };
  assert.equal(await callProtectedMcp(first.access_token), 'K'.repeat(40));
  const [header, payload, signature] = first.access_token.split('.');
  assert.ok(header && payload && signature);
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
    usageIdentifierKey: 'T'.repeat(40) })).toString('base64url');
  await assert.rejects(callProtectedMcp(`${header}.${altered}.${signature}`), /Unauthorized/);
  assert.equal(mcpCalls, 1, 'tampered token must not reach MCP');

  const refreshed = await tokens.refresh({ refreshToken: first.refresh_token, clientId: 'chatgpt_fixture', resource: 'https://api.example.invalid/test/mcp' });
  assert.notEqual(refreshed.refresh_token, first.refresh_token);
  assert.equal(refreshed.expires_in, 3600);
  assert.equal((await store.get(bindingKey))?.api_key_id, 'key_fixture', 'refresh reuses the established subscriber key');
  assert.equal(provisionCount, 2, 'each bounded status/resume action may idempotently verify provisioning');
});
