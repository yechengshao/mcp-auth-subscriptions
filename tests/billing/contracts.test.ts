import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, term } from '../../billing/contracts/schemas.js';
import { validateCatalog, purchaseSnapshot, publicPlans, identityKey, validateEntitlement, validateQueue, validateOperation, validateOrder, validateFailure } from '../../billing/contracts/validate.js';
import { catalog, scope, identity, entitlement, now, message, operation, PK } from '../fixtures/contracts.js';

test('catalog validates deployment scope and rejects unsupported/unsafe offers', () => {
  assert.equal(validateCatalog(catalog, scope).catalog_version, 'fixture_v1');
  for (const invalid of [
    { ...catalog, schema_version: 2 }, { ...catalog, environment: 'prod' },
    { ...catalog, stripe_account: 'acct_other' }, { ...catalog, api_key: 'secret' },
    { ...catalog, plans: { basic: { ...catalog.plans.basic, usage_mapping: {} } } },
    { ...catalog, plans: { basic: catalog.plans.basic, duplicate: catalog.plans.basic } },
  ]) assert.throws(() => validateCatalog(invalid, scope));
  for (const invalid of [{ mode: 'subscription' }, { amount_minor: -1 }, { amount_minor: 1.5 },
    { service_term: { unit: 'day', count: 0, time_semantics: 'utc_fixed_days' } }, { enabled_for_purchase: false }]) {
    const value = structuredClone(catalog);
    Object.assign(value.plans.basic.duration_options.short, invalid);
    assert.throws(() => validateCatalog(value, scope));
  }
});
test('public catalog omits provider references; snapshots survive catalog replacement', () => {
  const validated = validateCatalog(catalog, scope);
  const snapshot = purchaseSnapshot(validated, 1, 'basic', 'short', 'fixture_v1');
  validated.plans.basic!.usage_mapping.usage_plan_id = 'replacement';
  validated.plans.basic!.duration_options.short!.amount_minor = 9999;
  assert.equal(snapshot.usage_mapping.usage_plan_id, 'fixture_usage');
  assert.equal(snapshot.amount_minor, 1234);
  assert.throws(() => purchaseSnapshot(validated, 2, 'basic', 'short', 'old'), /catalog_changed/);
  assert.throws(() => purchaseSnapshot(validated, 2, 'basic', 'forged', 'fixture_v1'));
  const display = JSON.stringify(publicPlans(validated));
  for (const privateField of ['price_id', 'product_id', 'usage_plan_id', 'stripe_account', 'aws_account_id']) assert.ok(!display.includes(privateField));
  validated.plans.basic!.enabled_for_purchase = false;
  assert.deepEqual(publicPlans(validated).plans, []);
});
test('identity uses unambiguous UTF8 tuple hashing shared across stores', () => {
  assert.equal(identityKey('https://issuer', 'user'), 'ebc90579a1644c4edfb3dc57860b739cd5fc9c3191478bf5896747b33cfaaea7');
  assert.notEqual(identityKey('ab', 'c'), identityKey('a', 'bc'));
  assert.notEqual(identityKey('issuer', 'User'), identityKey('issuer', 'user'));
});
test('entitlements fail closed on ownership, expiry, unavailable shape and native-key leakage', () => {
  const check = (value: unknown) => validateEntitlement(value, 'test', identity.issuer, identity.subject, now);
  check(entitlement);
  for (const value of [null, {}, { ...entitlement, allowed: false }, { ...entitlement, valid_until: now },
    { ...entitlement, PK: 'other' }, { ...entitlement, identity_subject: 'other' },
    { ...entitlement, api_key: 'private' }, { ...entitlement, valid_until: now * 1000 }]) assert.throws(() => check(value));
});
test('queue carries references only and rejects cross-environment/order/native-operation injection', () => {
  validateQueue(message, 'test');
  validateQueue({ ...message, message_type: 'dispatch_hint' }, 'test');
  for (const value of [{ ...message, generation: 0 }, { ...message, environment: 'prod' },
    { ...message, durable_record_key: { PK, SK: 'ORDER#work_fixture' } },
    { ...message, operation_id: 'different' }, { ...message, payment: { paid: true } },
    { ...message, identity }, { ...message, token: 'private' }, { ...message, message_type: 'unknown' }]) assert.throws(() => validateQueue(value, 'test'));
});
test('native envelopes reject browser authority and ambiguous handler shapes', () => {
  validateOperation(operation, 'test');
  validateOperation({ ...operation, operation: 'createCheckout', input: { plan_id: 'basic', duration_option_id: 'short', catalog_version: 'v1', intent: 'purchase' } }, 'test');
  for (const value of [{ ...operation, Records: [] }, { ...operation, body: '{}' },
    { ...operation, environment: 'prod' }, { ...operation, operation: 'refund' },
    { ...operation, input: { customer: 'forged' } },
    { ...operation, operation: 'createCheckout', input: { plan_id: 'basic', amount_minor: 1 } }]) assert.throws(() => validateOperation(value, 'test'));
});
test('order is owner-scoped and preserves immutable server snapshot; paid rows have no TTL', () => {
  const snapshot = purchaseSnapshot(validateCatalog(catalog, scope), 1, 'basic', 'short', 'fixture_v1');
  const order = { PK, SK: 'ORDER#order_fixture', schema_version: 1, entity_type: 'order', revision: 1,
    environment: 'test', identity, order_id: 'order_fixture', operation_id: 'operation_fixture', intent: 'purchase',
    state: 'pending', snapshot, created_at: now, updated_at: now };
  validateOrder(order, 'test');
  for (const value of [{ ...order, delete_after: now }, { ...order, identity: { ...identity, subject: 'other' } },
    { ...order, SK: 'ORDER#other' }, { ...order, snapshot: { ...snapshot, environment: 'prod' } }]) assert.throws(() => validateOrder(value, 'test'));
});
test('failure vocabulary cannot disguise refunds, stale catalog or invalid error combinations', () => {
  const base = { schema_version: 1, correlation_id: 'corr', message: 'Contact support', retryable: false };
  validateFailure({ ...base, outcome: 'support_required', error_code: 'financial_support_required' });
  validateFailure({ ...base, outcome: 'conflict', error_code: 'catalog_changed' });
  for (const value of [{ ...base, outcome: 'ok', error_code: 'financial_support_required' },
    { ...base, outcome: 'conflict', error_code: 'unsupported_credit_case' },
    { ...base, outcome: 'support_required', error_code: 'financial_support_required', retryable: true },
    { ...base, outcome: 'denied', error_code: 'not_owner', raw_error: 'private' }]) assert.throws(() => validateFailure(value));
});
test('authoritative service-term schema accepts/rejects every saved vector', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../specs/003-billing-subscriptions/contracts/service-term.examples.json', import.meta.url), 'utf8')) as { valid: unknown[]; invalid: unknown[] };
  const validate = compile(term);
  for (const value of vectors.valid) validate(value);
  for (const value of vectors.invalid) assert.throws(() => validate(value));
});

