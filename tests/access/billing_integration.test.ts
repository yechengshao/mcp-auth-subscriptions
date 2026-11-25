import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Stripe from 'stripe';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AccessTokens } from '../../access/tokens.js';
import { createAuthorizer } from '../../authorizer/handler.js';
import { TrustedJwks } from '../../security/jwks.js';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { BillingAliasInvoker } from '../../access/adapters/billing.js';
import { Onboarding, OnboardingFailure, type OnboardingStore } from '../../access/onboarding.js';
import { subscriberBindingKey, transactionKey } from '../../access/grants.js';
import type { AccessRow, StateKey } from '../../access/model.js';
import type { BrowserContext } from '../../access/sessions.js';
import type { UsageBindingProvisioner } from '../../access/usage_bindings.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { composeBillingHandler, type HandlerConfig } from '../../billing/handler.js';
import { BillingService, type RuntimeBudgets } from '../../billing/service.js';
import { type BillingPayments, type BillingQueuePort, type BillingRepository, type Key, type Row, type Write, type DueCursor } from '../../billing/ports.js';
import { identityPartition } from '../../billing/contracts/validate.js';
import { Telemetry } from '../../observability/telemetry.js';
import { catalog, environment, identity, now, usage_mapping } from '../fixtures/contracts.js';
import { accessRecords } from '../fixtures/storage.js';

/*
 * Shared access/billing fixture. The access onboarding service calls the REAL billing handler through the
 * access BillingAliasInvoker (the Lambda SDK client is replaced by an in-process router). Billing state lives
 * in one in-memory repository with DynamoDB-equivalent revision guards. Stripe is a fake payment provider; the
 * webhook path uses the real signature verifier and HTTP adapter. Usage-plan provisioning is a fake, as in
 * client_journey.test.ts, because it needs API Gateway.
 */

import { budgets, FakeQueue, FakeStripe, handlerConfig, keyOf, MemoryBillingRepository, stripeAccount, webhookSecret } from '../fixtures/billing_memory.js';

const offer = { planId: 'basic', durationOptionId: 'short', catalogVersion: 'fixture_v1' };
const verifier = 'integration_pkce_verifier_0123456789abcdefghijklmnop';
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
const txId = 'tx_integration_fixture';
const ssmVersion = 1;

/** Access-side store: its own rows plus the billing entitlement projection, read through the billing repository. */
class IntegrationAccessStore implements OnboardingStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  constructor(private readonly billing: MemoryBillingRepository) {}
  async get(key: StateKey) { const row = this.rows.get(keyOf(key)); return row && structuredClone(row); }
  async entitlement(owner: { issuer: string; subject: string }) {
    const row = await this.billing.get(this.billing.key(owner, 'ENTITLEMENT'));
    return row && structuredClone(row) as unknown as AccessRow;
  }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{ key: StateKey; expectedRevision?: number; projection?: boolean }> = []) {
    for (const check of checks) {
      const value = check.projection ? await this.billing.get(check.key) : this.rows.get(keyOf(check.key));
      if (check.expectedRevision === undefined ? value !== undefined : value?.revision !== check.expectedRevision) throw conflictError();
    }
    for (const { row, expectedRevision } of writes) {
      const current = this.rows.get(keyOf(row as StateKey));
      if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) throw conflictError();
      validateAccessRecord(row, environment);
    }
    for (const { row } of writes) this.rows.set(keyOf(row as StateKey), structuredClone(row));
  }
}
function conflictError() { const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; return error; }

