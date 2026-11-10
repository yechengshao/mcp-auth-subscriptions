import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessDependencyGrants, authorizerLogPolicy } from '../../access/contracts/infrastructure.js';
test('access cross-stack grants target only the entitlement table and exact billing alias', () => {
  const grants = accessDependencyGrants('arn:aws:dynamodb:us-east-1:000000000000:table/entitlements', 'arn:aws:lambda:us-east-1:000000000000:function:billing:live');
  assert.deepEqual(grants[0]!.Action, ['dynamodb:GetItem','dynamodb:ConditionCheckItem']);
  assert.equal(grants[1]!.Resource.endsWith(':live'), true);
  assert.throws(() => accessDependencyGrants(grants[0]!.Resource, 'arn:aws:lambda:us-east-1:111111111111:function:billing:live'));
  assert.throws(() => accessDependencyGrants(grants[0]!.Resource, 'arn:aws:lambda:us-east-1:000000000000:function:billing:*'));
});
test('authorizer policy cannot read state/secrets or invoke protected services', () => {
  const statements = authorizerLogPolicy('arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/authorizer', true);
  const actions = statements.flatMap(statement => statement.Action);
  assert.deepEqual(actions, ['logs:CreateLogStream','logs:PutLogEvents','xray:PutTraceSegments','xray:PutTelemetryRecords']);
});
test('access state has retention and selective TTL, with no activation transport or broad write IAM', () => {
  const source = readFileSync('infra/access/storage.yaml', 'utf8');
  for (const requirement of ['DeletionPolicy: Retain','UpdateReplacePolicy: Retain','DeletionProtectionEnabled: true','AttributeName: delete_after']) assert.ok(source.includes(requirement));
  for (const prohibited of ['StreamSpecification','GlobalSecondaryIndexes','AWS::SQS','AWS::Pipes','AWS::StepFunctions','dynamodb:Scan','Resource: "*"']) assert.equal(source.includes(prohibited), false);
});
test('prepared authorizer function has only the telemetry role and no public or service invoke surface', () => {
  const template = JSON.parse(readFileSync('infra/access/authorizer.yaml', 'utf8'));
  assert.equal(Object.keys(template.Resources).length, 4);
  assert.deepEqual(template.Resources.Role.Properties.ManagedPolicyArns, [{ Ref: 'TelemetryPolicyArn' }]);
  assert.deepEqual(template.Resources.Function.Properties.Architectures, ['arm64']);
  const variables = Object.keys(template.Resources.Function.Properties.Environment.Variables);
  assert.deepEqual(variables, ['MCP_SERVICE','MCP_ENVIRONMENT','MCP_RELEASE','AUTHORIZER_CONFIG','SERVICE_JWKS_URI']);
  const text = JSON.stringify(template);
  for (const forbidden of ['AWS::Lambda::Url','AWS::Lambda::Permission','dynamodb:','ssm:','lambda:InvokeFunction','apigateway:','kms:']) assert.equal(text.includes(forbidden), false);
});
