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

test('alarm topic publishes its ARN under the shared convention', () => {
  const alarms = load('infra/observability/alarm-topic.yaml');
  assert.deepEqual(alarms.Parameters.Environment.AllowedValues, ['development', 'test', 'production']);
  assert.deepEqual(parameterOf(alarms, 'AlarmTopicArnParameter').Name, { 'Fn::Sub': '/mcp/${Environment}/alarms/topic-arn' });
  assert.deepEqual(parameterOf(alarms, 'AlarmTopicArnParameter').Value, { Ref: 'AlarmTopic' });
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

test('access runtime and authorizer set no reserved concurrency until the account quota allows it', () => {
  const runtime = load('infra/access/runtime.yaml');
  const authorizer = load('infra/access/authorizer.yaml');
  assert.equal(runtime.Parameters.ReservedConcurrency, undefined);
  for (const template of [runtime, authorizer]) {
    for (const resource of Object.values<any>(template.Resources)) {
      if (resource.Type === 'AWS::Lambda::Function') assert.equal(resource.Properties.ReservedConcurrentExecutions, undefined);
    }
  }
});

test('access runtime reads the signing key ARN from SSM and derives the public JWK from KMS, with no stored public key', () => {
  const runtime = load('infra/access/runtime.yaml');
  const statements = runtime.Resources.Role.Properties.Policies[0].PolicyDocument.Statement;
  const ssmRead = statements.find((s: any) => s.Action === 'ssm:GetParameter' &&
    JSON.stringify(s.Resource).includes('/access/signing-key-arn'));
  assert.deepEqual(ssmRead.Resource, { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/mcp/${Environment}/access/signing-key-arn' });
  assert.ok(statements.some((s: any) => s.Action === 'kms:GetPublicKey' && s.Resource.Ref === 'SigningKeyArn'));
  assert.deepEqual(runtime.Resources.Function.Properties.Environment.Variables.ACCESS_SIGNING_KEY_ARN_PARAMETER,
    { 'Fn::Sub': '/mcp/${Environment}/access/signing-key-arn' });
  const signing = load('infra/access/signing.yaml');
  assert.equal(Object.values<any>(signing.Resources).some(r => r.Type === 'AWS::SSM::Parameter' && JSON.stringify(r).includes('PublicKey')), false);
});

test('access runtime reads the REST API ID from SSM at runtime instead of taking it as a deploy input', () => {
  const runtime = load('infra/access/runtime.yaml');
  assert.equal(runtime.Parameters.ProvisioningConfigJson.Type, 'String');
  const statements = runtime.Resources.Role.Properties.Policies[0].PolicyDocument.Statement;
  assert.ok(statements.some((s: any) => s.Action === 'ssm:GetParameter' && JSON.stringify(s.Resource).includes('/access-api/rest-api-id')));
  assert.deepEqual(runtime.Resources.Function.Properties.Environment.Variables.ACCESS_REST_API_ID_PARAMETER,
    { 'Fn::Sub': '/mcp/${Environment}/access-api/rest-api-id' });
  assert.equal(JSON.stringify(runtime).includes('"Ref":"RestApiId"'), false);
});

test('gateway publishes its REST API ID and stage so billing can match plan mappings to this deployment', () => {
  const gateway = load('infra/access/gateway.yaml');
  assert.deepEqual(parameterOf(gateway, 'RestApiStageParameter').Name, { 'Fn::Sub': '/mcp/${Environment}/access-api/stage' });
  assert.deepEqual(parameterOf(gateway, 'RestApiStageParameter').Value, { Ref: 'StageName' });
});

test('gateway resolves producer aliases from SSM at deploy time instead of taking ARNs', () => {
  const gateway = load('infra/access/gateway.yaml');
  const expected: Record<string, string> = {
    ServiceAliasParameter: '/mcp/test/service/alias-arn',
    AccessAliasParameter: '/mcp/test/access/alias-arn',
    BillingWebhookAliasParameter: '/mcp/test/billing/alias-arn',
    AuthorizerAliasParameter: '/mcp/test/authorizer/alias-arn',
  };
  for (const [name, parameterName] of Object.entries(expected)) {
    assert.equal(gateway.Parameters[name].Type, 'AWS::SSM::Parameter::Value<String>');
    assert.equal(gateway.Parameters[name].Default, parameterName);
  }
  for (const name of ['ServiceAliasArn', 'AccessAliasArn', 'BillingWebhookAliasArn', 'AuthorizerAliasArn']) {
    assert.equal(JSON.stringify(gateway).includes(name), false, name);
  }
});
