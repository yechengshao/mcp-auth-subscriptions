import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccessRow, StateKey } from '../../access/model.js';
import { Onboarding, OnboardingFailure, type OnboardingStore } from '../../access/onboarding.js';
import { BillingAliasInvoker, type BillingCall, type BillingResult } from '../../access/adapters/billing.js';
import type { UsageBindingProvisioner } from '../../access/usage_bindings.js';
import type { BrowserContext } from '../../access/sessions.js';
import { credentialDigest, transactionKey, subscriberBindingKey } from '../../access/grants.js';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { identityPartition } from '../../contracts/identity.js';
import { Telemetry } from '../../observability/telemetry.js';
import { accessRecords } from '../fixtures/storage.js';
import { entitlement, environment, identity, now, usage_mapping } from '../fixtures/contracts.js';

const keyOf = (key: StateKey) => `${key.PK}\0${key.SK}`;
const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'onboarding_fixture' }, { sink: () => undefined });

class MemoryOnboardingStore implements OnboardingStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  paid: AccessRow | undefined;

  async get(key: StateKey) { const row = this.rows.get(keyOf(key)); return row && structuredClone(row); }
  async entitlement(owner: { issuer: string; subject: string }) {
    if (this.paid?.identity_issuer !== owner.issuer || this.paid?.identity_subject !== owner.subject) return undefined;
    return structuredClone(this.paid);
  }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }> = []) {
    for (const check of checks) {
      const value = check.projection ? this.paid : this.rows.get(keyOf(check.key));
      if (check.expectedRevision === undefined ? value !== undefined : value?.revision !== check.expectedRevision) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
    }
    for (const { row, expectedRevision } of writes) {
      const current = this.rows.get(keyOf(row as StateKey));
      if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
      validateAccessRecord(row, this.environment);
    }
    for (const { row } of writes) this.rows.set(keyOf(row as StateKey), structuredClone(row));
  }
}

class BillingFake {
  readonly calls: BillingCall[] = [];
  readonly replies: BillingResult[] = [];
  async invoke(call: BillingCall): Promise<BillingResult> {
    this.calls.push(structuredClone(call));
    const reply = this.replies.shift();
    if (!reply) throw new Error('unexpected_billing_call');
    return reply;
  }
}

const result = (outcome: BillingResult['outcome'], payload: Record<string, unknown>, correlation = 'onboarding_corr_fixture'): BillingResult => ({
  schema_version: 1, correlation_id: correlation, outcome, retryable: outcome === 'pending' || outcome === 'retryable_unavailable',
  message: 'fixture', payload,
});

function transaction(phase: string = 'identity_verified'): AccessRow {
  const txId = 'tx_onboarding_fixture';
  return { PK: `ENV#test#TX#${txId}`, SK: 'STATE', entity_type: 'transaction', schema_version: 1, revision: 1,
    environment, purpose: 'onboarding', phase, grant_id: 'grant_onboarding_fixture',
    identity, subscriber_id: 'subscriber_fixture', correlation_id: 'onboarding_corr_fixture',
    downstream: { client_id: 'chatgpt_fixture', redirect_uri: 'https://chatgpt.example.invalid/callback',
      resource: 'https://api.example.invalid/test/mcp', scopes: ['openid', 'mcp:invoke'],
      code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'state_from_client_fixture',
      issuer: 'https://access.example.invalid', client_config_version: 'clients_fixture_v1' },
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };
}
function context(tx = transaction()): BrowserContext {
  return { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', session: {
    PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', entity_type: 'session', schema_version: 1, revision: 1,
    environment, purpose: 'onboarding', tx_id: tx.tx_id ?? tx.PK.split('#').at(-1), grant_id: tx.grant_id,
    authentication_stage: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
    csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  }, transaction: tx };
}
function seedTransaction(store: MemoryOnboardingStore, tx: AccessRow) {
  store.rows.set(keyOf({ PK: tx.PK as string, SK: tx.SK as string }), structuredClone(tx));
}
function service(store: MemoryOnboardingStore, billing: BillingFake, provisioning?: Partial<UsageBindingProvisioner>) {
  const bindingProvisioner = { async ensure() {
    if (provisioning?.ensure) return provisioning.ensure({ identity, subscriberId: 'subscriber_fixture', invocationId: 'test_invocation' });
    return { state: 'configured', subscriberId: 'subscriber_fixture', entitlementRevision: store.paid?.revision ?? 1,
      apiKeyId: 'key_fixture', apiKeyValue: 'K'.repeat(40), usageMapping: usage_mapping };
  } } as unknown as UsageBindingProvisioner;
  return new Onboarding(store, billing as unknown as BillingAliasInvoker, bindingProvisioner, telemetry, () => now);
}

