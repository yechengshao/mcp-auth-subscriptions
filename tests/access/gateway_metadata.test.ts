import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authorizerSettings } from '../../authorizer/handler.js';

const gateway = JSON.parse(readFileSync('infra/access/gateway.yaml', 'utf8'));
const publicUrls = readFileSync('infra/access/public-urls.yaml', 'utf8');

test('gateway advertises the protected-resource metadata on the test host without a deploy input', () => {
  const url = gateway.Parameters.ResourceMetadataUrl.Default;
  assert.equal(url, 'https://access.tradingview.chat/.well-known/oauth-protected-resource');
  assert.equal(gateway.Parameters.ResourceMetadataUrl.Default === undefined, false);
});

test('the metadata URL is on the same host as the authorizer issuer and the published public URLs', () => {
  const url = new URL(gateway.Parameters.ResourceMetadataUrl.Default);
  const { config } = authorizerSettings('test');
  assert.equal(url.origin, new URL(config.issuer).origin);
  assert.match(publicUrls, new RegExp(`Default: ${config.issuer.replace(/[.]/g, '\\.')}\\n`));
});