test('term expiry follows original UTC calendar day without iterative drift or DST', async () => {
  const { termExpiry } = await import('../../billing/contracts/service-term.js');
  const vectors = JSON.parse(readFileSync(new URL('../../../specs/003-billing-subscriptions/contracts/service-term.examples.json', import.meta.url), 'utf8')) as {
    calendar_cases: Array<{ start: string; unit: string; count: number; expected_expiry: string }>;
  };
  for (const value of vectors.calendar_cases) {
    const result = termExpiry(Date.parse(value.start) / 1000, { unit: value.unit, count: value.count,
      time_semantics: value.unit === 'day' ? 'utc_fixed_days' : 'utc_calendar_clamp' });
    assert.equal(result, Date.parse(value.expected_expiry) / 1000);
  }
  for (const invalid of [-1, now * 1000, NaN, Infinity, now + 0.5]) assert.throws(() => termExpiry(invalid, catalog.plans.basic.duration_options.short.service_term));
  assert.throws(() => termExpiry(253402300799, catalog.plans.basic.duration_options.short.service_term));
});

test('purchase snapshot enforces approved action and rejects forged SSM versions', () => {
  const value = validateCatalog(catalog, scope);
  value.plans.basic!.actions = ['upgrade'];
  assert.throws(() => purchaseSnapshot(value, 1, 'basic', 'short', 'fixture_v1'));
  purchaseSnapshot(value, 1, 'basic', 'short', 'fixture_v1', 'upgrade');
  assert.throws(() => purchaseSnapshot(value, 0, 'basic', 'short', 'fixture_v1', 'upgrade'));
});
