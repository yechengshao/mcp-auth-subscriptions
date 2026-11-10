import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessRow } from '../../access/model.js';
import { composeAccessHandler } from '../../access/handler.js';
import { BrowserSessions } from '../../access/sessions.js';
import type { BrowserSessionStore, IdentityProvider, PendingLogin, VerifiedLogin } from '../../access/ports.js';
import { Telemetry } from '../../observability/telemetry.js';
import type { HttpResult } from '../../observability/adapters.js';
import { identityFixture } from './support/identity_fixture.js';
import type { OAuthExtension } from '../../access/http/types.js';

const now = 1_800_000_000;
const config = {
  environment: 'test', issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/test/mcp',
  clientConfigVersion: 'clients_v1', cookieName: '__Host-access',
  clients: [{ client_id: 'chatgpt_fixture', redirect_uris: ['https://chatgpt.example.invalid/callback'], scopes: ['openid', 'mcp:invoke'] }],
  cognito: { issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', domain: 'https://login.example.invalid',
    clientId: 'cognito_fixture', callbackUri: 'https://access.example.invalid/oauth/cognito/callback', scopes: ['openid', 'email'] },
};
const key = (PK: string, SK: string) => `${PK}\0${SK}`;

class MemorySessions implements BrowserSessionStore {
  readonly environment = 'test';
  readonly rows = new Map<string, AccessRow>();
  readonly subscribers = new Map<string, string>();
  readonly paid = new Map<string, AccessRow>();
  async createLogin(input: PendingLogin) {
    const base = (PK: string, SK: string, entity_type: string) => ({ PK, SK, entity_type, schema_version: 1, revision: 1, environment: this.environment });
    const session = { ...base(`ENV#test#SESSION#${input.sessionDigest}`, 'SESSION', 'session'), purpose: input.purpose,
      tx_id: input.transactionId, authentication_stage: 'pending_identity', csrf_digest: input.csrfDigest,
      created_at: input.createdAt, expires_at: input.expiresAt, delete_after: input.deleteAfter };
    const transaction = { ...base(`ENV#test#TX#${input.transactionId}`, 'STATE', 'transaction'), purpose: input.purpose,
      phase: 'pending_identity', correlation_id: input.correlationId, created_at: input.createdAt,
      expires_at: input.expiresAt, delete_after: input.deleteAfter,
      ...(input.grantId ? { grant_id: input.grantId } : {}),
      ...(input.downstream ? { downstream: input.downstream } : { local_destination: '/billing' }) };
    const attempt = { ...base(`ENV#test#UPSTREAM#${input.stateDigest}`, 'ATTEMPT', 'upstream_attempt'), tx_id: input.transactionId,
      session_digest: input.sessionDigest, nonce_digest: input.nonceDigest, pkce_verifier: input.pkceVerifier,
      cognito_client_id: input.cognitoClientId, cognito_issuer: input.cognitoIssuer, callback_uri: input.callbackUri,
      created_at: input.createdAt, expires_at: input.expiresAt, delete_after: input.deleteAfter, consumed: false };
    for (const row of [session, transaction, attempt]) this.rows.set(key(row.PK, row.SK), row);
  }
  async loadContext(sessionDigest: string) {
    const session = this.rows.get(key(`ENV#test#SESSION#${sessionDigest}`, 'SESSION'));
    if (!session) return undefined;
    const transaction = this.rows.get(key(`ENV#test#TX#${session.tx_id}`, 'STATE'));
    return transaction ? { session, transaction } : undefined;
  }
  async loadUpstreamAttempt(stateDigest: string) { return this.rows.get(key(`ENV#test#UPSTREAM#${stateDigest}`, 'ATTEMPT')); }
  async cancelLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow }) {
    const { pkce_verifier: _verifier, ...attempt } = input.attempt;
    this.rows.set(key(attempt.PK, attempt.SK), { ...attempt, consumed: true, revision: attempt.revision + 1 });
    this.rows.set(key(input.session.PK, input.session.SK), { ...input.session, revoked: true, revision: input.session.revision + 1 });
    this.rows.set(key(input.transaction.PK, input.transaction.SK), { ...input.transaction, phase: 'cancelled', revision: input.transaction.revision + 1 });
  }
  async completeLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow; verified: VerifiedLogin }) {
    const { pkce_verifier: _verifier, ...attempt } = input.attempt;
    const old = input.session;
    const session: AccessRow = { PK: `ENV#test#SESSION#${input.verified.newSessionDigest}`, SK: 'SESSION', entity_type: 'session',
      schema_version: 1, revision: 1, environment: this.environment, purpose: old.purpose, tx_id: old.tx_id,
      authentication_stage: 'identity_verified', identity: input.verified.identity, subscriber_id: input.verified.subscriberId,
      ...(input.verified.grantId ? { grant_id: input.verified.grantId } : {}),
      csrf_digest: input.verified.csrfDigest, created_at: old.created_at, expires_at: old.expires_at, delete_after: old.delete_after };
    this.rows.set(key(attempt.PK, attempt.SK), { ...attempt, consumed: true, revision: attempt.revision + 1 });
    this.rows.set(key(old.PK, old.SK), { ...old, revoked: true, revision: old.revision + 1 });
    this.rows.set(key(session.PK, session.SK), session);
    this.rows.set(key(input.transaction.PK, input.transaction.SK), { ...input.transaction, phase: 'identity_verified',
      identity: input.verified.identity, subscriber_id: input.verified.subscriberId, revision: input.transaction.revision + 1 });
  }
  async ensureSubscriber(identity: { issuer: string; subject: string }) {
    const owner = `${identity.issuer}\0${identity.subject}`;
    const current = this.subscribers.get(owner);
    if (current) return current;
    const created = `subscriber_${this.subscribers.size + 1}`;
    this.subscribers.set(owner, created);
    return created;
  }
  async entitlement(identity: { issuer: string; subject: string }) { return this.paid.get(`${identity.issuer}\0${identity.subject}`); }
  async grantFamily(_grantId: string) { return undefined; }
  async logout(session: AccessRow, _family: AccessRow | undefined, _revokedAt: number) {
    this.rows.set(key(session.PK, session.SK), { ...session, revoked: true, revision: session.revision + 1 });
  }
  setPaid(identity: { issuer: string; subject: string }, validUntil: number) {
    this.paid.set(`${identity.issuer}\0${identity.subject}`, { allowed: true, valid_until: validUntil, plan_id: 'basic' });
  }
}

