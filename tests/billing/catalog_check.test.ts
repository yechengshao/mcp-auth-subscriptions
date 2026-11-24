import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkCatalog } from '../../scripts/check_catalog.js';
import { catalog as fixtureCatalog } from '../fixtures/contracts.js';

const scope = { environment: 'test', aws_account_id: '503098479806', region: 'ca-central-1', stripe_account: 'acct_1Qa7Vb2Ck9Lm4Xw3' };
const sellable = () => ({
  schema_version: 1, catalog_version: 'catalog_2026_11_24', ...scope,
  plans: { basic: {
    tier_order: 1, display: { name: 'Basic', description: 'Starter access' }, enabled_for_purchase: true,
    actions: ['purchase', 'renewal'], usage_mapping: { usage_plan_id: 'ujk8d2', rest_api_id: 'a1b2c3d4e5', stage: 'test' },
    duration_options: { monthly: {
      enabled_for_purchase: true, service_term: { unit: 'month', count: 1, time_semantics: 'utc_calendar_clamp' },
      amount_minor: 1200, currency: 'cad', product_id: 'prod_1Qa7Vb2Ck9Lm4Xw3', price_id: 'price_1Qa7Vb2Ck9Lm4Xw3',
      mode: 'payment', label: 'One month',
    } },
  } },
});

test('the committed draft catalog cannot be sold and reports each kind of placeholder', () => {
  const draft = JSON.parse(readFileSync('infra/billing/catalog.draft.json', 'utf8'));
  const result = checkCatalog(draft, { environment: 'test', aws_account_id: '000000000000', region: 'ca-central-1', stripe_account: 'acct_REPLACE_ME' });
  assert.equal(result.ok, false);
  for (const code of ['no_enabled_plan', 'placeholder_stripe_reference', 'placeholder_usage_mapping', 'placeholder_stripe_account', 'placeholder_catalog_version']) {
    assert.ok(result.codes.includes(code), `missing ${code}`);
  }
});

test('a catalog with real-looking references for its exact scope is sellable', () => {
  assert.deepEqual(checkCatalog(sellable(), scope), { ok: true, codes: [] });
});

test('the shared test fixture catalog is refused because its references are fixtures', () => {
  const result = checkCatalog(fixtureCatalog, { environment: 'test', aws_account_id: '000000000000', region: 'us-east-1', stripe_account: 'acct_fixture' });
  assert.equal(result.ok, false);
  assert.ok(result.codes.includes('placeholder_stripe_reference'));
});

test('a catalog for another account, region or environment is refused before any offer check', () => {
  const result = checkCatalog(sellable(), { ...scope, region: 'us-east-1' });
  assert.equal(result.ok, false);
  assert.equal(result.codes.length, 1);
});

test('a placeholder in a disabled entry still fails, so a draft cannot pass by being switched off', () => {
  const input = sellable() as any;
  input.plans.basic.enabled_for_purchase = false;
  input.plans.basic.usage_mapping.usage_plan_id = 'REPLACE_USAGE_PLAN_ID';
  const result = checkCatalog(input, scope);
  assert.equal(result.ok, false);
  assert.ok(result.codes.includes('placeholder_usage_mapping'));
});
