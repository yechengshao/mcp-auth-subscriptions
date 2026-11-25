import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  for (const prohibited of ['StreamSpecification','GlobalSecondaryIndexes','AWS::SQS','AWS::Pipes','AWS::StepFunctions','dynamodb:Scan','dynamodb:*','Resource: "*"']) assert.equal(source.includes(prohibited), false);
  assert.match(source, /dynamodb:GetItem[\s\S]*dynamodb:PutItem[\s\S]*dynamodb:ConditionCheckItem/);
  assert.equal(source.includes('dynamodb:UpdateItem'), false);
});
test('Cognito create-mode template retains a self-registering public code-flow client with a Google federation', () => {
  const template = readFileSync('infra/access/auth.yaml', 'utf8');
  for (const requirement of ['DeletionPolicy: Retain','AllowAdminCreateUserOnly: false','GenerateSecret: false',
    'AllowedOAuthFlowsUserPoolClient: true','- code','- openid','- email','PreventUserExistenceErrors: ENABLED',
    'CoordinatorCallbackUri','CoordinatorLogoutUri','AWS::Cognito::UserPoolDomain',
    'AWS::Cognito::UserPoolIdentityProvider','ProviderName: Google','ProviderType: Google','- COGNITO','- Google',
    'GoogleClientSecret','NoEcho: true']) assert.ok(template.includes(requirement), requirement);
  for (const prohibited of ['Implicit','selfSignUp','AllowAdminCreateUserOnly: true']) assert.equal(template.includes(prohibited), false);
});
test('prepared authorizer function has only the telemetry role and no public or service invoke surface', () => {
  const template = JSON.parse(readFileSync('infra/access/authorizer.yaml', 'utf8'));
  // Five resources: role, function, version, alias and the published alias parameter (publish-only, no grant).
  assert.equal(Object.keys(template.Resources).length, 5);
  assert.equal(template.Resources.AliasParameter.Type, 'AWS::SSM::Parameter');
  assert.deepEqual(template.Resources.Role.Properties.ManagedPolicyArns, [{ Ref: 'TelemetryPolicyArn' }]);
  assert.deepEqual(template.Resources.Function.Properties.Architectures, ['arm64']);
  const variables = Object.keys(template.Resources.Function.Properties.Environment.Variables);
  assert.deepEqual(variables, ['MCP_SERVICE','MCP_ENVIRONMENT','MCP_RELEASE','AUTHORIZER_CONFIG','SERVICE_JWKS_URI']);
  const text = JSON.stringify(template);
  for (const forbidden of ['AWS::Lambda::Url','AWS::Lambda::Permission','dynamodb:','ssm:','lambda:InvokeFunction','apigateway:','kms:']) assert.equal(text.includes(forbidden), false);
});

