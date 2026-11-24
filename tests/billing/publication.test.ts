import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = JSON.parse(readFileSync('infra/billing/publication.yaml', 'utf8'));

test('billing publication role is restricted to the named GitHub environment and one ECR repository', () => {
  const role = template.Resources.BillingPublisherRole;
  const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Principal.Federated, { Ref: 'GithubOidcProviderArn' });
  assert.deepEqual(trust.Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  assert.deepEqual(trust.Condition.StringEquals['token.actions.githubusercontent.com:sub'], {
    'Fn::Sub': '${GithubSubjectPrefix}:environment:${GithubEnvironment}',
  });
  const prefix = template.Parameters.GithubSubjectPrefix;
  assert.equal(prefix.Default, undefined, 'subject prefix must be supplied, not defaulted');
  assert.match('repo:yechengshao@1/mcp-auth-subscriptions@2', new RegExp(prefix.AllowedPattern));
  assert.doesNotMatch('repo:yechengshao/mcp-auth-subscriptions', new RegExp(prefix.AllowedPattern));
  const statements = role.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements[0], { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' });
  assert.deepEqual(statements[1].Resource, { 'Fn::GetAtt': ['BillingRepository', 'Arn'] });
  assert.deepEqual(statements[1].Action, ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:CompleteLayerUpload', 'ecr:GetDownloadUrlForLayer', 'ecr:InitiateLayerUpload', 'ecr:PutImage', 'ecr:UploadLayerPart']);
  assert.equal(JSON.stringify(template).includes('lambda:UpdateFunctionCode'), false);
  assert.equal(JSON.stringify(template).includes('dynamodb:'), false);
  assert.equal(JSON.stringify(template).includes('s3:'), false);
});

test('billing release repository retains immutable scanned images and does not delete old versions', () => {
  const repository = template.Resources.BillingRepository;
  assert.equal(repository.DeletionPolicy, 'Retain');
  assert.equal(repository.UpdateReplacePolicy, 'Retain');
  assert.equal(repository.Properties.ImageTagMutability, 'IMMUTABLE');
  assert.equal(repository.Properties.ImageScanningConfiguration.ScanOnPush, true);
  assert.equal(repository.Properties.LifecyclePolicy, undefined);
  assert.equal(repository.Properties.EncryptionConfiguration.EncryptionType, 'AES256');
});

test('billing publication workflow is manual, main-only and OIDC scoped without deployment permissions', () => {
  const workflow = readFileSync('.github/workflows/publish-billing-image.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: billing-publish/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /platforms: linux\/arm64/);
  assert.match(workflow, /push: true/);
  assert.match(workflow, /IMAGE_DIGEST/);
  assert.doesNotMatch(workflow, /aws cloudformation deploy|lambda:UpdateFunctionCode|aws sts get-caller-identity/);
});

test('billing publication deploy inputs supply the immutable subject prefix and match the template', () => {
  const params = JSON.parse(readFileSync('infra/billing/publication.params.json', 'utf8'));
  const prefix = params.find((p: { ParameterKey: string }) => p.ParameterKey === 'GithubSubjectPrefix');
  assert.ok(prefix, 'GithubSubjectPrefix must be supplied');
  assert.match(prefix.ParameterValue, new RegExp(template.Parameters.GithubSubjectPrefix.AllowedPattern));
});

test('billing deploy inputs supply every required template parameter', () => {
  const params = JSON.parse(readFileSync('infra/billing/publication.params.json', 'utf8'));
  const supplied = new Set(params.map((p: { ParameterKey: string }) => p.ParameterKey));
  for (const [name, def] of Object.entries<{ Default?: string }>(template.Parameters)) {
    if (def.Default === undefined) assert.ok(supplied.has(name), `${name} is required but not supplied`);
  }
});
