import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response, RequestHandler } from 'express';
import { createOnboardingHandlers } from '../../access/http/onboarding-handlers.js';
import type { AccessConfiguration } from '../../access/config.js';
import { SessionFailure, type BrowserContext, type BrowserSessions } from '../../access/sessions.js';
import type { Onboarding } from '../../access/onboarding.js';
import { Telemetry } from '../../observability/telemetry.js';

const config: AccessConfiguration = {
  environment: 'test', issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/test/mcp',
  clientConfigVersion: 'clients_v1', cookieName: '__Host-access',
  clients: [{ client_id: 'chatgpt_fixture', redirect_uris: ['https://chatgpt.example.invalid/callback'], scopes: ['openid', 'mcp:invoke'] }],
  cognito: { issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', domain: 'https://login.example.invalid',
    clientId: 'cognito_fixture', callbackUri: 'https://access.example.invalid/oauth/cognito/callback', scopes: ['openid', 'email'] },
};
const context: BrowserContext = { sessionDigest: 'a'.repeat(64), session: {
  PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', schema_version: 1, entity_type: 'session', revision: 1,
  environment: 'test', purpose: 'onboarding', tx_id: 'tx_fixture', grant_id: 'grant_fixture', authentication_stage: 'identity_verified',
  identity: { issuer: config.cognito.issuer, subject: 'owner_fixture' }, subscriber_id: 'subscriber_fixture',
  csrf_digest: 'b'.repeat(64), created_at: 1800000000, expires_at: 1800001800, delete_after: 1800088200,
}, transaction: { PK: 'ENV#test#TX#tx_fixture', SK: 'STATE', schema_version: 1, entity_type: 'transaction', revision: 1,
  environment: 'test', purpose: 'onboarding', phase: 'identity_verified', grant_id: 'grant_fixture', created_at: 1800000000,
  expires_at: 1800001800, delete_after: 1800088200 }, csrf: 'csrf_fixture' };

function fixture() {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const sessions = {
    async context() { return context; },
    csrf(_context: BrowserContext, origin: unknown, token: unknown) {
      if (origin !== 'https://access.example.invalid' || token !== 'csrf_fixture') throw new SessionFailure(403, 'forbidden');
    },
  } as unknown as BrowserSessions;
  const onboarding = {
    async page() { calls.push({ operation: 'page' }); return { kind: 'plans', offers: { catalog_version: 'catalog_fixture', plans: [
      { plan_id: 'basic', name: '<script>alert(1)</script>', description: 'Fixture offer', duration_options: [
        { duration_option_id: 'monthly', label: 'One month', amount_minor: 1200, currency: 'usd' },
      ] },
    ] } }; },
    async status() { calls.push({ operation: 'status' }); return { state: 'activation_ready' as const }; },
    async orderStatus(_context: BrowserContext, orderId: string) { calls.push({ operation: 'orderStatus', value: orderId });
      return { order_id: orderId, state: 'paid' as const }; },
    async checkout(_context: BrowserContext, value: unknown) { calls.push({ operation: 'checkout', value }); return { kind: 'redirect' as const, url: 'https://checkout.stripe.com/c/pay/session_fixture' }; },
    async resume() { calls.push({ operation: 'resume' }); return { location: 'https://chatgpt.example.invalid/callback?code=code_fixture&state=state_fixture' }; },
  } as unknown as Onboarding;
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'onboarding_http_fixture' }, { sink: () => undefined });
  return { handlers: createOnboardingHandlers(config, sessions, onboarding, telemetry), calls };
}

async function invoke(handler: RequestHandler, input: { method?: string; origin?: string; body?: unknown; query?: unknown;
  params?: Record<string, string> } = {}) {
  const result: { status: number; headers: Record<string, string>; body?: unknown; location?: string } = { status: 200, headers: {} };
  const response = {
    status(value: number) { result.status = value; return this; },
    set(name: string, value: string) { result.headers[name.toLowerCase()] = value; return this; },
    type(value: string) { result.headers['content-type'] = value; return this; },
    json(value: unknown) { result.body = value; return this; },
    send(value: unknown) { result.body = value; return this; },
    redirect(statusOrUrl: number | string, maybeUrl?: string) {
      if (typeof statusOrUrl === 'number') { result.status = statusOrUrl; if (maybeUrl !== undefined) result.location = maybeUrl; }
      else { result.status = 302; result.location = statusOrUrl; }
      return this;
    },
    clearCookie() { return this; },
  } as unknown as Response;
  const request = { headers: { cookie: 'session_fixture' }, body: input.body ?? {}, query: input.query ?? {}, params: input.params ?? {},
    get(name: string) { return name.toLowerCase() === 'origin' ? input.origin : undefined; } } as unknown as Request;
  await handler(request, response, error => { if (error) throw error; });
  return result;
}

