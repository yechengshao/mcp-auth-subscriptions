import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authorizerSettings } from '../../authorizer/handler.js';

const gateway = JSON.parse(readFileSync('infra/access/gateway.yaml', 'utf8'));
const publicUrls = readFileSync('infra/access/public-urls.yaml', 'utf8');

test('gateway reads the protected-resource metadata URL from SSM, not from a deploy input or a literal', () => {
  const parameter = gateway.Parameters.ResourceMetadataUrl;
  assert.equal(parameter.Type, 'AWS::SSM::Parameter::Value<String>');
  assert.equal(parameter.Default, '/mcp/test/access/resource-metadata-url');
  assert.match(JSON.stringify(gateway.Resources.GatewayUnauthorizedResponse), /\$\{ResourceMetadataUrl\}/);
});

test('the issuer path prefix is gone: no parameter and no prefix discovery routes for a bare-domain issuer', () => {
  assert.equal(gateway.Parameters.IssuerPathPrefix, undefined);
  const text = JSON.stringify(gateway);
  assert.equal(text.includes('IssuerPathPrefix'), false);
  for (const name of ['ResWkAuthServerPrefix', 'ResWkOpenIdPrefix', 'MWkAuthServerPrefix', 'MWkOpenIdPrefix']) {
    assert.equal(gateway.Resources[name], undefined, name);
  }
  assert.equal(gateway.Resources.Deployment.DependsOn.some((name: string) => name.endsWith('Prefix')), false);
});

test('the published metadata URL is on the authorizer issuer host and matches its path', () => {
  const { config } = authorizerSettings('test');
  const published = publicUrls.match(/ResourceMetadataUrl:\n\s+Type: String\n\s+Default: (\S+)\n/);
  assert.ok(published, 'public-urls.yaml publishes a default metadata URL');
  assert.equal(published[1], `${config.issuer}/.well-known/oauth-protected-resource`);
  assert.match(publicUrls, /Name: !Sub '\/mcp\/\$\{Environment\}\/access\/resource-metadata-url'/);
});
