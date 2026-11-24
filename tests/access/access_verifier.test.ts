import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccess, type VerifyInput } from '../../scripts/verify_access.js';
const input: VerifyInput = { baseUrl: 'https://api.example.invalid/test', issuer: 'https://login.example.invalid/test', resource: 'https://api.example.invalid/test/mcp' };
const metadataUrl = 'https://api.example.invalid/test/.well-known/oauth-protected-resource';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A fixture deployment that satisfies every read-only check. */
function goodRoutes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    '/.well-known/oauth-protected-resource': () => json({ resource: input.resource, authorization_servers: [input.issuer] }),
    '/.well-known/oauth-authorization-server': () => json({ issuer: input.issuer, authorization_endpoint: 'https://login.example.invalid/authorize', token_endpoint: 'https://api.example.invalid/test/token', jwks_uri: 'https://api.example.invalid/test/jwks.json', code_challenge_methods_supported: ['S256'] }),
    '/jwks.json': () => json({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'fixture_key', n: 'AQAB', e: 'AQAB' }] }),
    '/mcp': () => new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` } }),
    '/health': () => new Response(null, { status: 401 }),
    '/billing': () => new Response(null, { status: 302, headers: { location: 'https://api.example.invalid/test/login' } }),
    ...overrides,
  };
}
function transport(routes: Record<string, () => Response>, seen: { method: string; redirect: string; authorization?: string; url: string }[] = []) {
  return async (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string> }) => {
    const path = new URL(url).pathname.replace(/^\/test/, '');
    const authorization = init.headers.authorization;
    seen.push({ method: init.method, redirect: init.redirect, url, ...(authorization === undefined ? {} : { authorization }) });
    const route = routes[path];
    if (!route) return new Response(null, { status: 404 });
    return route();
  };
}
const statusOf = (report: Awaited<ReturnType<typeof verifyAccess>>, name: string) => report.checks.find(check => check.name === name)?.status;
test('a conforming deployment passes every read-only check and marks the paid-subscriber checks not_run', async () => {
  const report = await verifyAccess(input, transport(goodRoutes()));
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { passed: 7, failed: 0, not_run: 6 });
  assert.equal(report.checks.filter(check => check.status === 'not_run').every(check => check.detail.length > 0), true);
});
test('the verifier sends only GET requests with redirects disabled and only the fixed invalid bearer', async () => {
  const seen: { method: string; redirect: string; authorization?: string; url: string }[] = [];
  await verifyAccess(input, transport(goodRoutes(), seen));
  assert.equal(seen.length, 7);
  assert.equal(seen.every(request => request.method === 'GET' && request.redirect === 'manual'), true);
  const bearers = seen.filter(request => request.authorization !== undefined).map(request => request.authorization);
  assert.deepEqual(bearers, ['Bearer invalid.verifier.token']);
});
test('a wrong issuer, resource or S256 omission fails discovery without echoing the response', async () => {
  const report = await verifyAccess(input, transport(goodRoutes({
    '/.well-known/oauth-authorization-server': () => json({ issuer: 'https://evil.example.invalid', authorization_endpoint: 'https://login.example.invalid/authorize', token_endpoint: 'https://api.example.invalid/test/token', jwks_uri: 'https://api.example.invalid/test/jwks.json', code_challenge_methods_supported: ['plain'], secret: 'DISCOVERY_SENTINEL' }),
    '/.well-known/oauth-protected-resource': () => json({ resource: 'https://other.example.invalid/mcp', authorization_servers: [input.issuer] }),
  })));
  assert.equal(statusOf(report, 'discovery-authorization-server'), 'failed');
  assert.equal(statusOf(report, 'discovery-protected-resource'), 'failed');
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('DISCOVERY_SENTINEL'), false);
});
test('a published key with private material or a duplicate kid fails the JWKS check', async () => {
  for (const keys of [[{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'a', n: 'AQAB', e: 'AQAB', d: 'PRIVATE_SENTINEL' }], [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'a' }, { kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'a' }], []]) {
    const report = await verifyAccess(input, transport(goodRoutes({ '/jwks.json': () => json({ keys }) })));
    assert.equal(statusOf(report, 'jwks-public-only'), 'failed');
    assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'), false);
  }
});
test('an open MCP route, a challenge without the metadata URL, or a redirect-free billing page fails', async () => {
  const open = await verifyAccess(input, transport(goodRoutes({ '/mcp': () => new Response('ok', { status: 200 }) })));
  assert.equal(statusOf(open, 'mcp-unauthenticated-challenge'), 'failed');
  const bare = await verifyAccess(input, transport(goodRoutes({ '/mcp': () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }) })));
  assert.equal(statusOf(bare, 'mcp-unauthenticated-challenge'), 'failed');
  const billing = await verifyAccess(input, transport(goodRoutes({ '/billing': () => new Response(null, { status: 302, headers: { location: 'https://api.example.invalid/test/onboarding' } }) })));
  assert.equal(statusOf(billing, 'billing-anonymous-redirect'), 'failed');
});
test('a non-JSON or unreachable discovery response is a failure, not a pass', async () => {
  const html = await verifyAccess(input, transport(goodRoutes({ '/jwks.json': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) })));
  assert.equal(statusOf(html, 'jwks-public-only'), 'failed');
  const missing = await verifyAccess(input, transport({}));
  assert.equal(missing.ok, false);
  assert.equal(missing.summary.passed, 0);
});
test('an invalid bearer that the gateway accepts is reported as a failure', async () => {
  const report = await verifyAccess(input, transport(goodRoutes({ '/mcp': () => new Response(null, { status: 200 }) })));
  assert.equal(statusOf(report, 'mcp-invalid-bearer-denied'), 'failed');
});
test('the verifier refuses plain HTTP, query strings and fragments as the base URL', async () => {
  for (const baseUrl of ['http://api.example.invalid/test', 'https://api.example.invalid/test?x=1', 'https://api.example.invalid/test#frag']) {
    await assert.rejects(verifyAccess({ ...input, baseUrl }, transport(goodRoutes())), /invalid_base_url/);
  }
});
