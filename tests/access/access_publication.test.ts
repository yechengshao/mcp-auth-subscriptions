import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = JSON.parse(readFileSync('infra/access/publication.yaml', 'utf8'));

test('access and authorizer publishers use separate protected GitHub environments', () => {
  const accessTrust = template.Resources.AccessPublisherRole.Properties.AssumeRolePolicyDocument.Statement[0];
  const authorizerTrust = template.Resources.AuthorizerPublisherRole.Properties.AssumeRolePolicyDocument.Statement[0];
  for (const trust of [accessTrust, authorizerTrust]) {
    assert.deepEqual(trust.Principal.Federated, { Ref: 'GithubOidcProviderArn' });
    assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  }
  assert.deepEqual(accessTrust.Condition.StringEquals['token.actions.githubusercontent.com:sub'], {
    'Fn::Sub': 'repo:${GithubRepository}:environment:${AccessGithubEnvironment}',
  });
  assert.deepEqual(authorizerTrust.Condition.StringEquals['token.actions.githubusercontent.com:sub'], {
    'Fn::Sub': 'repo:${GithubRepository}:environment:${AuthorizerGithubEnvironment}',
  });
});

test('access publisher can push only to its immutable scanned ECR repository', () => {
  const repository = template.Resources.AccessRepository;
  assert.equal(repository.DeletionPolicy, 'Retain');
  assert.equal(repository.UpdateReplacePolicy, 'Retain');
  assert.equal(repository.Properties.ImageTagMutability, 'IMMUTABLE');
  assert.equal(repository.Properties.ImageScanningConfiguration.ScanOnPush, true);
  assert.equal(repository.Properties.LifecyclePolicy, undefined);
  const statements = template.Resources.AccessPublisherRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements[0], { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' });
  assert.deepEqual(statements[1].Resource, { 'Fn::GetAtt': ['AccessRepository', 'Arn'] });
  assert.deepEqual(statements[1].Action, [
    'ecr:BatchCheckLayerAvailability', 'ecr:CompleteLayerUpload', 'ecr:InitiateLayerUpload', 'ecr:PutImage', 'ecr:UploadLayerPart',
  ]);
});

test('authorizer publisher can only add immutable release objects under its S3 prefix', () => {
  const bucket = template.Resources.AuthorizerArtifactBucket;
  assert.equal(bucket.DeletionPolicy, 'Retain');
  assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
  });
  const statements = template.Resources.AuthorizerPublisherRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements, [{
    Effect: 'Allow',
    Action: 's3:PutObject',
    Resource: { 'Fn::Sub': '${AuthorizerArtifactBucket.Arn}/access/authorizer/*' },
  }]);
  assert.equal(JSON.stringify(template).includes('s3:DeleteObject'), false);
  assert.equal(JSON.stringify(template).includes('lambda:UpdateFunctionCode'), false);
});

test('Access release workflows are manual, main-only and keep publishing separate from deployment', () => {
  const imageWorkflow = readFileSync('.github/workflows/publish-access-image.yml', 'utf8');
  const authorizerWorkflow = readFileSync('.github/workflows/publish-authorizer-zip.yml', 'utf8');
  assert.match(imageWorkflow, /workflow_dispatch:/);
  assert.match(imageWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(imageWorkflow, /environment: access-publish/);
  assert.match(imageWorkflow, /platforms: linux\/arm64/);
  assert.match(imageWorkflow, /docker\/build-push-action@v6/);
  assert.match(imageWorkflow, /IMAGE_DIGEST/);
  assert.match(authorizerWorkflow, /workflow_dispatch:/);
  assert.match(authorizerWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(authorizerWorkflow, /environment: authorizer-publish/);
  assert.match(authorizerWorkflow, /npm run package:authorizer/);
  assert.match(authorizerWorkflow, /aws s3api put-object/);
  assert.match(authorizerWorkflow, /s3_version_id/);
  for (const workflow of [imageWorkflow, authorizerWorkflow]) {
    assert.doesNotMatch(workflow, /aws cloudformation deploy|lambda:UpdateFunctionCode|dynamodb:|aws lambda update-function-code/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
  }
});
