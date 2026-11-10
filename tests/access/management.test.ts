import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Management, ManagementFailure } from '../../access/management.js';
import type { AccessRow } from '../../access/model.js';
import type { BillingCall, BillingResult } from '../../access/adapters/billing.js';
import type { BrowserContext } from '../../access/sessions.js';
import type { UsageBindingProvisioner } from '../../access/usage_bindings.js';
import { identity, entitlement, environment, now } from '../fixtures/contracts.js';
import { Telemetry } from '../../observability/telemetry.js';

const keyOf = (row: any) => `${row.PK}\0${row.SK}`;
const txId = 'management_tx_fixture';
function managementTransaction(): AccessRow {
  return { PK: `ENV#${environment}#TX#${txId}`, SK: 'STATE', entity_type: 'transaction', schema_version: 1, revision: 1,
    environment, purpose: 'management', phase: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
    local_destination: '/billing', created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };
}
function context(transaction = managementTransaction()): BrowserContext {
  return { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', transaction, session: {
    PK: `ENV#${environment}#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', entity_type: 'session', schema_version: 1, revision: 1,
    environment, purpose: 'management', tx_id: txId, authentication_stage: 'identity_verified', identity,
    subscriber_id: 'subscriber_fixture', csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800,
    delete_after: now + 1800 + 86400,
  } };
}
const reply = (outcome: BillingResult['outcome'], payload: Record<string, unknown>, error_code?: string): BillingResult => ({
  schema_version: 1, correlation_id: 'management_corr_fixture', outcome,
  retryable: outcome === 'pending' || outcome === 'retryable_unavailable', message: 'fixture', payload,
  ...(error_code ? { error_code } : {}),
});

function fixture() {
  const rows = new Map<string, AccessRow>([[keyOf(managementTransaction()), managementTransaction()]]);
  const calls: BillingCall[] = [];
  const replies: BillingResult[] = [];
  const store = {
    environment,
    async get(key: { PK: string; SK: string }) { const row = rows.get(keyOf(key)); return row && structuredClone(row); },
    async entitlement() { return structuredClone(entitlement); },
    async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>) {
      for (const write of writes) {
        const current = rows.get(keyOf(write.row));
        if (write.expectedRevision === undefined ? current !== undefined : current?.revision !== write.expectedRevision) {
          const conflict = new Error('conflict'); conflict.name = 'TransactionCanceledException'; throw conflict;
        }
      }
      for (const write of writes) rows.set(keyOf(write.row), structuredClone(write.row));
    },
  };
  const billing = { async invoke(call: BillingCall) { calls.push(structuredClone(call)); const next = replies.shift(); if (!next) throw new Error('unexpected_call'); return next; } };
  let provisions = 0;
  const provisioner = { async ensure() { provisions++; return { state: 'configured' }; } } as unknown as UsageBindingProvisioner;
  const telemetry = new Telemetry({ service: 'access', environment, release: 'management_test' }, { sink: () => undefined });
  const management = new Management(store as never, billing as never, provisioner, telemetry, () => now);
  return { management, calls, replies, rows, get provisions() { return provisions; } };
}

test('upgrade quote derives subscription and current revision from the verified entitlement', async () => {
  const value = fixture();
  value.replies.push(reply('ok', { quote_id: 'quote_fixture', subscription_id: 'subscription_fixture', source_revision: 1,
    plan_id: 'premium', duration_option_id: 'monthly', service_term: { unit: 'month', count: 1, time_semantics: 'utc_calendar_clamp' },
    full_amount_minor: 5000, credit_minor: 1200, payable_minor: 3800, currency: 'usd', expires_at: now + 300, starts_new_term: true }));
  const result = await value.management.manage(context(), 'subscription_fixture', {
    action: 'quote_upgrade', plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_v2',
  });
  assert.deepEqual(result, { kind: 'quote', quote: {
    quote_id: 'quote_fixture', subscription_id: 'subscription_fixture', source_revision: 1,
    plan_id: 'premium', duration_option_id: 'monthly', service_term: { unit: 'month', count: 1, time_semantics: 'utc_calendar_clamp' },
    full_amount_minor: 5000, credit_minor: 1200, payable_minor: 3800, currency: 'usd', expires_at: now + 300, starts_new_term: true,
  } });
  assert.deepEqual(value.calls[0]?.input, { subscription_id: 'subscription_fixture', source_revision: 1,
    plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_v2' });
  assert.equal(value.calls[0]?.operation, 'quoteUpgrade');
  assert.deepEqual(value.calls[0]?.identity, identity);
});

test('subscription and order references cannot be supplied for another owner', async () => {
  const value = fixture();
  await assert.rejects(value.management.manage(context(), 'other_subscription', {
    action: 'quote_upgrade', plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_v2',
  }), error => error instanceof ManagementFailure && error.status === 404);
  await assert.rejects(value.management.orderStatus(context(), 'other_order'), error =>
    error instanceof ManagementFailure && error.status === 404);
  assert.equal(value.calls.length, 0);
});

test('upgrade confirmation saves the exact reusable order before redirecting to Stripe', async () => {
  const value = fixture();
  value.replies.push(reply('ok', { order_id: 'upgrade_order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/session_fixture' }));
  const result = await value.management.manage(context(), 'subscription_fixture', { action: 'confirm_upgrade', quote_id: 'quote_fixture' });
  assert.deepEqual(result, { kind: 'redirect', order_id: 'upgrade_order_fixture', url: 'https://checkout.stripe.com/c/pay/session_fixture' });
  const saved = await value.management.orderStatus(context({ ...managementTransaction(), order_id: 'upgrade_order_fixture' }), 'upgrade_order_fixture').catch(error => error);
  assert.ok(saved instanceof ManagementFailure); // Billing still needs to report the status; the order ID is persisted locally.
  assert.equal((await value.rows.get(keyOf(managementTransaction())))?.order_id, 'upgrade_order_fixture');
  assert.equal(value.calls[0]?.operation, 'confirmUpgrade');
  assert.deepEqual(value.calls[0]?.input, { quote_id: 'quote_fixture' });
});

test('malformed Billing Checkout URLs fail with a sanitized retryable response', async () => {
  const value = fixture();
  value.replies.push(reply('ok', { order_id: 'upgrade_order_fixture', checkout_url: 'not-a-url' }));
  await assert.rejects(value.management.manage(context(), 'subscription_fixture', { action: 'confirm_upgrade', quote_id: 'quote_fixture' }),
    error => error instanceof ManagementFailure && error.status === 503 && error.code === 'invalid_billing_response' && error.retryable);
  assert.equal((await value.rows.get(keyOf(managementTransaction())))?.order_id, undefined);
});

test('failed payment status does not mutate the purchased binding', async () => {
  const value = fixture();
  const tx = { ...managementTransaction(), order_id: 'upgrade_order_fixture' };
  value.rows.set(keyOf(tx), tx);
  value.replies.push(reply('ok', { order_id: 'upgrade_order_fixture', state: 'failed', activation_ref: 'activation_fixture' }));
  assert.deepEqual(await value.management.status(context(tx)), { state: 'payment_failed' });
  assert.equal(value.provisions, 0);
});

test('verified paid upgrade triggers request-driven idempotent binding preparation', async () => {
  const value = fixture();
  const tx = { ...managementTransaction(), order_id: 'upgrade_order_fixture' };
  value.rows.set(keyOf(tx), tx);
  value.replies.push(reply('ok', { order_id: 'upgrade_order_fixture', state: 'paid', activation_ref: 'activation_fixture' }));
  assert.deepEqual(await value.management.status(context(tx)), { state: 'activation_ready', plan_id: 'basic', valid_until: entitlement.valid_until });
  assert.equal(value.provisions, 1);
});

test('downgrade and refund actions are delegated to Billing and remain support-only', async () => {
  const value = fixture();
  value.replies.push(reply('support_required', { support_email: 'support@example.invalid' }, 'financial_support_required'));
  assert.deepEqual(await value.management.manage(context(), 'subscription_fixture', { action: 'downgrade' }), {
    kind: 'support', email: 'support@example.invalid', code: 'financial_support_required',
  });
  assert.equal(value.calls[0]?.operation, 'manageSubscription');
  assert.deepEqual(value.calls[0]?.input, { subscription_id: 'subscription_fixture', action: 'downgrade' });
});