function accessTransaction(): AccessRow {
  return { PK: `ENV#test#TX#${txId}`, SK: 'STATE', entity_type: 'transaction', revision: 1, environment, purpose: 'onboarding',
    phase: 'identity_verified', grant_id: 'grant_integration_fixture', identity, subscriber_id: 'subscriber_fixture',
    correlation_id: 'integration_corr_fixture',
    downstream: { client_id: 'chatgpt_fixture', redirect_uri: 'https://chatgpt.example.invalid/callback',
      resource: 'https://api.example.invalid/test/mcp', scopes: ['openid', 'mcp:invoke'], code_challenge: challenge,
      code_challenge_method: 'S256', state: 'state_from_client_fixture', issuer: 'https://access.example.invalid',
      client_config_version: 'clients_fixture_v1' },
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 } as unknown as AccessRow;
}
function browser(tx: AccessRow): BrowserContext {
  return { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', session: {
    PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', entity_type: 'session', revision: 1, environment, purpose: 'onboarding',
    tx_id: txId, grant_id: tx.grant_id, authentication_stage: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
    csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  }, transaction: tx } as unknown as BrowserContext;
}

function world() {
  const telemetryConfig = { service: 'access', environment: 'test', release: 'integration_fixture' };
  const billingTelemetry = new Telemetry({ ...telemetryConfig, service: 'billing' } as never, { sink: () => undefined, now: () => now * 1000 });
  const accessTelemetry = new Telemetry(telemetryConfig as never, { sink: () => undefined, now: () => now * 1000 });
  const billingRepo = new MemoryBillingRepository(environment);
  const stripe = new FakeStripe();
  const queue = new FakeQueue();
  const service = new BillingService(billingRepo, stripe, queue, async () => ({ catalog, ssm_version: ssmVersion }) as never,
    stripeAccount, handlerConfig.supportEmail, budgets, billingTelemetry, () => now);
  const billingHandler = composeBillingHandler(handlerConfig, service, billingTelemetry,
    async () => ({ catalog, ssm_version: ssmVersion }) as never, async () => webhookSecret);

  // The access Lambda client is an in-process router to the real billing handler; it only sees serialized payloads.
  const invocations: string[] = [];
  const lambda = { send: async (command: { input: { Payload: Buffer } }) => {
    const payload = JSON.parse(Buffer.from(command.input.Payload).toString('utf8'));
    invocations.push(payload.operation);
    const reply = await billingHandler(payload, { awsRequestId: 'integration' } as never);
    return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(reply)) };
  } } as unknown as LambdaClient;
  const invoker = new BillingAliasInvoker(accessTelemetry, { environment, accountId: '000000000000',
    aliasArn: 'arn:aws:lambda:us-east-1:000000000000:function:billing:live' }, lambda);

  const access = new IntegrationAccessStore(billingRepo);
  let provisions = 0;
  const provisioner = { async ensure() {
    provisions++;
    const bindingKey = subscriberBindingKey(environment, 'subscriber_fixture', usage_mapping.rest_api_id, usage_mapping.stage);
    const revision = (await access.entitlement(identity))?.revision ?? 0;
    access.rows.set(keyOf(bindingKey), { ...(structuredClone(accessRecords.subscriber_binding) as AccessRow),
      PK: bindingKey.PK, SK: bindingKey.SK, entitlement_revision: revision });
    return { state: 'configured' as const, subscriberId: 'subscriber_fixture', entitlementRevision: revision,
      apiKeyId: 'key_fixture', apiKeyValue: 'K'.repeat(40), usageMapping: usage_mapping };
  } } as unknown as UsageBindingProvisioner;
  const onboarding = new Onboarding(access, invoker, provisioner, accessTelemetry, () => now);

  /** Delivers a Stripe webhook through the real HTTP adapter, signature check and billing service. */
  async function deliver(eventId: string, body: string, signedWith = webhookSecret) {
    const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: signedWith,
      timestamp: Math.floor(Date.now() / 1000) });
    return billingHandler({ httpMethod: 'POST', path: '/webhooks/stripe', isBase64Encoded: false,
      headers: { 'content-type': 'application/json', 'stripe-signature': header }, body } as never, { awsRequestId: eventId } as never) as Promise<{ statusCode: number }>;
  }
  const checkoutEvent = (eventId: string, sessionId: string, livemode = false) => JSON.stringify({
    id: eventId, object: 'event', type: 'checkout.session.completed', livemode, account: stripeAccount,
    data: { object: { id: sessionId } },
  });

  const tx = accessTransaction();
  access.rows.set(keyOf(transactionKey(environment, txId) as StateKey), structuredClone(tx));
  return { access, billingRepo, stripe, queue, onboarding, deliver, checkoutEvent, invocations, ctx: browser(tx), provisions: () => provisions };
}

