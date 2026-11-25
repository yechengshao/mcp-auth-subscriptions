import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeParameters, validateAccessConfiguration, accessScopes } from '../../access/config.js';

const config = validateAccessConfiguration({
  environment: 'test', issuer: 'https://access.example.invalid', resource: 'https://api.example.invalid/test/mcp',
  clientConfigVersion: 'open_v1', cookieName: '__Host-access',
  cognito: { issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture', domain: 'https://login.example.invalid',
    clientId: 'cognito_fixture', callbackUri: 'https://access.example.invalid/oauth/cognito/callback', scopes: ['openid', 'email'] },
});
const challenge = Buffer.alloc(32, 7).toString('base64url');
const request = (overrides: Record<string, string> = {}) => ({
  response_type: 'code', client_id: 'any_client_1', redirect_uri: 'https://app.example.invalid/callback', resource: config.resource,
  scope: 'openid mcp:invoke', state: 'state_fixture', code_challenge: challenge, code_challenge_method: 'S256', ...overrides,
});

test('any well-formed client may start a sign-in, with an HTTPS redirect URI and PKCE', () => {
  const accepted = authorizeParameters(config, request());
  assert.equal(accepted.client_id, 'any_client_1');
  assert.equal(accepted.redirect_uri, 'https://app.example.invalid/callback');
  assert.deepEqual(accepted.scopes, ['openid', 'mcp:invoke']);
  assert.deepEqual(accessScopes, ['openid', 'mcp:invoke']);
});

test('the client ID must still be well formed, and the redirect URI must be HTTPS without credentials, fragment or wildcard', () => {
  for (const bad of [{ client_id: 'bad client id!' }, { redirect_uri: 'http://app.example.invalid/callback' },
    { redirect_uri: 'https://user:pw@app.example.invalid/callback' }, { redirect_uri: 'https://app.example.invalid/callback#frag' },
    { redirect_uri: 'https://*.example.invalid/callback' }, { redirect_uri: 'not a url' }, { scope: 'openid admin:everything' }]) {
    assert.throws(() => authorizeParameters(config, request(bad)), /invalid_request/, JSON.stringify(bad));
  }
});

test('the access configuration no longer accepts a client list', () => {
  assert.throws(() => validateAccessConfiguration({ ...JSON.parse(JSON.stringify({ environment: 'test' })), clients: [] }), /invalid_access_configuration/);
});
