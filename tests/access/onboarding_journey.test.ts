import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OnboardingFailure } from '../../access/onboarding.js';
import { transactionKey } from '../../access/grants.js';
import { entitlement, environment, usage_mapping } from '../fixtures/contracts.js';
import { BillingFake, MemoryOnboardingStore, context, result, seedTransaction, service, transaction } from './support/onboarding_fakes.js';

const offer = { planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture_v1' };
const txKey = transactionKey(environment, 'tx_onboarding_fixture');
const checkoutOk = () => result('ok', { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' });

test('browser closure mid-checkout: a fresh request resumes from persisted state without a second provider order', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  seedTransaction(store, transaction('identity_verified'));
  const onboarding = service(store, billing);
  billing.replies.push(checkoutOk());
  await onboarding.checkout(context(transaction('identity_verified')), offer);

  // The browser is gone; the next request rebuilds its context only from the stored transaction.
  const reloaded = await store.get(txKey);
  assert.equal(reloaded?.phase, 'payment_pending');
  billing.replies.push(result('ok', { order_id: 'order_fixture', state: 'pending' }));
  const fresh = await service(store, billing).status(context(reloaded!));
  assert.equal(fresh.state, 'payment_pending');
  assert.equal(billing.calls.filter(call => call.operation === 'createCheckout').length, 1);
  assert.equal(billing.calls.at(-1)?.operation, 'getOrder');
});

test('duplicate paid notifications activate once and never create a second order', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = { ...transaction('payment_pending'), order_id: 'order_fixture',
    selected_offer: { plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture_v1', intent: 'purchase' } };
  seedTransaction(store, tx);
  const browser = context(tx);
  billing.replies.push(result('ok', { order_id: 'order_fixture', state: 'paid', activation_ref: 'activation_fixture' }));
  assert.equal((await service(store, billing).status(browser)).state, 'payment_pending');

  store.paid = structuredClone(entitlement);
  const first = await service(store, billing).status(browser);
  const second = await service(store, billing).status(browser);
  assert.deepEqual(first, { state: 'activation_ready' });
  assert.deepEqual(second, { state: 'activation_ready' });
  assert.equal(billing.calls.filter(call => call.operation === 'createCheckout').length, 0);
});

test('reordered delivery: resume before payment is refused and never issues a code', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = transaction('identity_verified');
  seedTransaction(store, tx);
  await assert.rejects(service(store, billing).resume(context(tx)), error =>
    error instanceof OnboardingFailure && error.status === 409 && error.code === 'subscription_required');
  assert.equal(billing.calls.length, 0);
  assert.equal((await store.get(txKey))?.phase, 'identity_verified');
});

test('a plan change after checkout is refused, and the original offer keeps its order', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  seedTransaction(store, transaction('identity_verified'));
  const onboarding = service(store, billing);
  billing.replies.push(checkoutOk());
  await onboarding.checkout(context(transaction('identity_verified')), offer);
  await assert.rejects(onboarding.checkout(context(transaction('identity_verified')), { ...offer, planId: 'premium' }), error =>
    error instanceof OnboardingFailure && error.code === 'offer_already_selected');
  assert.equal((await store.get(txKey))?.order_id, 'order_fixture');
});

test('a crash after the provider order but before its save is retried with the same idempotency key', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  seedTransaction(store, transaction('identity_verified'));
  const commit = store.commit.bind(store);
  let crashed = false;
  store.commit = async (...args: Parameters<typeof commit>) => {
    // The first save after the provider call is lost (for example, the process dies before the write lands).
    if (!crashed && args[0].some(write => write.row.phase === 'payment_pending')) { crashed = true; throw new Error('process_crashed'); }
    return commit(...args);
  };
  billing.replies.push(checkoutOk());
  await assert.rejects(service(store, billing).checkout(context(transaction('identity_verified')), offer));

  billing.replies.push(checkoutOk());
  const retry = await service(store, billing).checkout(context(transaction('identity_verified')), offer);
  assert.equal(retry.kind, 'redirect');
  const keys = billing.calls.filter(call => call.operation === 'createCheckout').map(call => call.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal((await store.get(txKey))?.order_id, 'order_fixture');
});

test('a late payment after the subscriber cancelled never reactivates the cancelled continuation', async () => {
  const store = new MemoryOnboardingStore(), billing = new BillingFake();
  const tx = transaction('cancelled');
  seedTransaction(store, tx);
  store.paid = structuredClone(entitlement);
  await assert.rejects(service(store, billing).status(context(tx)), error =>
    error instanceof OnboardingFailure && error.code === 'continuation_completed');
  await assert.rejects(service(store, billing).resume(context(tx)), error =>
    error instanceof OnboardingFailure && error.code === 'continuation_completed');
  assert.equal(usage_mapping.stage, 'test');
});