test('browser return before the webhook stays payment pending, provisions nothing and creates exactly one checkout', async () => {
  const w = world();
  const redirect = await w.onboarding.checkout(w.ctx, offer);
  assert.equal(redirect.kind, 'redirect');
  assert.equal(w.stripe.creates, 1);
  assert.deepEqual(await w.onboarding.status(w.ctx), { state: 'payment_pending', retry_after_seconds: 5 });
  assert.equal(w.provisions(), 0, 'no access may be provisioned before a verified payment');
  assert.equal(await w.access.entitlement(identity), undefined, 'no entitlement projection before the webhook');
  await assert.rejects(w.onboarding.resume(w.ctx), error =>
    error instanceof OnboardingFailure && error.status === 409 && error.code === 'subscription_required');
});

test('a signed webhook activates the subscription once; duplicate delivery and repurchase never create a second order', async () => {
  const w = world();
  await w.onboarding.checkout(w.ctx, offer);
  const sessionId = 'cs_fixture_1';
  w.stripe.markPaid(sessionId);

  const body = w.checkoutEvent('evt_fixture_1', sessionId);
  assert.equal((await w.deliver('evt_fixture_1', body)).statusCode, 200);
  const projection = await w.access.entitlement(identity);
  assert.equal(projection?.allowed, true);
  assert.equal(projection?.revision, 1);

  assert.deepEqual(await w.onboarding.status(w.ctx), { state: 'activation_ready' });
  assert.equal(w.provisions(), 1);

  assert.equal((await w.deliver('evt_fixture_1', body)).statusCode, 200, 'duplicate delivery is accepted idempotently');
  assert.equal((await w.access.entitlement(identity))?.revision, 1, 'duplicate delivery must not write a second term');
  assert.equal(w.stripe.creates, 1);

  await assert.rejects(w.onboarding.checkout(w.ctx, offer), error =>
    error instanceof OnboardingFailure && error.code === 'already_eligible');
  assert.equal(w.stripe.creates, 1, 'an active subscriber cannot repurchase through the same continuation');

  const callback = new URL((await w.onboarding.resume(w.ctx)).location);
  assert.equal(callback.searchParams.get('state'), 'state_from_client_fixture');
  assert.ok(callback.searchParams.get('code'));
});

test('a webhook with a bad signature, wrong mode or unknown session changes no state', async () => {
  const w = world();
  await w.onboarding.checkout(w.ctx, offer);
  w.stripe.markPaid('cs_fixture_1');

  const forged = w.checkoutEvent('evt_forged_1', 'cs_fixture_1');
  assert.equal((await w.deliver('evt_forged_1', forged, 'whsec_wrong')).statusCode, 400);
  const liveMode = w.checkoutEvent('evt_live_1', 'cs_fixture_1', true);
  assert.equal((await w.deliver('evt_live_1', liveMode)).statusCode, 400);
  const unknown = w.checkoutEvent('evt_unknown_1', 'cs_fixture_999');
  assert.notEqual((await w.deliver('evt_unknown_1', unknown)).statusCode, 200);

  assert.equal(await w.access.entitlement(identity), undefined, 'rejected deliveries must not activate access');
  assert.deepEqual(await w.onboarding.status(w.ctx), { state: 'payment_pending', retry_after_seconds: 5 });
  assert.equal(w.provisions(), 0);
});

