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

test('billing publish workflow pushes one ARM64 image without attestations and smoke-tests the pushed digest', () => {
  const workflow = readFileSync('.github/workflows/publish-billing-image.yml', 'utf8');
  assert.ok(workflow.includes('platforms: linux/arm64'));
  assert.ok(workflow.includes('provenance: false') && workflow.includes('sbom: false'));
  const smoke = workflow.slice(workflow.indexOf('- name: Smoke test the pushed ARM64 image'), workflow.indexOf('- name: Write immutable release evidence'));
  assert.ok(smoke.includes('--platform linux/arm64'));
  assert.ok(smoke.includes('${{ steps.build.outputs.digest }}'));
  assert.ok(smoke.includes("import('file:///var/task/dist/billing/handler.js')"));
  assert.ok(smoke.includes('process.exit(1)'));
});

test('billing release evidence records source, lock, Dockerfile, template, base image and pushed digest identity', () => {
  const workflow = readFileSync('.github/workflows/publish-billing-image.yml', 'utf8');
  const evidence = workflow.slice(workflow.indexOf('- name: Write immutable release evidence'), workflow.indexOf('- uses: actions/upload-artifact@v4'));
  for (const field of ['source_commit', 'image_uri', 'base_images', 'node_build', 'lambda_runtime', 'root_lock_sha256', 'billing_lock_sha256', 'dockerfile_sha256', 'runtime_template_sha256']) {
    assert.ok(evidence.includes(field), `evidence field ${field}`);
  }
  assert.ok(evidence.includes('NODE_BUILD_IMAGE: ${{ vars.NODE_BUILD_IMAGE }}'));
  assert.ok(evidence.includes('LAMBDA_RUNTIME_IMAGE: ${{ vars.LAMBDA_RUNTIME_IMAGE }}'));
});

test('billing and access publish paths share one configuration: attestations off, hidden evidence uploaded, same inputs, base pins and ARM64 smoke test', () => {
  const billing = readFileSync('.github/workflows/publish-billing-image.yml', 'utf8');
  const access = readFileSync('.github/workflows/publish-access-image.yml', 'utf8');
  for (const [name, workflow] of [['billing', billing], ['access', access]] as const) {
    assert.ok(workflow.includes('provenance: false') && workflow.includes('sbom: false'), `${name} attestations`);
    assert.ok(workflow.includes('platforms: linux/arm64'), `${name} platform`);
    assert.ok(workflow.includes('include-hidden-files: true'), `${name} evidence upload`);
    assert.ok(workflow.includes('NODE_BUILD_IMAGE=${{ vars.NODE_BUILD_IMAGE }}'), `${name} node build arg`);
    assert.ok(workflow.includes('LAMBDA_RUNTIME_IMAGE=${{ vars.LAMBDA_RUNTIME_IMAGE }}'), `${name} lambda build arg`);
    assert.ok(/nodejs:24-arm64@sha256:\[a-f0-9\]\{64\}\$/.test(workflow), `${name} base pin is the arm64 platform digest`);
    assert.ok(workflow.includes('--entrypoint /var/lang/bin/node'), `${name} smoke entrypoint`);
    assert.ok(workflow.includes('- name: Smoke test the pushed ARM64 image'), `${name} smoke step`);
  }
  assert.ok(/\^billing-\[/.test(billing) && /\^access-\[/.test(access), 'release tags require the component prefix');
  for (const file of ['Dockerfile.billing', 'access/Dockerfile']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /^ARG NODE_BUILD_IMAGE$/m, file);
    assert.match(source, /^ARG LAMBDA_RUNTIME_IMAGE$/m, file);
  }
});