test('onboarding HTML escapes catalog text and only sends the selected plan IDs back to the service', async () => {
  const value = fixture(), result: { status: number; type?: string; body?: string } = { status: 200 };
  const response = { status(code: number) { result.status = code; return this; }, type(type: string) { result.type = type; return this; },
    send(body: string) { result.body = body; return this; } } as unknown as Response;
  await value.handlers.onboarding(context, {} as Request, response);
  assert.equal(result.status, 200);
  assert.match(result.body!, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(result.body!, /<script>alert\(1\)<\/script>/);
  assert.match(result.body!, /name="plan_id" value="basic"/);
  assert.match(result.body!, /name="catalog_version" value="catalog_fixture"/);
  assert.match(result.body!, /name="duration_option_id" value="monthly"/);
});

test('plans endpoint returns only the approved public catalog under the verified onboarding session', async () => {
  const value = fixture();
  const result = await invoke(value.handlers.plans);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { catalog_version: 'catalog_fixture', plans: [
    { plan_id: 'basic', name: '<script>alert(1)</script>', description: 'Fixture offer', duration_options: [
      { duration_option_id: 'monthly', label: 'One month', amount_minor: 1200, currency: 'usd' },
    ] },
  ] });
});

test('checkout requires exact same-origin CSRF and redirects only after the trusted service returns a Checkout URL', async () => {
  const value = fixture();
  const denied = await invoke(value.handlers.checkout, { origin: 'https://evil.example.invalid', body: {
    csrf_token: 'csrf_fixture', plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture',
  } });
  assert.equal(denied.status, 403);
  assert.equal(value.calls.length, 0);

  const accepted = await invoke(value.handlers.checkout, { origin: 'https://access.example.invalid', body: {
    csrf_token: 'csrf_fixture', plan_id: 'basic', duration_option_id: 'monthly', catalog_version: 'catalog_fixture',
  } });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.location, 'https://checkout.stripe.com/c/pay/session_fixture');
  assert.deepEqual(value.calls.at(-1), { operation: 'checkout', value: {
    planId: 'basic', durationOptionId: 'monthly', catalogVersion: 'catalog_fixture',
  } });
});

test('browser return ignores Stripe query claims and status is a CSRF-protected bounded activation POST', async () => {
  const value = fixture();
  const returned = await invoke(value.handlers.billingReturn, { query: { session_id: 'cs_secret_fixture', payment_status: 'paid' } });
  assert.equal(returned.status, 200);
  assert.match(String(returned.body), /Payment or access activation is still processing/);
  assert.match(String(returned.body), /method:'POST'/);
  assert.match(String(returned.body), /attempts>=12/);
  assert.match(String(returned.body), /Math\.min\(2000\*Math\.pow/);
  assert.match(String(returned.body), /name="csrf_token" value="csrf_fixture"/);
  assert.doesNotMatch(String(returned.body), /cs_secret_fixture|payment_status/);
  assert.match(returned.headers['content-security-policy']!, /script-src 'nonce-/);
  assert.deepEqual(value.calls, []);

  const denied = await invoke(value.handlers.status, { method: 'POST', origin: 'https://evil.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(denied.status, 403);
  assert.deepEqual(value.calls, []);

  const missing = await invoke(value.handlers.status, { method: 'POST', origin: 'https://access.example.invalid', body: {} });
  assert.equal(missing.status, 400);
  assert.deepEqual(value.calls, []);

  const status = await invoke(value.handlers.status, { method: 'POST', origin: 'https://access.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { state: 'activation_ready' });
  assert.deepEqual(value.calls, [{ operation: 'status' }]);
});

test('order status is a read-only own-session GET and returns only sanitized state', async () => {
  const value = fixture();
  const result = await invoke(value.handlers.orderStatus, { params: { orderId: 'order_fixture' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { order_id: 'order_fixture', state: 'paid' });
  assert.deepEqual(value.calls, [{ operation: 'orderStatus', value: 'order_fixture' }]);
});

test('resume requires CSRF before it emits a redirect to the original OAuth callback', async () => {
  const value = fixture();
  const denied = await invoke(value.handlers.resume, { method: 'POST', origin: 'https://evil.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(denied.status, 403);
  assert.equal(value.calls.length, 0);
  const accepted = await invoke(value.handlers.resume, { method: 'POST', origin: 'https://access.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.location, 'https://chatgpt.example.invalid/callback?code=code_fixture&state=state_fixture');
});
