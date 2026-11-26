import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizerConstants, authorizerSettings } from '../../authorizer/handler.js';

test('test environment resolves the access host from code, with the JWKS on the issuer', () => {
  const { config, jwksUri } = authorizerSettings('test');
  assert.equal(config.issuer, 'https://access.tradingview.chat');
  assert.equal(config.resource, 'https://access.tradingview.chat/mcp');
  assert.equal(jwksUri, 'https://access.tradingview.chat/jwks.json');
  assert.equal(config.clockSkewSeconds, authorizerConstants.clockSkewSeconds);
  assert.deepEqual(config.routes, authorizerConstants.routes);
});

test('environments without an approved domain refuse to start, and unknown names are refused', () => {
  for (const environment of ['production', 'development', 'staging', undefined, '__proto__', 'constructor']) {
    assert.throws(() => authorizerSettings(environment), /^Error: invalid_configuration$/, String(environment));
  }
});
