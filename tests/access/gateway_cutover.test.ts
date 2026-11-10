import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGatewayCutover, type GatewayCutoverInput } from '../../scripts/prepare_gateway_cutover.js';

const arn = (name: string, alias: string) => `arn:aws:lambda:us-east-1:123456789012:function:${name}:${alias}`;
const service = arn('mcp-service', 'live');
const access = arn('access-service', 'live');
const billing = arn('billing-service', 'live');
const authorizer = arn('access-authorizer', 'live');
const base: GatewayCutoverInput = {
  schema_version: 1,
  environment: 'prod',
  legacy_http: { api_id: 'abcdefghij', endpoint: 'https://abcdefghij.execute-api.us-east-1.amazonaws.com',
    stage: '$default', secured: true, retained: true },
  target_rest: {
    api_id: 'klmnopqrst', endpoint: 'https://klmnopqrst.execute-api.us-east-1.amazonaws.com/prod',
    stage: 'prod', deployment_id: 'deployment_fixture',
    aliases: { service, access, billing, authorizer },
    routes: [
      { path: '/mcp', method: 'ANY', owner: 'service', alias_arn: service, authorizer: true, api_key_required: true },
      { path: '/health', method: 'GET', owner: 'service', alias_arn: service, authorizer: true, api_key_required: true },
      { path: '/authorize', method: 'GET', owner: 'access', alias_arn: access, authorizer: false, api_key_required: false },
      { path: '/webhooks/stripe', method: 'POST', owner: 'billing', alias_arn: billing, authorizer: false, api_key_required: false },
    ],
  },
  rollback: { client_config_backup_sha256: 'a'.repeat(64),
    legacy_security_restore_plan: 'restore secured legacy deployment and endpoint configuration', rollback_owner: 'release_manager' },
};

test('cutover preparation validates distinct APIs, exact alias ownership and the protected REST core, but executes nothing', () => {
  const result = prepareGatewayCutover(base);
  assert.equal(result.mode, 'read_only_cutover_preflight');
  assert.equal(result.cutover_executed, false);
  assert.equal(result.cloud_state_independently_verified, false);
  assert.equal(result.manual_review_required, true);
  assert.equal(result.legacy_endpoint.api_id, 'abcdefghij');
  assert.equal(result.target_endpoint.api_id, 'klmnopqrst');
});

test('cutover preparation rejects gateway/resource conflicts, wrong-owner aliases and unsafe rollback inputs', () => {
  const duplicate = structuredClone(base); duplicate.target_rest.routes.push(structuredClone(duplicate.target_rest.routes[0]!));
  assert.throws(() => prepareGatewayCutover(duplicate), /invalid_gateway_cutover_manifest/);

  const wrongOwner = structuredClone(base); wrongOwner.target_rest.routes[2]!.alias_arn = billing;
  assert.throws(() => prepareGatewayCutover(wrongOwner), /invalid_gateway_cutover_manifest/);

  const catchAll = structuredClone(base); catchAll.target_rest.routes.push({ path: '/{proxy+}', method: 'ANY', owner: 'access',
    alias_arn: access, authorizer: false, api_key_required: false });
  assert.throws(() => prepareGatewayCutover(catchAll), /invalid_gateway_cutover_manifest/);

  const sameApi = structuredClone(base); sameApi.target_rest.api_id = sameApi.legacy_http.api_id;
  assert.throws(() => prepareGatewayCutover(sameApi), /invalid_gateway_cutover_manifest/);

  const wrongEndpoint = structuredClone(base); wrongEndpoint.target_rest.endpoint = 'https://wrongapi.execute-api.us-east-1.amazonaws.com/prod';
  assert.throws(() => prepareGatewayCutover(wrongEndpoint), /invalid_gateway_cutover_manifest/);

  const unsecured = structuredClone(base); unsecured.legacy_http.secured = false;
  assert.throws(() => prepareGatewayCutover(unsecured), /invalid_gateway_cutover_manifest/);

  const missingRollback = structuredClone(base); missingRollback.rollback.client_config_backup_sha256 = 'not-a-digest';
  assert.throws(() => prepareGatewayCutover(missingRollback), /invalid_gateway_cutover_manifest/);
});
