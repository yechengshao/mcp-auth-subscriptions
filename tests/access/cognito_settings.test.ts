import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCognitoSettings, cognitoScopes } from '../../access/cognito-settings.js';
import { Telemetry } from '../../observability/telemetry.js';

const names = {
  issuer: '/mcp/test/access/cognito-issuer', clientId: '/mcp/test/access/cognito-client-id',
  domain: '/mcp/test/access/cognito-domain', callbackUri: '/mcp/test/access/cognito-callback-uri',
};
const values: Record<string, string> = {
  [names.issuer]: 'https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_fixture',
  [names.clientId]: 'fixture_client', [names.domain]: 'https://access-fixture.auth.ca-central-1.amazoncognito.com',
  [names.callbackUri]: 'https://access.example.invalid/oauth/cognito/callback',
};
const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: () => undefined });
const fakeSsm = (overrides: Record<string, unknown> = {}, calls: string[] = []) => ({ send: async (command: any) => {
  calls.push(command.input.Name);
  const name = command.input.Name as string;
  if (overrides[name] !== undefined) return overrides[name];
  return { Parameter: { Type: 'String', Value: values[name] } };
} }) as any;

test('the Cognito configuration is read from four String parameters and validated as one object', async () => {
  const calls: string[] = [];
  const cognito = await readCognitoSettings(names, telemetry(), fakeSsm({}, calls));
  assert.deepEqual(cognito, { issuer: values[names.issuer], domain: values[names.domain], clientId: 'fixture_client',
    callbackUri: values[names.callbackUri], scopes: ['openid', 'email'] });
  assert.equal(calls.length, 4);
});

test('a missing, non-String or malformed Cognito parameter fails the startup', async () => {
  await assert.rejects(readCognitoSettings(names, telemetry(), fakeSsm({ [names.clientId]: { Parameter: { Type: 'SecureString', Value: 'x' } } })), /invalid_cognito_parameter/);
  await assert.rejects(readCognitoSettings(names, telemetry(), fakeSsm({ [names.domain]: { Parameter: undefined } })), /invalid_cognito_parameter/);
  await assert.rejects(readCognitoSettings(names, telemetry(), fakeSsm({ [names.issuer]: { Parameter: { Type: 'String', Value: 'https://evil.example.invalid/x' } } })));
  await assert.rejects(readCognitoSettings({ ...names, issuer: '/mcp/test/access/other' }, telemetry(), fakeSsm()), /invalid_cognito_parameter_configuration/);
});

test('the scopes in code equal the Cognito app client AllowedOAuthScopes in infra/access/auth.yaml', () => {
  const template = readFileSync('infra/access/auth.yaml', 'utf8');
  assert.match(template, /AllowedOAuthScopes:\n\s+- openid\n\s+- email\n/);
  assert.deepEqual(cognitoScopes, ['openid', 'email']);
});
