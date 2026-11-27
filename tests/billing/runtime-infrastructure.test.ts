import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  // Reserved concurrency is not set: this account's unreserved limit (10) cannot hold a reservation. The budget value is the target; see the setup guide.
  assert.equal(template.Resources.Function.Properties.ReservedConcurrentExecutions, undefined);
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
test('the billing runtime publishes a new Lambda version for each image, so no renderer is needed', () => {
  const runtime = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
  const version = runtime.Resources.Version;
  assert.equal(version.Type, 'AWS::Lambda::Version');
  assert.deepEqual(version.Properties.Description, { Ref: 'ImageUri' }, 'the version description follows the image, a replacement property');
  assert.equal(version.DeletionPolicy, 'Retain');
  assert.deepEqual(runtime.Resources.Alias.Properties.FunctionVersion, { 'Fn::GetAtt': ['Version', 'Version'] });
});
test('runtime configuration rejects budget/IaC drift and cross-account sources', () => {
  const source = { MCP_ENVIRONMENT: 'test', AWS_ACCOUNT_ID: '000000000000', AWS_REGION: 'us-east-1', STRIPE_LIVE: 'false',
    BILLING_BUDGETS: JSON.stringify(budgets), BILLING_FUNCTION_TIMEOUT: '30', BILLING_RESERVED_CONCURRENCY: '5',
    BILLING_QUEUE_VISIBILITY: '185', BILLING_SQS_CONCURRENCY: '2', BILLING_BATCH_WINDOW: '5', BILLING_REPLAY_INTERVAL: '60',
    BILLING_QUEUE_ARN: 'arn:aws:sqs:us-east-1:000000000000:billing', BILLING_REPLAY_RULE_ARN: 'arn:aws:events:us-east-1:000000000000:rule/replay',
    STRIPE_ACCOUNT_ID: 'acct_fixture', BILLING_STATE_TABLE: 'state', BILLING_ENTITLEMENTS_TABLE: 'entitlements',
    STRIPE_KEY_PARAMETER: '/test/stripe', STRIPE_WEBHOOK_SECRET_PARAMETER: '/test/webhook',
    BILLING_REST_API_PARAMETER: '/mcp/test/access-api/rest-api-id', BILLING_STAGE_PARAMETER: '/mcp/test/access-api/stage', BILLING_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/billing',
    BILLING_SUCCESS_URL: 'https://example.invalid/billing/return', BILLING_CANCEL_URL: 'https://example.invalid/billing/cancel', BILLING_SUPPORT_EMAIL: 'support@example.invalid' };
  assert.equal(runtimeConfig(source).live, false);
  assert.throws(() => runtimeConfig({ ...source, BILLING_QUEUE_VISIBILITY: '1' }));
  assert.throws(() => runtimeConfig({ ...source, BILLING_QUEUE_ARN: 'arn:aws:sqs:us-east-1:111111111111:billing' }));
  assert.throws(() => runtimeConfig({ ...source, STRIPE_LIVE: 'maybe' }));
});

test('billing runtime grants no invoke permission to the access role; access calls billing through its own IAM policy', () => {
  const template = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
  assert.equal(template.Parameters.AccessRoleArn, undefined);
  const permissions = Object.values(template.Resources).filter((value: any) => value.Type === 'AWS::Lambda::Permission');
  assert.deepEqual(permissions.map((value: any) => value.Properties.Principal), ['events.amazonaws.com']);
});

test('billing runtime publishes its live alias ARN under the shared /mcp/<environment>/<component>/<name> convention', () => {
  const template = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
  const parameter = template.Resources.AliasParameter;
  assert.equal(parameter.Type, 'AWS::SSM::Parameter');
  assert.deepEqual(parameter.Properties.Name, { 'Fn::Sub': '/mcp/${Environment}/billing/alias-arn' });
  assert.deepEqual(parameter.Properties.Value, { Ref: 'Alias' });
  assert.equal(parameter.Properties.Type, 'String');
});

test('billing image is published to SSM by the workflow and read by the runtime, not passed at deploy time', () => {
  const runtime = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
  assert.equal(runtime.Parameters.ImageUri.Type, 'AWS::SSM::Parameter::Value<String>');
  assert.equal(runtime.Parameters.ImageUri.Default, '/mcp/test/billing/image-uri');
  const publication = readFileSync('infra/billing/publication.yaml', 'utf8');
  assert.match(publication, /"Action": "ssm:PutParameter", "Resource": \{ "Fn::Sub": "arn:\$\{AWS::Partition\}:ssm:\$\{AWS::Region\}:\$\{AWS::AccountId\}:parameter\/mcp\/\$\{Environment\}\/billing\/image-uri" \}/);
  const workflow = readFileSync('.github/workflows/publish-billing-image.yml', 'utf8');
  assert.match(workflow, /aws ssm put-parameter --region "\$AWS_REGION" --name "\/mcp\/test\/billing\/image-uri" --type String --value "\$IMAGE_URI" --overwrite/);
  assert.ok(workflow.indexOf('Publish the tested image URI to SSM') > workflow.indexOf('Smoke test the pushed ARM64 image'), 'SSM is written only after the smoke test');
});
