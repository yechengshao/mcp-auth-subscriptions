import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceLifecycle, type Observation } from '../../billing/lifecycle.js';
import { purchaseSnapshot } from '../../billing/contracts/validate.js';
import { validateCatalog } from '../../billing/contracts/validate.js';
import { catalog, scope, now } from '../fixtures/contracts.js';

const approved = validateCatalog(catalog, scope);
const plan = Object.keys(approved.plans)[0]!;
const duration = Object.keys(approved.plans[plan]!.duration_options)[0]!;
const snapshot = purchaseSnapshot(approved, 1, plan, duration, catalog.catalog_version);
const payment: Observation = { kind: 'payment', payment_id: 'pi_test', verified: true, owned: true,
  status: 'paid', paid_at: now, amount_minor: snapshot.amount_minor, currency: snapshot.currency,
  price_id: snapshot.price_id, mode: 'payment' };
test('verified one-time payment grants immutable term; duplicates do not extend it', () => {
  const first = reduceLifecycle(null, payment, snapshot, now);
  assert.equal(first.eligible, true); assert.equal(first.changed, true);
  assert.deepEqual(reduceLifecycle(first.term, payment, snapshot, now + 1).term, first.term);
  assert.equal(reduceLifecycle(first.term, payment, snapshot, now + 1).changed, false);
});
test('exclusive expiry routes manual renewal without automatic charge or recurring extension', () => {
  const term = reduceLifecycle(null, payment, snapshot, now).term!;
  for (const offset of [-1, 0, 1]) {
    const result = reduceLifecycle(term, { kind: 'recurring_event' }, snapshot, term.valid_until + offset);
    assert.equal(result.eligible, offset < 0); assert.equal(result.changed, false);
    assert.equal(result.next, offset < 0 ? 'access' : 'select_plan');
  }
  const renewed = reduceLifecycle(term, { ...payment, payment_id: 'pi_renew', paid_at: term.valid_until }, snapshot, term.valid_until);
  assert.equal(renewed.term!.starts_at, term.valid_until);
});
test('navigation, pending/failed payment and recurring events never grant access', () => {
  for (const observation of [{ kind: 'navigation' }, { kind: 'recurring_event' }, { ...payment, status: 'pending' }, { ...payment, status: 'failed' }] as Observation[]) {
    assert.equal(reduceLifecycle(null, observation, snapshot, now).eligible, false);
  }
});
test('invalid provider evidence fails closed and support cannot automatically refund', () => {
  for (const change of [{ owned: false }, { verified: false }, { mode: 'subscription' }, { amount_minor: 0 }, { paid_at: now * 1000 }, { price_id: 'wrong' }]) {
    assert.throws(() => reduceLifecycle(null, { ...payment, ...change }, snapshot, now));
  }
  const term = reduceLifecycle(null, payment, snapshot, now).term!;
  assert.equal(reduceLifecycle(term, { kind: 'support_request' }, snapshot, now).next, 'support_required');
  const revoked = reduceLifecycle(term, { kind: 'revoke', authorized: true }, snapshot, now);
  assert.equal(revoked.eligible, false);
  assert.equal(reduceLifecycle(revoked.term, payment, snapshot, now).eligible, false);
  assert.throws(() => reduceLifecycle(term, { ...payment, payment_id: 'pi_other' }, snapshot, now));
});
test('late verified payment uses its original time and never revives an expired term', () => {
  const first = reduceLifecycle(null, payment, snapshot, now);
  const late = reduceLifecycle(null, payment, snapshot, first.term!.valid_until + 1);
  assert.equal(late.changed, true); assert.equal(late.eligible, false);
  assert.equal(late.term!.starts_at, now); assert.equal(late.next, 'select_plan');
});
test('pending renewal preserves an existing paid interval without extending it', () => {
  const term = reduceLifecycle(null, payment, snapshot, now).term!;
  for (const status of ['pending', 'failed'] as const) {
    const result = reduceLifecycle(term, { ...payment, status }, snapshot, now + 1);
    assert.deepEqual(result.term, term); assert.equal(result.eligible, true);
    assert.equal(result.changed, false); assert.equal(result.next, 'access');
  }
  assert.throws(() => reduceLifecycle({ ...term, valid_until: term.valid_until + 1 }, { kind: 'navigation' }, snapshot, now));
  assert.throws(() => reduceLifecycle(term, { kind: 'revoke', authorized: false }, snapshot, now));
});