test('plan selection and checkout persist one immutable offer and reuse the billing idempotency key', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake(), onboarding = service(store, billing), browser = context();
  seedTransaction(store, browser.transaction);
  billing.replies.push(result('ok', { catalog_version: 'catalog_fixture_v1', plans: [{ plan_id: 'basic' }] }));
  assert.deepEqual(await onboarding.page(browser), { kind: 'plans', offers: { catalog_version: 'catalog_fixture_v1', plans: [{ plan_id: 'basic' }] } });

  billing.replies.push(result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }));
  const offer = { planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture_v1' };
  assert.deepEqual(await onboarding.checkout(browser, offer), { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/session_fixture' });
  const saved = await store.get(transactionKey(environment, 'tx_onboarding_fixture'));
  assert.equal(saved?.phase, 'payment_pending');
  assert.deepEqual(saved?.selected_offer, { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' });
  assert.equal(saved?.order_id, 'order_fixture');
  assert.equal(billing.calls[1]?.idempotencyKey, 'tx_onboarding_fixture');
  assert.equal(billing.calls[1]?.continuationRef, 'tx_onboarding_fixture');

  billing.replies.push(result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }));
  await onboarding.checkout(browser, offer);
  assert.equal(billing.calls[2]?.idempotencyKey, billing.calls[1]?.idempotencyKey);
  await assert.rejects(onboarding.checkout(browser, { ...offer, planId: 'premium' }), error =>
    error instanceof OnboardingFailure && error.status === 409 && error.code === 'offer_already_selected');
  assert.equal(billing.calls.length, 3);
});

test('status invokes request-driven binding only after the billing entitlement is authoritative', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('payment_pending'), order_id: 'order_fixture',
    selected_offer: { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' } };
  const browser = context(tx);
  seedTransaction(store, tx);
  billing.replies.push(result('ok', { order_id: 'order_fixture', state: 'paid', activation_ref: 'activation_fixture' }));
  const waiting = await service(store, billing).status(browser);
  assert.equal(waiting.state, 'payment_pending');
  assert.equal(billing.calls.length, 1);

  store.paid = structuredClone(entitlement);
  const ready = await service(store, billing).status(browser);
  assert.deepEqual(ready, { state: 'activation_ready' });
});

test('status safely resumes a persisted checkout intent after a lost billing response', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('checkout_pending'),
    selected_offer: { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' } };
  seedTransaction(store, tx);
  const browser = context(tx), onboarding = service(store, billing);
  billing.replies.push(result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }));
  assert.deepEqual(await onboarding.status(browser), { state: 'checkout_ready', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' });
  assert.equal((await store.get(transactionKey(environment, 'tx_onboarding_fixture')))?.phase, 'payment_pending');
  assert.equal(billing.calls[0]?.operation, 'createCheckout');
  assert.equal(billing.calls[0]?.idempotencyKey, 'tx_onboarding_fixture');
});

test('order status reads only the order attached to the verified continuation', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('payment_pending'), order_id: 'order_fixture',
    selected_offer: { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' } };
  seedTransaction(store, tx);
  const browser = context(tx), onboarding = service(store, billing);
  billing.replies.push(result('ok', { order_id: 'order_fixture', state: 'paid', activation_ref: 'activation_fixture' }));
  assert.deepEqual(await onboarding.orderStatus(browser, 'order_fixture'), { order_id: 'order_fixture', state: 'paid' });
  assert.deepEqual(billing.calls[0], { operation: 'getOrder', identity, idempotencyKey: 'tx_onboarding_fixture',
    continuationRef: 'tx_onboarding_fixture', input: { order_id: 'order_fixture' } });

  await assert.rejects(onboarding.orderStatus(browser, 'another_order'), error =>
    error instanceof OnboardingFailure && error.status === 404 && error.code === 'order_not_found');
  assert.equal(billing.calls.length, 1);
});

test('resume creates one PKCE-bound authorization code only after paid binding readiness', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake(), tx = transaction();
  seedTransaction(store, tx);
  store.paid = structuredClone(entitlement);
  const bindingKey = subscriberBindingKey(environment, 'subscriber_fixture', usage_mapping.rest_api_id, usage_mapping.stage);
  const binding = { ...accessRecords.subscriber_binding!, PK: bindingKey.PK, SK: bindingKey.SK } as AccessRow;
  store.rows.set(keyOf(bindingKey), binding);
  const browser = context(tx), onboarding = service(store, billing);
  const first = await onboarding.resume(browser);
  const callback = new URL(first.location);
  assert.equal(callback.origin, 'https://chatgpt.example.invalid');
  assert.equal(callback.searchParams.get('state'), 'state_from_client_fixture');
  assert.equal(callback.searchParams.get('iss'), 'https://access.example.invalid');
  const code = callback.searchParams.get('code')!;
  const row = await store.get({ PK: `ENV#test#CODE#${credentialDigest(code)}`, SK: 'CODE' });
  assert.equal(row?.consumed, false);
  assert.equal(row?.code_challenge, 'A'.repeat(43));
  assert.equal(row?.grant_id, 'grant_onboarding_fixture');
  const saved = await store.get(transactionKey(environment, 'tx_onboarding_fixture'));
  assert.equal(saved?.phase, 'code_issued');
  await assert.rejects(onboarding.resume(browser), error => error instanceof OnboardingFailure && error.code === 'continuation_completed');
  assert.equal([...store.rows.values()].filter(value => value.entity_type === 'authorization_code').length, 1);
});

