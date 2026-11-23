import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseTemplate } from '../../infra/billing/release.js';
import { runtimeConfig } from '../../billing/handler.js';
import { budgets } from '../fixtures/storage.js';
const template = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
test('billing runtime has one ARM64 function and only billing background delivery', () => {
  const resources = Object.values(template.Resources) as any[];
  assert.equal(resources.filter(r => r.Type === 'AWS::Lambda::Function').length, 1);
  assert.equal(resources.filter(r => r.Type === 'AWS::SQS::Queue').length, 2);
  assert.equal(resources.filter(r => r.Type === 'AWS::DynamoDB::Table').length, 0);
  assert.deepEqual(template.Resources.Function.Properties.Architectures, ['arm64']);
  assert.equal(template.Parameters.EnableDelivery.Default, 'false');
  assert.deepEqual(template.Resources.Mapping.Properties.FunctionResponseTypes, ['ReportBatchItemFailures']);
  assert.equal(template.Resources.Queue.Properties.VisibilityTimeout, 185);
  assert.equal(template.Resources.Mapping.Properties.ScalingConfig.MaximumConcurrency, 2);
  assert.equal(template.Resources.Function.Properties.ReservedConcurrentExecutions, 5);
  assert.equal(template.Parameters.TracingMode.Default, 'PassThrough');
  assert.deepEqual(template.Resources.QueuePolicy.Properties.PolicyDocument.Statement[0].Principal.AWS, [{ 'Fn::GetAtt': ['Role', 'Arn'] }, { 'Fn::GetAtt': ['PipeRole', 'Arn'] }]);
  const policy = JSON.stringify(template.Resources.Role);
  for (const forbidden of ['cognito:', 'apigateway:', 'ssm:*', 'dynamodb:Scan', 'lambda:InvokeFunction']) assert.equal(policy.includes(forbidden), false);
});
test('Pipe filter matches storage contract and literal generation keeps DynamoDB N out of JSON numbers', () => {
  const storage = JSON.parse(readFileSync('infra/billing/storage.yaml', 'utf8'));
  const pipe = template.Resources.Pipe.Properties;
  assert.equal(pipe.SourceParameters.FilterCriteria.Filters[0].Pattern, storage.Outputs.ReconciliationInsertFilter.Value);
  const filter = JSON.parse(storage.Outputs.ReconciliationInsertFilter.Value);
  assert.deepEqual(filter.dynamodb.NewImage.generation.N, ['1']);
  const input = pipe.TargetParameters.InputTemplate;
  assert.equal(input.includes('"generation":1'), true);
  assert.equal(input.includes('NewImage.generation.N'), false);
  assert.equal(input.includes('payment_intent'), false);
});
test('release rendering requires an image digest and changes retained version per artifact', () => {
  const prefix = '000000000000.dkr.ecr.us-east-1.amazonaws.com/billing@sha256:';
  const first = releaseTemplate(prefix + 'a'.repeat(64));
  const second = releaseTemplate(prefix + 'b'.repeat(64));
  const version = (t: any) => Object.keys(t.Resources).find(key => key.startsWith('Version'))!;
  assert.notEqual(version(first), version(second));
  assert.equal(first.Resources[version(first)].DeletionPolicy, 'Retain');
  assert.deepEqual(first.Resources.Alias.Properties.FunctionVersion['Fn::GetAtt'], [version(first), 'Version']);
  assert.throws(() => releaseTemplate('repository:latest'));
});
test('runtime configuration rejects budget/IaC drift and cross-account sources', () => {
  const source = { MCP_ENVIRONMENT: 'test', AWS_ACCOUNT_ID: '000000000000', AWS_REGION: 'us-east-1', STRIPE_LIVE: 'false',
    BILLING_BUDGETS: JSON.stringify(budgets), BILLING_FUNCTION_TIMEOUT: '30', BILLING_RESERVED_CONCURRENCY: '5',
    BILLING_QUEUE_VISIBILITY: '185', BILLING_SQS_CONCURRENCY: '2', BILLING_BATCH_WINDOW: '5', BILLING_REPLAY_INTERVAL: '60',
    BILLING_QUEUE_ARN: 'arn:aws:sqs:us-east-1:000000000000:billing', BILLING_REPLAY_RULE_ARN: 'arn:aws:events:us-east-1:000000000000:rule/replay',
    STRIPE_ACCOUNT_ID: 'acct_fixture', BILLING_STATE_TABLE: 'state', BILLING_ENTITLEMENTS_TABLE: 'entitlements', BILLING_CATALOG_PARAMETER: '/test/catalog',
    STRIPE_KEY_PARAMETER: '/test/stripe', STRIPE_WEBHOOK_SECRET_PARAMETER: '/test/webhook', BILLING_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/billing',
    BILLING_SUCCESS_URL: 'https://example.invalid/billing/return', BILLING_CANCEL_URL: 'https://example.invalid/billing/cancel', BILLING_SUPPORT_EMAIL: 'support@example.invalid' };
  assert.equal(runtimeConfig(source).live, false);
  assert.throws(() => runtimeConfig({ ...source, BILLING_QUEUE_VISIBILITY: '1' }));
  assert.throws(() => runtimeConfig({ ...source, BILLING_QUEUE_ARN: 'arn:aws:sqs:us-east-1:111111111111:billing' }));
  assert.throws(() => runtimeConfig({ ...source, STRIPE_LIVE: 'maybe' }));
});
