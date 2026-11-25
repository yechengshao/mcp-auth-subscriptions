import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const parameterOf = (template: any, logicalId: string) => template.Resources[logicalId].Properties;

test('producers publish their consumer-facing values under the /mcp/<environment>/<component>/<name> convention', () => {
  const access = parameterOf(load('infra/access/runtime.yaml'), 'AccessAliasParameter');
  assert.deepEqual(access.Name, { 'Fn::Sub': '/mcp/${Environment}/access/alias-arn' });
  assert.deepEqual(access.Value, { Ref: 'Alias' });

  const authorizer = parameterOf(load('infra/access/authorizer.yaml'), 'AliasParameter');
  assert.deepEqual(authorizer.Name, { 'Fn::Sub': '/mcp/${Environment}/authorizer/alias-arn' });
  assert.deepEqual(authorizer.Value, { Ref: 'Alias' });

  const gateway = load('infra/access/gateway.yaml');
  assert.deepEqual(parameterOf(gateway, 'UsagePlanIdParameter').Name, { 'Fn::Sub': '/mcp/${Environment}/access-api/usage-plan-id' });
  assert.deepEqual(parameterOf(gateway, 'UsagePlanIdParameter').Value, { Ref: 'BasicUsagePlan' });
  assert.deepEqual(gateway.Parameters.Environment.AllowedValues, ['development', 'test', 'production']);
});

test('billing storage publishes table names and stream ARN for later consumers, with an environment input', () => {
  const storage = load('infra/billing/storage.yaml');
  assert.deepEqual(storage.Parameters.Environment.AllowedValues, ['development', 'test', 'production']);
  assert.deepEqual(parameterOf(storage, 'StateTableNameParameter').Name, { 'Fn::Sub': '/mcp/${Environment}/billing/state-table-name' });
  assert.deepEqual(parameterOf(storage, 'StateTableNameParameter').Value, { Ref: 'BillingState' });
  assert.deepEqual(parameterOf(storage, 'EntitlementsTableNameParameter').Value, { Ref: 'BillingEntitlements' });
  assert.deepEqual(parameterOf(storage, 'StateStreamArnParameter').Value, { 'Fn::GetAtt': ['BillingState', 'StreamArn'] });
});

test('access storage and signing publish their table name and signing key ARN under the shared convention', () => {
  const signing = load('infra/access/signing.yaml');
  assert.deepEqual(signing.Parameters.Environment.AllowedValues, ['development', 'test', 'production']);
  assert.deepEqual(parameterOf(signing, 'SigningKeyArnParameter').Name, { 'Fn::Sub': '/mcp/${Environment}/access/signing-key-arn' });
  assert.deepEqual(parameterOf(signing, 'SigningKeyArnParameter').Value, { 'Fn::GetAtt': ['SigningKey', 'Arn'] });
  const storage = readFileSync('infra/access/storage.yaml', 'utf8');
  assert.ok(storage.includes("Name: !Sub '/mcp/${Environment}/access/state-table-name'"));
  assert.ok(storage.includes('Value: !Ref AccessState'));
  assert.ok(storage.includes('Environment:\n    Type: String'));
});