test('code exchange, PKCE, the authorizer, refresh and revocation all follow the billing projection', async () => {
  const w = world();
  await w.onboarding.checkout(w.ctx, offer);
  w.stripe.markPaid('cs_fixture_1');
  assert.equal((await w.deliver('evt_fixture_1', w.checkoutEvent('evt_fixture_1', 'cs_fixture_1'))).statusCode, 200);
  assert.deepEqual(await w.onboarding.status(w.ctx), { state: 'activation_ready' });

  const callback = new URL((await w.onboarding.resume(w.ctx)).location);
  const code = callback.searchParams.get('code')!;
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'integration_fixture' } as never,
    { sink: () => undefined, now: () => now * 1000 });
  const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const kid = 'integration_signer_fixture';
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  const issuer = 'https://access.example.invalid', resource = 'https://api.example.invalid/test/mcp';
  const tokens = new AccessTokens(w.access, async claims => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid }).sign(pair.privateKey), {
    issuer, resource, clockSkewSeconds: 5, accessTtlSeconds: 3600,
    target: async () => ({ rest_api_id: usage_mapping.rest_api_id, stage: usage_mapping.stage }),
  }, telemetry, () => now);
  const exchange = (codeVerifier: string) => tokens.exchangeCode({ code, clientId: 'chatgpt_fixture',
    redirectUri: 'https://chatgpt.example.invalid/callback', codeVerifier, resource });

  await assert.rejects(exchange(`${verifier}wrong`), /invalid_grant/);
  const first = await exchange(verifier);
  assert.equal(first.expires_in, 3600);
  await assert.rejects(exchange(verifier), /invalid_grant/, 'an authorization code is one use');

  const authorizer = createAuthorizer({ issuer, resource, clockSkewSeconds: 5,
    region: 'us-east-1', accountId: '000000000000', apiId: 'fixturerest', stage: 'test',
    routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }] },
    new TrustedJwks(async () => ({ keys: [jwk] })), telemetry, () => now);
  const requestArn = 'arn:aws:execute-api:us-east-1:000000000000:fixturerest/test/POST/mcp';
  const allowed = async (token: string) => {
    const decision = await authorizer({ type: 'REQUEST', methodArn: requestArn, headers: { authorization: `Bearer ${token}` } }, {});
    return decision.policyDocument.Statement[0]?.Effect === 'Allow' ? decision.usageIdentifierKey : undefined;
  };
  assert.equal(await allowed(first.access_token), 'K'.repeat(40));

  const refreshed = await tokens.refresh({ refreshToken: first.refresh_token, clientId: 'chatgpt_fixture', resource });
  assert.notEqual(refreshed.refresh_token, first.refresh_token);
  await assert.rejects(tokens.refresh({ refreshToken: first.refresh_token, clientId: 'chatgpt_fixture', resource }), /invalid_grant/,
    'a rotated refresh credential cannot be replayed');

  // Billing decides the entitlement is no longer allowed. The next refresh is denied and the family is revoked.
  const projection = await w.billingRepo.get(w.billingRepo.key(identity, 'ENTITLEMENT'));
  assert.ok(projection);
  await w.billingRepo.commit([{ row: { ...projection, allowed: false, revision: projection.revision + 1 }, expectedRevision: projection.revision }]);
  await assert.rejects(tokens.refresh({ refreshToken: refreshed.refresh_token, clientId: 'chatgpt_fixture', resource }), /invalid_grant/);
  const family = await w.access.get({ PK: `ENV#${environment}#GRANT#grant_integration_fixture`, SK: 'FAMILY' });
  assert.equal(family?.status, 'revoked', 'the refresh family is revoked when billing denies the entitlement');
  assert.equal(await allowed(refreshed.access_token), 'K'.repeat(40),
    'the stateless authorizer accepts an already-issued access token only until its signed expiry');

  // Expired OAuth: the same token is denied once its signed expiry has passed (one-hour access window).
  const later = createAuthorizer({ issuer, resource, clockSkewSeconds: 5,
    region: 'us-east-1', accountId: '000000000000', apiId: 'fixturerest', stage: 'test',
    routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }] },
    new TrustedJwks(async () => ({ keys: [jwk] })), telemetry, () => now + 3600 + 6);
  await assert.rejects(later({ type: 'REQUEST', methodArn: requestArn, headers: { authorization: `Bearer ${refreshed.access_token}` } }, {}),
    /Unauthorized/, 'an expired access token must not reach MCP');
});
