import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingAliasResolver } from '../../access/billing-alias.js';

const name = '/mcp/test/billing/alias-arn';

const alias = 'arn:aws:lambda:ca-central-1:503098479806:function:mcp-billing-test:live';

function fakeClient(value: string | undefined, calls: { count: number }) {
  return { send: async () => { calls.count += 1; return value === undefined ? {} : { Parameter: { Value: value } }; } } as any;
}

test('resolver rejects parameter names outside the shared convention before any read', () => {
  for (const bad of [undefined, '/mcp/staging/billing/alias-arn', '/mcp/test/billing/other', 'billing/alias-arn']) {
    assert.throws(() => createBillingAliasResolver(bad, '503098479806', fakeClient(alias, { count: 0 })), /invalid_billing_alias_parameter/);
  }
});

test('resolver returns the published live alias and caches it until expiry', async () => {
  const calls = { count: 0 };
  let clock = 0;
  const resolve = createBillingAliasResolver(name, '503098479806', fakeClient(alias, calls), () => clock);
  assert.equal(await resolve(), alias);
  assert.equal(await resolve(), alias);
  assert.equal(calls.count, 1);
  clock = 300_001;
  assert.equal(await resolve(), alias);
  assert.equal(calls.count, 2);
});

test('resolver fails closed on missing, foreign-account, unaliased or malformed values', async () => {
  for (const value of [undefined, '', 'arn:aws:lambda:ca-central-1:111111111111:function:mcp-billing-test:live',
    'arn:aws:lambda:ca-central-1:503098479806:function:mcp-billing-test', 'not-an-arn']) {
    const resolve = createBillingAliasResolver(name, '503098479806', fakeClient(value, { count: 0 }));
    await assert.rejects(resolve(), /invalid_billing_alias_parameter/);
  }
});
