import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingRecordSchemas, validateBillingRecord, quoteDigest } from '../../billing/contracts/storage.js';
import { validateBudgets, accessReadGrants } from '../../billing/contracts/configuration.js';
import { validateResult, browserStatus } from '../../billing/contracts/results.js';
import { billingRecords, quote, budgets } from '../fixtures/storage.js';
import { publicPlans, validateCatalog } from '../../billing/contracts/validate.js';
import { catalog, scope, now } from '../fixtures/contracts.js';

assert.deepEqual(Object.keys(billingRecords).sort(), Object.keys(billingRecordSchemas).sort());
for (const [kind, value] of Object.entries(billingRecords)) {
  test(`billing ${kind}: exact-key v1 fixture and closed persistent shape`, () => {
    validateBillingRecord(value, 'test');
    for (const change of [{ PK: 'wrong' }, { SK: 'wrong' }, { schema_version: 2 }, { environment: 'prod' },
      { revision: -1 }, { delete_after: now }, { raw_provider_payload: 'SENTINEL_PRIVATE' }]) {
      assert.throws(() => validateBillingRecord({ ...value, ...change }, 'test'));
    }
    const { entity_type: _type, ...missingType } = value;
    assert.throws(() => validateBillingRecord(missingType, 'test'));
  });
}
test('upgrade quotes enforce exact minor-unit math, tier order, scope and tamper evidence', () => {
  for (const changes of [{ credit_minor: 501 }, { payable_minor: 735 }, { source_end: now },
    { source_tier_order: 2 }, { quote_at: now - 101 }, { expires_at: now }, { currency: 'eur' },
    { full_amount_minor: 1 }, { target_tier_order: 0 }]) {
    const value: Record<string, unknown> = { ...quote, ...changes }; value.quote_digest = quoteDigest(value);
    assert.throws(() => validateBillingRecord(value, 'test'));
  }
  const fractional: Record<string, unknown> = { ...quote, eligible_old_value_minor: 1001 };
  fractional.quote_digest = quoteDigest(fractional);
  validateBillingRecord(fractional, 'test'); // 1001 * 1/2 is floored to 500.
  assert.throws(() => validateBillingRecord({ ...quote, expires_at: now + 61 }, 'test'));
});
test('released/consumed reservations need matching verified terminal evidence, never TTL unlock', () => {
  const reservation = billingRecords.credit_reservation!;
  for (const state of ['released', 'consumed']) {
    assert.throws(() => validateBillingRecord({ ...reservation, state }, 'test'));
    validateBillingRecord({ ...reservation, state, terminal_evidence: {
      outcome: state === 'released' ? 'terminal_unpaid' : 'paid', provider_object_id: 'cs_fixture', observed_at: now,
    } }, 'test');
  }
  assert.throws(() => validateBillingRecord({ ...reservation, state: 'released',
    terminal_evidence: { outcome: 'paid', provider_object_id: 'cs_fixture', observed_at: now } }, 'test'));
});
test('work dispatch and terminal fields cannot falsely claim sent or completed work', () => {
  const work = billingRecords.reconciliation_work!;
  for (const changes of [{ dispatch_status: 'sent' }, { dispatch_status: 'claimed' },
    { state: 'complete' }, { generation: 0 }, { next_attempt_at: now }, { deadline: now }]) {
    assert.throws(() => validateBillingRecord({ ...work, ...changes }, 'test'));
  }
  validateBillingRecord({ ...work, dispatch_status: 'sent', expected_message_due_at: now + 300 }, 'test');
});
test('missing deployment budgets and unsafe visibility/concurrency/recovery combinations reject', () => {
  validateBudgets(budgets);
  for (const changes of [{ visibility_timeout_seconds: 184 }, { sqs_concurrency: 5 },
    { processing_budget_ms: 30000 }, { processing_lease_seconds: 10 }, { initial_delay_seconds: 901 },
    { history_retention_seconds: 86400 }, { recovery_horizon_seconds: 60 },
    { catalog_cache_seconds: 61 }, { catalog_fetch_timeout_ms: 3001 }]) assert.throws(() => validateBudgets({ ...budgets, ...changes }));
  for (const key of Object.keys(budgets)) {
    const incomplete: Record<string, unknown> = { ...budgets }; delete incomplete[key];
    assert.throws(() => validateBudgets(incomplete));
  }
});
test('access read interface grants only the exact projection and billing alias', () => {
  const input = { environment: 'test', entitlement_table_arn: 'arn:aws:dynamodb:us-east-1:000000000000:table/fixture-entitlements',
    billing_alias_arn: 'arn:aws:lambda:us-east-1:000000000000:function:fixture-billing:current' };
  const statements = accessReadGrants(input);
  assert.deepEqual(statements.map(s => s.Action), [['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], ['lambda:InvokeFunction']]);
  assert.deepEqual(statements.map(s => s.Resource), [input.entitlement_table_arn, input.billing_alias_arn]);
  for (const changes of [{ entitlement_table_arn: '*' }, { billing_alias_arn: input.billing_alias_arn.replace(':current', '') },
    { billing_alias_arn: input.billing_alias_arn.replace('000000000000', '111111111111') },
    { billing_state_arn: 'must-not-grant' }]) assert.throws(() => accessReadGrants({ ...input, ...changes }));
});
test('typed results expose display data, not internal records; financial paths cannot report success', () => {
  const base = { schema_version: 1, correlation_id: 'corr_fixture', message: 'Safe summary', retryable: false, outcome: 'ok' };
  const list = { ...base, payload: publicPlans(validateCatalog(catalog, scope)) };
  validateResult(list, 'listPlans');
  assert.throws(() => validateResult({ ...list, payload: { ...list.payload, api_key_value: 'SENTINEL_PRIVATE' } }, 'listPlans'));
  const management = { ...base, payload: { subscription_id: 'sub_fixture', next_action: 'select_upgrade' } };
  validateResult(management, 'manageSubscription', 'upgrade');
  for (const action of ['cancel', 'refund', 'downgrade']) assert.throws(() => validateResult(management, 'manageSubscription', action));
  assert.throws(() => validateResult(management, 'openPortal'));
  const support = { ...base, outcome: 'support_required', error_code: 'financial_support_required',
    payload: { support_email: 'support@example.invalid' } };
  validateResult(support, 'manageSubscription', 'refund');
  validateResult({ ...support, outcome: 'denied', error_code: 'not_owner', payload: {} }, 'manageSubscription', 'refund');
  validateResult({ ...support, error_code: 'feature_unavailable' }, 'openPortal');
  assert.throws(() => validateResult(support, 'openPortal'));
  assert.throws(() => validateResult({ ...support, payload: { support_email: 'support@example.invalid\nBcc: evil' } }, 'manageSubscription', 'refund'));
  assert.deepEqual(Object.values(browserStatus), [200, 202, 403, 503, 409, 400, 409]);
});
test('pending and retryable results require bounded retry guidance', () => {
  const value = { schema_version: 1, correlation_id: 'corr_fixture', outcome: 'pending', retryable: true,
    message: 'Payment processing', payload: { order_id: 'order_fixture', activation_ref: 'activation_fixture', reason: 'payment_pending',
      retry: { retry_after_seconds: 5, next_attempt_at: now + 5 } } };
  validateResult(value, 'getOrder');
  assert.throws(() => validateResult({ ...value, payload: { ...value.payload, retry: { retry_after_seconds: 0, next_attempt_at: now } } }, 'getOrder'));
  assert.throws(() => validateResult(value, 'openPortal'));
  assert.throws(() => validateResult({ ...value, outcome: 'retryable_unavailable', error_code: 'dependency_unavailable', payload: {} }, 'getOrder'));
});

test('canonical positive result fixtures cover every supported operation and all outcomes', () => {
  const base = { schema_version: 1, correlation_id: 'corr_fixture', message: 'Safe summary', outcome: 'ok', retryable: false };
  const checkout = { order_id: 'order_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/synthetic_fixture' };
  const status = { order_id: 'order_fixture', state: 'pending', activation_ref: 'activation_fixture' };
  const success = {
    listPlans: publicPlans(validateCatalog(catalog, scope)), createCheckout: checkout, confirmUpgrade: checkout,
    getOrder: status, reconcileOrder: status,
    quoteUpgrade: { quote_id: 'quote_fixture', subscription_id: 'sub_fixture', source_revision: 1,
      plan_id: 'premium_fixture', duration_option_id: 'short', service_term: catalog.plans.basic.duration_options.short.service_term,
      full_amount_minor: 1234, credit_minor: 500, payable_minor: 734, currency: 'usd', expires_at: now + 60, starts_new_term: true },
    manageSubscription: { subscription_id: 'sub_fixture', next_action: 'select_upgrade' },
  };
  for (const [operation, payload] of Object.entries(success)) {
    validateResult({ ...base, payload }, operation, 'upgrade');
    assert.throws(() => validateResult({ ...base, payload: { ...payload, access_token: 'SENTINEL_PRIVATE' } }, operation, 'upgrade'));
  }
  for (const [outcome, error_code, retryable, payload] of [
    ['denied', 'not_owner', false, {}],
    ['retryable_unavailable', 'dependency_unavailable', true, { retry_after_seconds: 5, next_attempt_at: now + 5 }],
    ['conflict', 'catalog_changed', false, {}], ['invalid_request', 'invalid_request', false, {}],
    ['support_required', 'financial_support_required', false, { support_email: 'support@example.invalid' }],
  ] as const) validateResult({ ...base, outcome, error_code, retryable, payload }, 'getOrder');
  assert.throws(() => validateResult({ ...base, payload: { ...checkout, checkout_url: 'https://evil.invalid/' } }, 'createCheckout'));
});

test('upgrade orders preserve full catalog price and separately bind the quoted net payment', () => {
  const order = billingRecords.order!;
  const upgrade = { ...order, intent: 'upgrade', quote_id: 'quote_fixture', payable_minor: 734, credit_minor: 500 };
  validateBillingRecord(upgrade, 'test');
  assert.throws(() => validateBillingRecord({ ...upgrade, payable_minor: 1234 }, 'test'));
  assert.throws(() => validateBillingRecord({ ...upgrade, intent: 'purchase' }, 'test'));
  assert.throws(() => validateBillingRecord({ ...order, intent: 'upgrade' }, 'test'));
});