async function fixture(extension?: OAuthExtension, accessConfig = config) {
  const publicIdentity = await identityFixture();
  const store = new MemorySessions();
  const exchanges: Array<{ code: string; verifier: string; nonceDigest: string }> = [];
  const telemetryLines: string[] = [];
  const cognito: IdentityProvider = {
    authorize(state, nonce, challenge) {
      const url = new URL('/oauth2/authorize', accessConfig.cognito.domain);
      url.search = new URLSearchParams({ state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.toString();
    },
    async exchange(code, verifier, nonceDigest) {
      exchanges.push({ code, verifier, nonceDigest });
      return { issuer: accessConfig.cognito.issuer, subject: 'cognito_subject_fixture' };
    },
  };
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'oauth-fixture' }, {
    sink: line => telemetryLines.push(line), now: () => now * 1000,
  });
  const sessions = new BrowserSessions(accessConfig, store, cognito, telemetry, () => now);
  const handler = await composeAccessHandler(accessConfig, sessions, publicIdentity.jwks, telemetry, extension);
  return { handler, store, exchanges, publicIdentity, telemetryLines };
}

async function invoke(handler: Awaited<ReturnType<typeof composeAccessHandler>>, method: string, target: string,
  options: { headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
  const url = new URL(target, 'https://access.example.invalid');
  const multiValueQueryStringParameters = Object.fromEntries([...url.searchParams].map(([name, value]) => [name, [value]]));
  return handler({ httpMethod: method, path: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams),
    multiValueQueryStringParameters, headers: options.headers ?? {}, body: options.body ?? null,
    isBase64Encoded: false, requestContext: { requestId: 'gateway_request_fixture', stage: 'test',
      identity: { sourceIp: '192.0.2.1', userAgent: 'oauth-fixture' } } }, { awsRequestId: `lambda_${method.toLowerCase()}` });
}