test('resume blocks a mismatched entitlement owner and retains a retryable activation error', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake(), tx = transaction();
  seedTransaction(store, tx);
  store.paid = { ...structuredClone(entitlement), identity_subject: 'another_user' };
  const browser = context(tx), onboarding = service(store, billing, { async ensure() { throw new Error('activation_retry'); } });
  await assert.rejects(onboarding.resume(browser), error => error instanceof OnboardingFailure && error.code === 'subscription_required');
  assert.equal(store.rows.size, 1);

  store.paid = structuredClone(entitlement);
  await assert.rejects(onboarding.resume(browser), error => error instanceof OnboardingFailure && error.status === 503 && error.retryable);
  assert.equal((await store.get(transactionKey(environment, 'tx_onboarding_fixture')))?.phase, 'identity_verified');
});

test('concurrent checkout requests share one persisted offer, order and provider idempotency key', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake(), browser = context();
  seedTransaction(store, browser.transaction);
  billing.replies.push(
    result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }),
    result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }),
  );
  const onboarding = service(store, billing), offer = { planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture_v1' };
  const outcomes = await Promise.all([onboarding.checkout(browser, offer), onboarding.checkout(browser, offer)]);
  assert.deepEqual(outcomes, [
    { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/session_fixture' },
    { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/session_fixture' },
  ]);
  assert.equal(billing.calls.length, 2);
  assert.equal(new Set(billing.calls.map(call => call.idempotencyKey)).size, 1);
  assert.equal((await store.get(transactionKey(environment, 'tx_onboarding_fixture')))?.order_id, 'order_fixture');
});

test('concurrent resume requests issue exactly one callback code', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake(), tx = transaction();
  seedTransaction(store, tx); store.paid = structuredClone(entitlement);
  const bindingKey = subscriberBindingKey(environment, 'subscriber_fixture', usage_mapping.rest_api_id, usage_mapping.stage);
  store.rows.set(keyOf(bindingKey), { ...(accessRecords.subscriber_binding as AccessRow), ...bindingKey });
  const onboarding = service(store, billing), browser = context(tx);
  const outcomes = await Promise.allSettled([onboarding.resume(browser), onboarding.resume(browser)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected' && value.reason instanceof OnboardingFailure && value.reason.code === 'continuation_completed').length, 1);
  assert.equal([...store.rows.values()].filter(value => value.entity_type === 'authorization_code').length, 1);
  assert.equal((await store.get(transactionKey(environment, 'tx_onboarding_fixture')))?.phase, 'code_issued');
});
