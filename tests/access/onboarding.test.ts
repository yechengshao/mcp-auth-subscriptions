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


import { BillingFake, MemoryOnboardingStore, context, result, seedTransaction, service, telemetry, keyOf, transaction } from './support/onboarding_fakes.js';

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

test('a checkout intent that cannot be saved leaves the transaction unchanged, and a retry completes once', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = transaction('identity_verified');
  seedTransaction(store, tx);
  const browser = context(tx), onboarding = service(store, billing);
  const commit = store.commit.bind(store);
  let failures = 1;
  store.commit = async (...args: Parameters<typeof commit>) => {
    if (failures-- > 0) throw new Error('dynamodb_timeout');
    return commit(...args);
  };
  const offer = { planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture_v1' };
  await assert.rejects(onboarding.checkout(browser, offer), error =>
    error instanceof OnboardingFailure && error.status === 503 && error.code === 'temporarily_unavailable');
  assert.equal((await store.get(transactionKey(environment, 'tx_onboarding_fixture')))?.phase, 'identity_verified');
  assert.equal(billing.calls.length, 0, 'no provider call may happen before the intent is saved');

  billing.replies.push(result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }));
  assert.deepEqual(await onboarding.checkout(browser, offer), { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/session_fixture' });
  assert.equal(billing.calls.length, 1);
  assert.equal(billing.calls[0]?.idempotencyKey, 'tx_onboarding_fixture');
});

test('an expired onboarding continuation is refused before any billing, binding or code step', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('checkout_pending'), expires_at: now };
  seedTransaction(store, tx);
  const browser = context(tx), onboarding = service(store, billing);
  const offer = { planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture_v1' };
  await assert.rejects(onboarding.checkout(browser, offer), error => error instanceof OnboardingFailure && error.code === 'session_expired');
  await assert.rejects(onboarding.status(browser), error => error instanceof OnboardingFailure && error.code === 'session_expired');
  await assert.rejects(onboarding.resume(browser), error => error instanceof OnboardingFailure && error.code === 'session_expired');
  assert.equal(billing.calls.length, 0);
});

test('a payment that completes after the continuation failed sends the browser back to sign-in instead of reporting failure', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('failed'), order_id: 'order_fixture',
    selected_offer: { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' } };
  seedTransaction(store, tx);
  const browser = context(tx), onboarding = service(store, billing);
  assert.deepEqual(await onboarding.status(browser), { state: 'payment_failed' });

  store.paid = structuredClone(entitlement);
  await assert.rejects(onboarding.status(browser), error =>
    error instanceof OnboardingFailure && error.status === 409 && error.code === 'continuation_completed');
  assert.equal(billing.calls.length, 0);
});

