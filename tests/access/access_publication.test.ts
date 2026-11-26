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
    'Fn::Sub': '${GithubSubjectPrefix}:environment:${AccessGithubEnvironment}',
  });
  assert.deepEqual(authorizerTrust.Condition.StringEquals['token.actions.githubusercontent.com:sub'], {
    'Fn::Sub': '${GithubSubjectPrefix}:environment:${AuthorizerGithubEnvironment}',
  });
  const prefix = template.Parameters.GithubSubjectPrefix;
  assert.equal(prefix.Default, undefined, 'subject prefix must be supplied, not defaulted');
  assert.match('repo:yechengshao@1/mcp-auth-subscriptions@2', new RegExp(prefix.AllowedPattern));
  assert.doesNotMatch('repo:yechengshao/mcp-auth-subscriptions', new RegExp(prefix.AllowedPattern));
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
    'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:CompleteLayerUpload', 'ecr:GetDownloadUrlForLayer', 'ecr:InitiateLayerUpload', 'ecr:PutImage', 'ecr:UploadLayerPart',
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
  }, {
    Effect: 'Allow',
    Action: 'ssm:PutParameter',
    Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/mcp/${Environment}/authorizer/artifact-*' },
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

test('access publication deploy inputs supply the immutable subject prefix and match the template', () => {
  const params = JSON.parse(readFileSync('infra/access/publication.params.json', 'utf8'));
  const prefix = params.find((p: { ParameterKey: string }) => p.ParameterKey === 'GithubSubjectPrefix');
  assert.ok(prefix, 'GithubSubjectPrefix must be supplied');
  assert.match(prefix.ParameterValue, new RegExp(template.Parameters.GithubSubjectPrefix.AllowedPattern));
});

test('access deploy inputs supply every required template parameter', () => {
  const params = JSON.parse(readFileSync('infra/access/publication.params.json', 'utf8'));
  const supplied = new Set(params.map((p: { ParameterKey: string }) => p.ParameterKey));
  for (const [name, def] of Object.entries<{ Default?: string }>(template.Parameters)) {
    if (def.Default === undefined) assert.ok(supplied.has(name), `${name} is required but not supplied`);
  }
});

test('access release evidence upload includes the hidden .artifacts directory', () => {
  const workflow = readFileSync('.github/workflows/publish-access-image.yml', 'utf8');
  assert.match(workflow, /path: \.artifacts\/access-release-\*\.json\n\s+include-hidden-files: true/);
});

test('access image is pushed as one ARM64 manifest without attestation manifests', () => {
  const workflow = readFileSync('.github/workflows/publish-access-image.yml', 'utf8');
  assert.match(workflow, /platforms: linux\/arm64\n\s+push: true\n\s+provenance: false\n\s+sbom: false/);
});

test('the access publisher may write only the tested image URI parameter, after the smoke test passes', () => {
  const statements = template.Resources.AccessPublisherRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements[2], {
    Effect: 'Allow', Action: 'ssm:PutParameter',
    Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/mcp/${Environment}/access/image-uri' },
  });
  const parameter = template.Resources.AccessImageUriParameter;
  assert.equal(parameter.Type, 'AWS::SSM::Parameter');
  assert.deepEqual(parameter.Properties.Name, { 'Fn::Sub': '/mcp/${Environment}/access/image-uri' });
  assert.equal(parameter.Properties.Value, 'unpublished');
  const workflow = readFileSync('.github/workflows/publish-access-image.yml', 'utf8');
  const smoke = workflow.indexOf('docker run --rm --platform linux/arm64');
  const write = workflow.indexOf('aws ssm put-parameter --region "$AWS_REGION" --name "/mcp/test/access/image-uri" --type String --value "$IMAGE_URI" --overwrite');
  const upload = workflow.indexOf('uses: actions/upload-artifact@v4');
  assert.ok(smoke > 0 && write > smoke && upload > write, 'smoke test, then SSM write, then upload');
});

test('the access runtime reads its image URI from SSM at deploy time', () => {
  const runtime = JSON.parse(readFileSync('infra/access/runtime.yaml', 'utf8'));
  assert.equal(runtime.Parameters.ImageUri.Type, 'AWS::SSM::Parameter::Value<String>');
  assert.equal(runtime.Parameters.ImageUri.Default, '/mcp/test/access/image-uri');
});
