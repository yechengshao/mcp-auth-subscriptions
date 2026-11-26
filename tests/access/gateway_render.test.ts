import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderGateway } from '../../infra/access/render-gateway.js';

const source = JSON.parse(readFileSync('infra/access/gateway.yaml', 'utf8'));

test('rendering gives the deployment a release-specific logical ID and points the stage at it', () => {
  const rendered = renderGateway(source, 'gateway-2026-11-26.2');
  assert.equal(Object.hasOwn(rendered.Resources, 'Deployment'), false, 'the shared logical ID is replaced');
  const id = 'Deployment' + 'gateway202611262';
  assert.ok(rendered.Resources[id], 'a new deployment resource is created for the release');
  assert.deepEqual(rendered.Resources.Stage.Properties.DeploymentId, { Ref: id });
  assert.equal(rendered.Resources[id].Properties.Description.Ref, 'ReleaseId');
});

test('the rendered deployment retains its snapshot when it leaves the template, so rollback targets survive', () => {
  const rendered = renderGateway(source, 'gateway-2026-11-26.2');
  const resource = rendered.Resources.Deployment ?? rendered.Resources.Deploymentgateway202611262;
  assert.equal(resource.DeletionPolicy, 'Retain');
  assert.equal(resource.UpdateReplacePolicy, 'Retain');
});

test('the rendered deployment keeps every method it depends on', () => {
  const rendered = renderGateway(source, 'gateway-2026-11-26.2');
  const resource = rendered.Resources.Deploymentgateway202611262;
  assert.deepEqual(resource.DependsOn, source.Resources.Deployment.DependsOn);
  assert.ok(resource.DependsOn.includes('MRegister'));
});

test('rendering does not change the source template', () => {
  const before = JSON.stringify(source);
  renderGateway(source, 'gateway-2026-11-26.3');
  assert.equal(JSON.stringify(source), before);
});

test('different releases give different logical IDs', () => {
  const first = Object.keys(renderGateway(source, 'gateway-2026-11-26.2').Resources).filter(key => key.startsWith('Deployment'));
  const second = Object.keys(renderGateway(source, 'gateway-2026-11-26.3').Resources).filter(key => key.startsWith('Deployment'));
  assert.deepEqual(first, ['Deploymentgateway202611262']);
  assert.deepEqual(second, ['Deploymentgateway202611263']);
});

test('release IDs with unsafe characters or empty cleaned names are rejected', () => {
  for (const bad of ['', '...', 'a b', 'gateway/2', 'x'.repeat(97), '---']) {
    assert.throws(() => renderGateway(source, bad), /invalid_release_id/, bad);
  }
});
