import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response, RequestHandler } from 'express';
import { createManagementHandlers } from '../../access/http/management-handlers.js';
import { SessionFailure, type BrowserContext, type BrowserSessions } from '../../access/sessions.js';
import type { AccessConfiguration } from '../../access/config.js';
import type { Management } from '../../access/management.js';
import { Telemetry } from '../../observability/telemetry.js';

const config: AccessConfiguration = {
  environment: 'test', issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/test/mcp',
  clientConfigVersion: 'clients_v1', cookieName: '__Host-access',
  clients: [{ client_id: 'chatgpt_fixture', redirect_uris: ['https://chatgpt.example.invalid/callback'], scopes: ['openid', 'mcp:invoke'] }],
  cognito: { issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', domain: 'https://login.example.invalid',
    clientId: 'cognito_fixture', callbackUri: 'https://access.example.invalid/oauth/cognito/callback', scopes: ['openid', 'email'] },
};
const context: BrowserContext = { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', session: {
  PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', schema_version: 1, entity_type: 'session', revision: 1,
  environment: 'test', purpose: 'management', tx_id: 'management_tx', authentication_stage: 'identity_verified',
  identity: { issuer: config.cognito.issuer, subject: 'owner_fixture' }, subscriber_id: 'subscriber_fixture',
  csrf_digest: 'b'.repeat(64), created_at: 1800000000, expires_at: 1800001800, delete_after: 1800088200,
}, transaction: { PK: 'ENV#test#TX#management_tx', SK: 'STATE', schema_version: 1, entity_type: 'transaction', revision: 1,
  environment: 'test', purpose: 'management', phase: 'identity_verified', local_destination: '/billing',
  identity: { issuer: config.cognito.issuer, subject: 'owner_fixture' }, subscriber_id: 'subscriber_fixture',
  created_at: 1800000000, expires_at: 1800001800, delete_after: 1800088200 } };

function fixture() {
  const calls: Array<{ name: string; input?: unknown }> = [];
  const sessions = {
    async context() { return context; },
    csrf(_context: BrowserContext, origin: unknown, token: unknown) {
      if (origin !== 'https://access.example.invalid' || token !== 'csrf_fixture') throw new SessionFailure(403, 'forbidden');
    },
  } as unknown as BrowserSessions;
  const management = {
    async details() { calls.push({ name: 'details' }); return { plan_id: 'basic', valid_until: 1800100000, subscription_id: 'subscription_fixture' }; },
    async plans() { calls.push({ name: 'plans' }); return { catalog_version: 'catalog_fixture', plans: [
      { plan_id: 'premium', name: '<Premium>', description: 'Fixture', duration_options: [
        { duration_option_id: 'monthly', label: 'Monthly', amount_minor: 5000, currency: 'usd' },
      ] },
    ] }; },
    async manage(_context: BrowserContext, subscriptionId: string, action: unknown) {
      calls.push({ name: 'manage', input: { subscriptionId, action } });
      if ((action as { action: string }).action === 'quote_upgrade') return { kind: 'quote' as const, quote: {
        quote_id: 'quote_fixture', plan_id: 'premium', full_amount_minor: 5000, credit_minor: 1200,
        payable_minor: 3800, currency: 'usd',
      } };
      return { kind: 'redirect' as const, order_id: 'upgrade_order', url: 'https://checkout.stripe.com/c/pay/session_fixture' };
    },
    async status() { calls.push({ name: 'status' }); return { state: 'activation_ready' as const, plan_id: 'premium', valid_until: 1800200000 }; },
    async portal() { calls.push({ name: 'portal' }); return { kind: 'support' as const, email: 'support@example.invalid', code: 'financial_support_required' }; },
    async orderStatus(_context: BrowserContext, orderId: string) { calls.push({ name: 'order', input: orderId }); return { order_id: orderId, state: 'paid' as const }; },
  } as unknown as Management;
  const onboarding = {
    orderStatus: async (_request: Request, response: Response) => { response.json({ endpoint: 'onboarding_order' }); },
    billingReturn: async (_request: Request, response: Response) => { response.json({ endpoint: 'onboarding_return' }); },
  } as never;
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'management_http_fixture' }, { sink: () => undefined });
  return { handlers: createManagementHandlers(config, sessions, management, onboarding, telemetry), calls };
}

async function invoke(handler: RequestHandler, input: { method?: string; origin?: string; body?: unknown; params?: Record<string, string> } = {}) {
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
  const request = { headers: { cookie: 'session_fixture' }, body: input.body ?? {}, params: input.params ?? {},
    get(name: string) { return name.toLowerCase() === 'origin' ? input.origin : undefined; } } as unknown as Request;
  await handler(request, response, error => { if (error) throw error; });
  return result;
}

test('management upgrade forms use CSRF and return a server-priced quote before checkout', async () => {
  const value = fixture();
  const denied = await invoke(value.handlers.manageSubscription, { origin: 'https://evil.example.invalid', params: { subscriptionRef: 'subscription_fixture' },
    body: { csrf_token: 'csrf_fixture', action: 'quote_upgrade', plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_fixture' } });
  assert.equal(denied.status, 403);
  assert.deepEqual(value.calls, []);

  const quote = await invoke(value.handlers.manageSubscription, { origin: 'https://access.example.invalid', params: { subscriptionRef: 'subscription_fixture' },
    body: { csrf_token: 'csrf_fixture', action: 'quote_upgrade', plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_fixture' } });
  assert.equal(quote.status, 200);
  assert.match(String(quote.body), /38\.00/);
  assert.match(String(quote.body), /quote_fixture/);
  assert.deepEqual(value.calls.at(-1), { name: 'manage', input: { subscriptionId: 'subscription_fixture', action: {
    action: 'quote_upgrade', plan_id: 'premium', duration_option_id: 'monthly', catalog_version: 'catalog_fixture',
  } } });
});

test('upgrade confirmation redirects only to validated Stripe Checkout and management status is CSRF-protected', async () => {
  const value = fixture();
  const confirm = await invoke(value.handlers.manageSubscription, { origin: 'https://access.example.invalid', params: { subscriptionRef: 'subscription_fixture' },
    body: { csrf_token: 'csrf_fixture', action: 'confirm_upgrade', quote_id: 'quote_fixture' } });
  assert.equal(confirm.status, 303);
  assert.equal(confirm.location, 'https://checkout.stripe.com/c/pay/session_fixture');

  const denied = await invoke(value.handlers.managementStatus, { origin: 'https://evil.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(denied.status, 403);
  const accepted = await invoke(value.handlers.managementStatus, { origin: 'https://access.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { state: 'activation_ready', plan_id: 'premium', valid_until: 1800200000 });
});

test('management catalog HTML escapes plan labels and support actions do not open Stripe', async () => {
  const value = fixture();
  const page = await invoke(value.handlers.managementPage);
  assert.equal(page.status, 200);
  assert.match(String(page.body), /&lt;Premium&gt;/);
  assert.doesNotMatch(String(page.body), /<Premium>/);
  const support = await invoke(value.handlers.billingPortal, { origin: 'https://access.example.invalid', body: { csrf_token: 'csrf_fixture' } });
  assert.equal(support.status, 200);
  assert.match(String(support.body), /mailto:support@example.invalid/);
  assert.equal(value.calls.some(call => call.name === 'portal'), true);
});