test('access HTTP runtime is digest-pinned, traced, and constrained to its three dependencies', () => {
  const template = JSON.parse(readFileSync('infra/access/runtime.yaml', 'utf8'));
  const role = template.Resources.Role.Properties;
  assert.deepEqual(role.ManagedPolicyArns, [{ Ref: 'TelemetryPolicyArn' }]);
  const statements = role.Policies[0].PolicyDocument.Statement.filter((value: Record<string, unknown>) => value.Effect === 'Allow');
  const state = statements.find((value: Record<string, unknown>) => JSON.stringify(value.Resource) === JSON.stringify({ Ref: 'StateTableArn' }));
  const entitlement = statements.find((value: Record<string, unknown>) => JSON.stringify(value.Resource) === JSON.stringify({ Ref: 'EntitlementTableArn' }));
  assert.deepEqual(state?.Action, ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:ConditionCheckItem']);
  assert.deepEqual(entitlement?.Action, ['dynamodb:GetItem','dynamodb:ConditionCheckItem']);
  assert.ok(statements.some((value: Record<string, unknown>) => value.Action === 'lambda:InvokeFunction' &&
    JSON.stringify(value.Resource) === JSON.stringify({ Ref: 'BillingAliasArn' })));
  const sign = statements.find((value: Record<string, unknown>) => value.Action === 'kms:Sign');
  const publicKey = statements.find((value: Record<string, unknown>) => value.Action === 'kms:GetPublicKey');
  assert.deepEqual(sign?.Resource, { Ref: 'SigningKeyArn' });
  assert.deepEqual(sign?.Condition, { StringEquals: { 'kms:SigningAlgorithm': 'RSASSA_PKCS1_V1_5_SHA_256' } });
  assert.deepEqual(publicKey?.Resource, { Ref: 'SigningKeyArn' });
  assert.equal(JSON.stringify(template).includes('secretsmanager'), false);
  assert.equal(JSON.stringify(template).includes('SigningKmsKeyArn'), false);
  const functionProperties = template.Resources.Function.Properties;
  assert.equal(functionProperties.PackageType, 'Image');
  assert.deepEqual(functionProperties.Architectures, ['arm64']);
  assert.equal(functionProperties.Timeout, 30);
  assert.equal(functionProperties.TracingConfig.Mode.Ref, 'TracingMode');
  assert.equal(functionProperties.Code.ImageUri.Ref, 'ImageUri');
  assert.equal(template.Resources.Alias.Properties.Name, 'live');
  assert.equal(JSON.stringify(template).includes('AWS::ApiGateway::RestApi'), false);
  assert.equal(JSON.stringify(template).includes('AWS::Lambda::Permission'), false);
});

test('access Lambda image uses the managed runtime, production install and excludes tests from the artifact', () => {
  const dockerfile = readFileSync('access/Dockerfile', 'utf8');
  assert.match(dockerfile, /ARG NODE_BUILD_IMAGE[\s\S]*ARG LAMBDA_RUNTIME_IMAGE\s+FROM \$\{NODE_BUILD_IMAGE\}/);
  assert.match(dockerfile, /FROM \$\{NODE_BUILD_IMAGE\}[\s\S]*FROM \$\{LAMBDA_RUNTIME_IMAGE\}/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /rm -rf dist\/tests/);
  assert.match(dockerfile, /\/app\/dist\/billing\/contracts/);
  assert.doesNotMatch(dockerfile, /\/app\/dist \.\/dist/);
  assert.match(dockerfile, /dist\/access\/handler\.handler/);
  assert.match(readFileSync('infra/access/runtime.yaml', 'utf8'), /@sha256:\[a-f0-9\]/);
  assert.match(readFileSync('access/Dockerfile.dockerignore', 'utf8'), /node_modules/);
});
test('access templates use no cross-stack imports, so stack outputs reach other stacks only as parameters', () => {
  for (const file of ['auth.yaml', 'authorizer.yaml', 'publication.yaml', 'runtime.yaml', 'storage.yaml']) {
    assert.equal(readFileSync(`infra/access/${file}`, 'utf8').includes('ImportValue'), false, file);
  }
});

test('no access template declares a queue, pipe, dead-letter route, event-source mapping or replay schedule', () => {
  const forbidden = ['AWS::SQS::', 'AWS::Pipes::', 'AWS::Lambda::EventSourceMapping', 'AWS::Events::Rule', 'AWS::Scheduler::',
    'AWS::StepFunctions::', 'DeadLetterConfig', 'OnFailure', 'DestinationConfig', 'ScheduleExpression', 'EventSourceArn'];
  const templates = readdirSync('infra/access').filter(file => /\.(yaml|json)$/.test(file));
  assert.ok(templates.length >= 5, 'access templates must be present');
  for (const file of templates) {
    const text = readFileSync(`infra/access/${file}`, 'utf8');
    for (const token of forbidden) assert.equal(text.includes(token), false, `${file} must not contain ${token}`);
  }
});

test('access provisioning retries and budgets are finite and bounded', async () => {
  const { validateAccessBudgets } = await import('../../access/contracts/configuration.js');
  const budgets = { schema_version: 1, provisioning_budget_ms: 10_000, sdk_timeout_ms: 3_000, lease_seconds: 60,
    max_attempts: 5, backoff_min_ms: 2_000, backoff_max_ms: 30_000 };
  validateAccessBudgets(budgets);
  for (const change of [{ max_attempts: 0 }, { max_attempts: 1_000 }, { backoff_max_ms: 10_000_000 }, { provisioning_budget_ms: 1 }]) {
    assert.throws(() => validateAccessBudgets({ ...budgets, ...change }));
  }
});

test('signing key template creates one retained RSA 2048 signing key in KMS with no key material parameters', () => {
  const template = JSON.parse(readFileSync('infra/access/signing.yaml', 'utf8'));
  assert.equal(template.Parameters.SigningKeyJson, undefined);
  const key = template.Resources.SigningKey;
  assert.equal(key.Type, 'AWS::KMS::Key');
  assert.equal(key.DeletionPolicy, 'Retain');
  assert.equal(key.UpdateReplacePolicy, 'Retain');
  assert.equal(key.Properties.KeySpec, 'RSA_2048');
  assert.equal(key.Properties.KeyUsage, 'SIGN_VERIFY');
  assert.deepEqual(key.Properties.KeyPolicy.Statement.map((value: Record<string, unknown>) => value.Action), ['kms:*']);
  assert.equal(template.Resources.SigningKeyAliasResource.Type, 'AWS::KMS::Alias');
  assert.deepEqual(template.Outputs.SigningKeyArn.Value, { 'Fn::GetAtt': ['SigningKey', 'Arn'] });
  const text = JSON.stringify(template);
  assert.equal(text.includes('AWS::SSM::Parameter'), false);
  assert.equal(text.includes('secretsmanager'), false);
});

test('REST gateway: paid MCP and health are the only API-key methods, every route uses the intended alias, and HTTP API fields stay out', () => {
  const text = readFileSync('infra/access/gateway.yaml', 'utf8');
  const template = JSON.parse(text);
  for (const forbidden of ['ProtocolType', 'PayloadFormatVersion', 'AutoDeploy', 'AWS::Lambda::Url', 'FunctionUrl']) assert.equal(text.includes(forbidden), false);
  const plans = Object.entries(template.Resources).filter(([, value]: [string, any]) => value.Type === 'AWS::ApiGateway::UsagePlan') as [string, any][];
  assert.equal(plans.length, 1, 'exactly one usage plan, owned by the gateway stack');
  assert.deepEqual(plans[0]![1].Properties.ApiStages, [{ ApiId: { Ref: 'RestApi' }, Stage: { Ref: 'StageName' } }]);
  assert.equal(template.Outputs.BasicUsagePlanId.Value.Ref, plans[0]![0]);
  assert.deepEqual(plans[0]![1].Properties.Throttle, { RateLimit: 5, BurstLimit: 10 });
  assert.deepEqual(plans[0]![1].Properties.Quota, { Limit: 10000, Period: 'MONTH' });
  const methods = Object.entries(template.Resources).filter(([, value]: [string, any]) => value.Type === 'AWS::ApiGateway::Method') as [string, any][];
  assert.equal(methods.length, 26);
  const paid = methods.filter(([, value]) => value.Properties.AuthorizationType === 'CUSTOM').map(([name]) => name).sort();
  assert.deepEqual(paid, ['MHealth', 'MMcp']);
  for (const [name, value] of methods) {
    const properties = value.Properties;
    if (paid.includes(name)) { assert.equal(properties.ApiKeyRequired, true); assert.deepEqual(properties.AuthorizerId, { Ref: 'Authorizer' }); }
    else assert.equal(properties.ApiKeyRequired, undefined);
    assert.equal(properties.Integration.Type, 'AWS_PROXY');
    assert.equal(properties.Integration.TimeoutInMillis, 29000);
    assert.equal(properties.Integration.IntegrationHttpMethod, 'POST');
  }
  const aliasOf = (name: string) => JSON.stringify(template.Resources[name].Properties.Integration.Uri);
  assert.ok(aliasOf('MMcp').includes('${ServiceAliasArn}') && aliasOf('MHealth').includes('${ServiceAliasArn}'));
  assert.ok(aliasOf('MStripeWebhook').includes('${BillingWebhookAliasArn}'));
  for (const [name] of methods.filter(([name]) => !['MMcp', 'MHealth', 'MStripeWebhook'].includes(name))) assert.ok(aliasOf(name).includes('${AccessAliasArn}'), name);
  assert.deepEqual(template.Resources.Authorizer.Properties.Type, 'REQUEST');
  assert.equal(template.Resources.Authorizer.Properties.AuthorizerResultTtlInSeconds, 0);
  assert.equal(template.Resources.Authorizer.Properties.IdentitySource, 'method.request.header.Authorization');
  for (const name of ['AuthorizerInvokePermission', 'ServiceInvokePermission', 'AccessInvokePermission', 'BillingWebhookInvokePermission']) {
    assert.equal(template.Resources[name].Properties.Principal, 'apigateway.amazonaws.com');
    assert.deepEqual(template.Resources[name].Properties.SourceAccount, { Ref: 'AWS::AccountId' });
  }
  assert.equal(template.Resources.Stage.Properties.MethodSettings[0].DataTraceEnabled, false);
  assert.equal(template.Resources.Stage.Properties.MethodSettings[0].LoggingLevel, 'ERROR');
  assert.deepEqual([...template.Resources.Deployment.DependsOn].sort(), methods.map(([name]) => name).sort());
  assert.equal(template.Resources.GatewayUnauthorizedResponse.Properties.StatusCode, '401');
});

test('log groups for access functions and the gateway stage are owned by infra/observability, never duplicated here', () => {
  for (const file of ['infra/access/runtime.yaml', 'infra/access/authorizer.yaml', 'infra/access/gateway.yaml']) {
    const template = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.values(template.Resources).some((value: any) => value.Type === 'AWS::Logs::LogGroup'), false, file);
  }
  const gateway = JSON.parse(readFileSync('infra/access/gateway.yaml', 'utf8'));
  assert.deepEqual(gateway.Parameters.AccessLogGroupArn.Default, '');
  assert.deepEqual(gateway.Resources.Stage.Properties.AccessLogSetting, { 'Fn::If': ['HasAccessLog', { DestinationArn: { Ref: 'AccessLogGroupArn' }, Format: gateway.Resources.Stage.Properties.AccessLogSetting['Fn::If'][1].Format }, { Ref: 'AWS::NoValue' }] });
});