function responseHeader(response: HttpResult, name: string): string | undefined {
  const multi = Object.entries(response.multiValueHeaders ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (multi?.length === 1) return multi[0];
  return Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
function setCookies(response: HttpResult): string[] {
  const multi = Object.entries(response.multiValueHeaders ?? {}).find(([key]) => key.toLowerCase() === 'set-cookie')?.[1];
  if (multi?.length) return multi;
  const single = responseHeader(response, 'set-cookie');
  return single ? [single] : [];
}
function cookieHeader(response: HttpResult): string {
  return setCookies(response).map(value => value.split(';', 1)[0]).join('; ');
}
function cookieValue(header: string, name: string): string {
  const pair = header.split('; ').find(value => value.startsWith(`${name}=`));
  assert.ok(pair, `missing ${name} cookie`);
  return pair.slice(name.length + 1);
}
const onboardingQuery = new URLSearchParams({ response_type: 'code', client_id: 'chatgpt_fixture',
  redirect_uri: config.clients[0]!.redirect_uris[0]!, resource: config.resource, scope: 'openid mcp:invoke',
  state: 'chatgpt_state_123', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });

test('OAuth onboarding validates registered parameters, binds Cognito state to the browser, and rotates the session', async () => {
  const value = await fixture();
  {
    const invalid = await invoke(value.handler, 'GET', `/authorize?${new URLSearchParams({ ...Object.fromEntries(onboardingQuery), client_id: 'unregistered' })}`);
    assert.equal(invalid.statusCode, 400);
    assert.equal(responseHeader(invalid, 'location'), undefined);
    assert.equal(value.exchanges.length, 0);
    value.telemetryLines.length = 0;

    const started = await invoke(value.handler, 'GET', `/authorize?${onboardingQuery}`, { headers: {
      'x-correlation-id': 'oauth_flow_corr_123',
    } });
    assert.equal(started.statusCode, 302, started.body);
    assert.equal(responseHeader(started, 'x-correlation-id'), 'oauth_flow_corr_123');
    const location = new URL(responseHeader(started, 'location')!);
    assert.equal(location.origin, config.cognito.domain);
    assert.equal(location.pathname, '/oauth2/authorize');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.match(location.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(location.searchParams.get('nonce'));
    assert.notEqual(location.searchParams.get('state'), onboardingQuery.get('state'));

    const oldCookies = cookieHeader(started);
    const oldSession = cookieValue(oldCookies, config.cookieName);
    const oldCsrf = cookieValue(oldCookies, `${config.cookieName}-csrf`);
    const startCookies = setCookies(started);
    assert.equal(startCookies.length, 2);
    for (const cookie of startCookies) {
      assert.match(cookie, /; Path=\//i);
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; SameSite=Lax/i);
      assert.doesNotMatch(cookie, /; Domain=/i);
    }

    const callback = await invoke(value.handler, 'GET', `/oauth/cognito/callback?${new URLSearchParams({
      state: location.searchParams.get('state')!, code: 'cognito_code_fixture', iss: config.cognito.issuer,
    })}`, { headers: { cookie: oldCookies, 'x-correlation-id': 'callback_corr_456',
      'x-amzn-trace-id': 'Root=1-abcdef12-0123456789abcdef01234567;Parent=0123456789abcdef;Sampled=1' } });
    assert.equal(callback.statusCode, 303);
    assert.equal(responseHeader(callback, 'location'), `${config.issuer}/onboarding`);
    assert.equal(value.exchanges.length, 1);
    assert.equal(value.exchanges[0]!.code, 'cognito_code_fixture');
    assert.match(value.exchanges[0]!.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.match(value.exchanges[0]!.nonceDigest, /^[a-f0-9]{64}$/);
    const tracking = value.telemetryLines.map(line => JSON.parse(line) as Record<string, unknown>);
    assert.ok(tracking.some(row => row.operation === 'http.callback' && row.outcome === 'identity_verified' &&
      row.correlation_id === 'oauth_flow_corr_123' && row.trace_id === '1-abcdef12-0123456789abcdef01234567' &&
      row.trace_parent_id === '0123456789abcdef'), JSON.stringify(tracking));
    assert.equal(value.telemetryLines.join('').includes('chatgpt_state_123'), false);
    assert.equal(value.telemetryLines.join('').includes('cognito_code_fixture'), false);
    assert.equal(value.telemetryLines.join('').includes('A'.repeat(43)), false);

    const rotatedCookies = cookieHeader(callback);
    assert.notEqual(cookieValue(rotatedCookies, config.cookieName), oldSession);
    assert.notEqual(cookieValue(rotatedCookies, `${config.cookieName}-csrf`), oldCsrf);
    const replay = await invoke(value.handler, 'GET', `/oauth/cognito/callback?${new URLSearchParams({
      state: location.searchParams.get('state')!, code: 'replayed_code',
    })}`, { headers: { cookie: oldCookies } });
    assert.equal(replay.statusCode, 401);
    assert.equal(value.exchanges.length, 1);
  }
});

test('OAuth callback cannot use another browser session state and discovery stays unavailable until token handlers exist', async () => {
  const value = await fixture();
  {
    const start = async () => {
      const response = await invoke(value.handler, 'GET', `/authorize?${onboardingQuery}`);
      return { cookies: cookieHeader(response), location: new URL(responseHeader(response, 'location')!) };
    };
    const first = await start(), second = await start();
    const mismatch = await invoke(value.handler, 'GET', `/oauth/cognito/callback?${new URLSearchParams({
      state: first.location.searchParams.get('state')!, code: 'cross_session_code',
    })}`, { headers: { cookie: second.cookies } });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(value.exchanges.length, 0);

    const authorizationMetadata = await invoke(value.handler, 'GET', '/.well-known/oauth-authorization-server');
    assert.equal(authorizationMetadata.statusCode, 503);
    assert.deepEqual(JSON.parse(authorizationMetadata.body!), { error: 'authorization_not_ready' });
    const resourceMetadata = await invoke(value.handler, 'GET', '/.well-known/oauth-protected-resource');
    assert.equal(resourceMetadata.statusCode, 503);
    const jwks = await invoke(value.handler, 'GET', '/jwks.json');
    assert.equal(jwks.statusCode, 200);
    assert.deepEqual(JSON.parse(jwks.body!), value.publicIdentity.jwks);
  }
});

test('well-known aliases resolve only for the configured stage issuer and exact MCP resource path', async () => {
  const stageConfig = {
    ...config,
    issuer: 'https://access.example.invalid/test',
    resource: 'https://api.example.invalid/test/mcp',
    cognito: { ...config.cognito, callbackUri: 'https://access.example.invalid/test/oauth/cognito/callback' },
  };
  const noop: import('express').RequestHandler = (_request, response) => { response.status(204).end(); };
  const extension: OAuthExtension = {
    token: noop, revoke: noop, resume: noop, checkout: noop, status: noop, orderStatus: noop, billingReturn: noop,
    plans: noop, managementPage: noop, manageSubscription: noop, managementStatus: noop, billingPortal: noop,
    onboarding: async (_context, _request, response) => { response.status(204).end(); },
  };
  const value = await fixture(extension, stageConfig);
  const authorizationMetadata = await invoke(value.handler, 'GET', '/.well-known/oauth-authorization-server/test');
  const oidcMetadata = await invoke(value.handler, 'GET', '/.well-known/openid-configuration/test');
  const resourceMetadata = await invoke(value.handler, 'GET', '/.well-known/oauth-protected-resource/test/mcp');
  const wrongIssuer = await invoke(value.handler, 'GET', '/.well-known/openid-configuration/other');
  const wrongResource = await invoke(value.handler, 'GET', '/.well-known/oauth-protected-resource/test/other');
  assert.equal(authorizationMetadata.statusCode, 200);
  assert.deepEqual(JSON.parse(authorizationMetadata.body!), JSON.parse(oidcMetadata.body!));
  assert.equal(JSON.parse(authorizationMetadata.body!).issuer, stageConfig.issuer);
  assert.equal(JSON.parse(authorizationMetadata.body!).authorization_endpoint, `${stageConfig.issuer}/authorize`);
  assert.equal(resourceMetadata.statusCode, 200);
  assert.deepEqual(JSON.parse(resourceMetadata.body!), {
    resource: stageConfig.resource, authorization_servers: [stageConfig.issuer], scopes_supported: ['openid', 'mcp:invoke'],
  });
  assert.equal(wrongIssuer.statusCode, 404);
  assert.equal(wrongResource.statusCode, 404);
});

test('composed access app wires onboarding status, Checkout, browser return and resume adapters', async () => {
  const seen: string[] = [];
  const endpoint = (name: string) => async (_request: import('express').Request, response: import('express').Response) => {
    seen.push(name); response.json({ endpoint: name });
  };
  const requestHandler = (name: string) => endpoint(name) as import('express').RequestHandler;
  const extension: OAuthExtension = {
    token: requestHandler('token'), revoke: requestHandler('revoke'), resume: requestHandler('resume'),
    checkout: requestHandler('checkout'), status: requestHandler('status'), orderStatus: requestHandler('orderStatus'),
    billingReturn: requestHandler('billingReturn'),
    plans: requestHandler('plans'),
    managementPage: requestHandler('managementPage'), manageSubscription: requestHandler('manageSubscription'),
    managementStatus: requestHandler('managementStatus'), billingPortal: requestHandler('billingPortal'),
    onboarding: async (_context, _request, response) => { seen.push('onboarding'); response.json({ endpoint: 'onboarding' }); },
  };
  const value = await fixture(extension);
  const status = await invoke(value.handler, 'POST', '/onboarding/status', { headers: {
    'content-type': 'application/x-www-form-urlencoded',
  }, body: 'csrf_token=fixture' });
  const metadata = await invoke(value.handler, 'GET', '/.well-known/oauth-authorization-server');
  const protectedResource = await invoke(value.handler, 'GET', '/.well-known/oauth-protected-resource');
  const plans = await invoke(value.handler, 'GET', '/billing/plans');
  const orderStatus = await invoke(value.handler, 'GET', '/billing/orders/order_fixture');
  const billingReturn = await invoke(value.handler, 'GET', '/billing/return');
  const billingPage = await invoke(value.handler, 'GET', '/billing');
  const managementStatus = await invoke(value.handler, 'POST', '/billing/status', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf_token=fixture' });
  const management = await invoke(value.handler, 'POST', '/billing/subscriptions/sub_fixture/manage', { headers: {
    'content-type': 'application/x-www-form-urlencoded',
  }, body: 'csrf_token=fixture&action=quote_upgrade' });
  const portal = await invoke(value.handler, 'POST', '/billing/portal', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf_token=fixture' });
  const checkout = await invoke(value.handler, 'POST', '/billing/checkout', { headers: {
    'content-type': 'application/x-www-form-urlencoded',
  }, body: 'csrf_token=fixture' });
  const resume = await invoke(value.handler, 'POST', '/onboarding/resume', { headers: {
    'content-type': 'application/x-www-form-urlencoded',
  }, body: 'csrf_token=fixture' });
  assert.deepEqual(JSON.parse(status.body!), { endpoint: 'status' });
  assert.equal(metadata.statusCode, 200);
  assert.equal(JSON.parse(metadata.body!).token_endpoint, `${config.issuer}/token`);
  assert.equal(protectedResource.statusCode, 200);
  assert.deepEqual(JSON.parse(protectedResource.body!).authorization_servers, [config.issuer]);
  assert.deepEqual(JSON.parse(plans.body!), { endpoint: 'plans' });
  assert.deepEqual(JSON.parse(orderStatus.body!), { endpoint: 'orderStatus' });
  assert.deepEqual(JSON.parse(billingReturn.body!), { endpoint: 'billingReturn' });
  assert.equal(billingPage.statusCode, 302);
  assert.match(responseHeader(billingPage, 'location')!, /\/login$/);
  assert.deepEqual(JSON.parse(managementStatus.body!), { endpoint: 'managementStatus' });
  assert.deepEqual(JSON.parse(management.body!), { endpoint: 'manageSubscription' });
  assert.deepEqual(JSON.parse(portal.body!), { endpoint: 'billingPortal' });
  assert.deepEqual(JSON.parse(checkout.body!), { endpoint: 'checkout' });
  assert.deepEqual(JSON.parse(resume.body!), { endpoint: 'resume' });
  assert.deepEqual(seen, ['status', 'plans', 'orderStatus', 'billingReturn', 'managementStatus', 'manageSubscription',
    'billingPortal', 'checkout', 'resume']);
});

test('a cancelled Cognito login revokes the pending browser session, clears cookies, and hides provider details', async () => {
  const value = await fixture();
  const started = await invoke(value.handler, 'GET', '/login');
  const location = new URL(responseHeader(started, 'location')!);
  const result = await invoke(value.handler, 'GET', `/oauth/cognito/callback?${new URLSearchParams({
    state: location.searchParams.get('state')!, error: 'access_denied', error_description: 'PRIVATE_PROVIDER_DETAIL',
  })}`, { headers: { cookie: cookieHeader(started) } });
  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body!), { error: 'login_cancelled' });
  assert.equal(result.body!.includes('PRIVATE_PROVIDER_DETAIL'), false);
  assert.equal(value.exchanges.length, 0);
  const cleared = setCookies(result);
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every(cookie => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie)));
});

test('management login uses the same session cookies, requires current entitlement, and protects logout with CSRF', async () => {
  const value = await fixture();
  {
    const started = await invoke(value.handler, 'GET', '/login');
    assert.equal(started.statusCode, 302);
    const location = new URL(responseHeader(started, 'location')!);
    const firstCookies = cookieHeader(started);
    const callback = await invoke(value.handler, 'GET', `/oauth/cognito/callback?${new URLSearchParams({
      state: location.searchParams.get('state')!, code: 'management_code_fixture',
    })}`, { headers: { cookie: firstCookies } });
    assert.equal(callback.statusCode, 303);
    assert.equal(responseHeader(callback, 'location'), `${config.issuer}/billing`);
    const cookies = cookieHeader(callback);

    const noEntitlement = await invoke(value.handler, 'GET', '/billing', { headers: { cookie: cookies } });
    assert.equal(noEntitlement.statusCode, 403);
    assert.deepEqual(JSON.parse(noEntitlement.body!), { error: 'subscription_required', message: 'Reconnect from your AI client to select a plan.' });

    value.store.setPaid({ issuer: config.cognito.issuer, subject: 'cognito_subject_fixture' }, now + 3600);
    const page = await invoke(value.handler, 'GET', '/billing', { headers: { cookie: cookies } });
    assert.equal(page.statusCode, 200);
    const html = page.body!;
    assert.match(html, /Plan: basic/);
    const csrf = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
    assert.ok(csrf);
    assert.doesNotMatch(html, /cognito_code_fixture|PRIVATEUSAGEKEY/);

    const deniedLogout = await invoke(value.handler, 'POST', '/logout', { headers: {
      cookie: cookies, origin: 'https://attacker.example.invalid', 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ csrf_token: csrf! }).toString() });
    assert.equal(deniedLogout.statusCode, 403);

    const logout = await invoke(value.handler, 'POST', '/logout', { headers: {
      cookie: cookies, origin: new URL(config.issuer).origin, 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ csrf_token: csrf! }).toString() });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(JSON.parse(logout.body!), { signed_out: true });
    assert.equal(setCookies(logout).length, 2);

    const afterLogout = await invoke(value.handler, 'GET', '/billing', { headers: { cookie: cookies } });
    assert.equal(afterLogout.statusCode, 302);
    assert.equal(responseHeader(afterLogout, 'location'), `${config.issuer}/login`);
  }
});
