import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingDispatcher, type BillingRequest } from '../../billing/dispatcher.js';
import { Telemetry } from '../../billing/observability.js';
import { validateCatalog } from '../../billing/contracts/validate.js';
import { catalog, scope, operation, entitlement, now } from '../fixtures/contracts.js';

function setup(owned = true, allowed = true) {
  const logs: string[] = []; let calls = 0;
  const telemetry = new Telemetry({ service: 'billing', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) });
  const handler = createBillingDispatcher('test', 'support@example.invalid', {
    catalog: async () => validateCatalog(catalog, scope),
    entitlement: async () => ({ ...entitlement, allowed }),
    owns: async () => owned,
    operations: { manageSubscription: async () => { calls++; throw new Error('SECRET_PROVIDER_SENTINEL'); } },
    now: () => now,
  }, telemetry);
  return { handler, logs, calls: () => calls };
}
const request = (operationName: string, input: Record<string, unknown>): BillingRequest => ({ ...operation, schema_version: 1,
  operation: operationName, input, continuation_ref: 'tx_fixture' });
test('native dispatcher lists only public approved catalog fields', async () => {
  const { handler } = setup();
  const result = await handler(request('listPlans', {}), {});
  assert.equal((result as { outcome: string }).outcome, 'ok');
  assert.equal(JSON.stringify(result).includes('price_fixture'), false);
  assert.equal(JSON.stringify(result).includes('fixture_usage'), false);
});
test('management checks ownership and paid eligibility before effects', async () => {
  const req = request('manageSubscription', { subscription_id: 'sub_fixture', action: 'upgrade' });
  for (const [owned, allowed, expected] of [[false, true, 'not_owner'], [true, false, 'not_eligible']] as const) {
    const app = setup(owned, allowed);
    assert.equal((await app.handler(req, {}) as { error_code: string }).error_code, expected);
    assert.equal(app.calls(), 0);
  }
});
test('refund requests route to support without financial effects', async () => {
  const app = setup();
  const response = await app.handler(request('manageSubscription', { subscription_id: 'sub_fixture', action: 'refund' }), {});
  assert.equal((response as { outcome: string }).outcome, 'support_required'); assert.equal(app.calls(), 0);
});
test('missing continuation and ambiguous HTTP/native envelopes cannot execute effects', async () => {
  const app = setup(); const req = request('listPlans', {}); delete req.continuation_ref;
  assert.equal((await app.handler(req, {}) as { outcome: string }).outcome, 'invalid_request');
  const ambiguous = { ...request('listPlans', {}), headers: { authorization: 'SECRET_SENTINEL' } };
  assert.equal((await app.handler(ambiguous, {}) as { outcome: string }).outcome, 'retryable_unavailable');
  assert.equal(app.calls(), 0); assert.equal(app.logs.join('').includes('SECRET_SENTINEL'), false);
});
test('unexpected adapter failures are logged safely and returned as retryable', async () => {
  const app = setup();
  const result = await app.handler(request('manageSubscription', { subscription_id: 'sub_fixture', action: 'upgrade' }), {});
  assert.equal((result as { outcome: string }).outcome, 'retryable_unavailable');
  assert.equal(app.logs.join('').includes('SECRET_PROVIDER_SENTINEL'), false);
  assert.equal(app.logs.join('').includes('corr_fixture'), true);
});
