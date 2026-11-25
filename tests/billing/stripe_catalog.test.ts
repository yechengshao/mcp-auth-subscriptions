import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeCatalogRelease } from '../../billing/adapters/stripe-catalog.js';
import { purchaseSnapshot } from '../../billing/contracts/validate.js';

const scope = { environment: 'test', aws_account_id: '503098479806', region: 'ca-central-1', stripe_account: 'acct_fixture' };
const product = (overrides: Record<string, any> = {}, meta: Record<string, string> = {}) => ({
  id: 'prod_basic', object: 'product', active: true, livemode: false, name: 'Basic', description: 'Basic access', created: 1000,
  metadata: { plan_id: 'basic', tier_order: '1', enabled_for_purchase: 'true', actions: 'purchase,renewal', environment: 'test', ...meta }, ...overrides,
});
const price = (overrides: Record<string, any> = {}, meta: Record<string, string> = {}) => ({
  id: 'price_basic_m1', object: 'price', type: 'one_time', active: true, livemode: false, product: 'prod_basic', unit_amount: 1000,
  currency: 'cad', recurring: null, created: 1001,
  metadata: { plan_id: 'basic', duration_option_id: 'm1', enabled_for_purchase: 'true', term_unit: 'month', term_count: '1',
    term_semantics: 'utc_calendar_clamp', label: '1 month', usage_plan_id: 'up_basic', rest_api_id: 'rest_test1', stage: 'test', environment: 'test', ...meta },
  ...overrides,
});

test('Stripe objects become a catalog whose price snapshot resolves to the exact price and usage plan', () => {
  const release = stripeCatalogRelease({ products: [product()], prices: [price()] }, scope, false);
  assert.equal(release.excluded, 0);
  const plan = release.value.plans.basic!;
  assert.deepEqual(plan.usage_mapping, { usage_plan_id: 'up_basic', rest_api_id: 'rest_test1', stage: 'test' });
  assert.equal(plan.duration_options.m1!.price_id, 'price_basic_m1');
  assert.equal(plan.duration_options.m1!.product_id, 'prod_basic');
  const snapshot = purchaseSnapshot(release.value, release.version, 'basic', 'm1', release.value.catalog_version);
  assert.equal(snapshot.price_id, 'price_basic_m1');
  assert.equal(snapshot.amount_minor, 1000);
  assert.deepEqual(snapshot.usage_mapping, plan.usage_mapping);
});

test('the catalog version changes with any metadata or price change, so an older quote cannot be redeemed', () => {
  const before = stripeCatalogRelease({ products: [product()], prices: [price()] }, scope, false).value.catalog_version;
  const again = stripeCatalogRelease({ products: [product()], prices: [price()] }, scope, false).value.catalog_version;
  const moved = stripeCatalogRelease({ products: [product()], prices: [price({}, { stage: 'prod' })] }, scope, false);
  assert.equal(again, before);
  assert.notEqual(moved.value.catalog_version, before);
  assert.throws(() => purchaseSnapshot(moved.value, moved.version, 'basic', 'm1', before), /catalog_changed/);
});

test('incomplete, mixed-mode, other-environment and inconsistent entries are excluded, never sold', () => {
  const release = stripeCatalogRelease({
    products: [product(), product({ id: 'prod_live', livemode: true }, { plan_id: 'live_only' }), product({ id: 'prod_other' }, { plan_id: 'other', environment: 'production' })],
    prices: [
      price(),
      price({ id: 'price_live', livemode: true, product: 'prod_basic' }, { duration_option_id: 'm2' }),
      price({ id: 'price_inactive', active: false, product: 'prod_basic' }, { duration_option_id: 'm3' }),
      price({ id: 'price_dup', product: 'prod_basic' }, { duration_option_id: 'm1' }),
      price({ id: 'price_m6', product: 'prod_basic' }, { duration_option_id: 'm6' }),
      price({ id: 'price_badterm', product: 'prod_basic' }, { duration_option_id: 'm5', term_count: '999' }),
    ],
  }, scope, false);
  assert.deepEqual(Object.keys(release.value.plans), ['basic']);
  assert.deepEqual(Object.keys(release.value.plans.basic!.duration_options), ['m6']);
  assert.equal(release.value.plans.basic!.usage_mapping.stage, 'test');
  assert.equal(release.excluded, 5);
});

test('a plan whose prices disagree on usage mapping is removed; other plans still list', () => {
  const release = stripeCatalogRelease({ products: [product(), product({ id: 'prod_pro' }, { plan_id: 'pro', tier_order: '2' })], prices: [
    price(), price({ id: 'price_b' }, { duration_option_id: 'm2', usage_plan_id: 'up_other' }),
    price({ id: 'price_pro', product: 'prod_pro' }, { plan_id: 'pro', duration_option_id: 'm1' }),
  ] }, scope, false);
  assert.equal(release.value.plans.basic, undefined);
  assert.deepEqual(Object.keys(release.value.plans), ['pro']);
});

test('a release with no sellable plan is refused rather than published as an empty catalog', () => {
  assert.throws(() => stripeCatalogRelease({ products: [product()], prices: [price({ active: false })] }, scope, false));
});

test('duplicate tier order among valid plans fails the whole release', () => {
  assert.throws(() => stripeCatalogRelease({ products: [product(), product({ id: 'prod_pro' }, { plan_id: 'pro' })],
    prices: [price(), price({ id: 'price_pro', product: 'prod_pro' }, { plan_id: 'pro' })] }, scope, false), /duplicate_tier_order/);
});
