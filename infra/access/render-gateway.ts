import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Renders the gateway template for one release. The source template has a single `Deployment` resource;
 * CloudFormation only creates a new API Gateway snapshot when that resource is new, so each release gets its
 * own logical ID derived from the ReleaseId. The stage moves to it in the same update. The old snapshot is
 * retained for rollback, because a retained resource is not deleted when it leaves the template.
 */
export function renderGateway(source: any, releaseId: string): any {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(releaseId)) throw new Error('invalid_release_id');
  const suffix = releaseId.replace(/[^A-Za-z0-9]/g, '');
  if (!suffix) throw new Error('invalid_release_id');
  const logicalId = `Deployment${suffix}`;
  const template = structuredClone(source);
  const deployment = template.Resources?.Deployment;
  const stage = template.Resources?.Stage;
  if (!deployment || !stage) throw new Error('gateway_template_missing_deployment_or_stage');
  if (Object.hasOwn(template.Resources, logicalId)) throw new Error('deployment_logical_id_already_exists');
  delete template.Resources.Deployment;
  template.Resources[logicalId] = { ...deployment, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
  stage.Properties.DeploymentId = { Ref: logicalId };
  return template;
}

function main(): void {
  const releaseId = process.argv[2];
  if (!releaseId) throw new Error('usage: render-gateway <ReleaseId>');
  const root = process.cwd();
  const source = JSON.parse(readFileSync(join(root, 'infra/access/gateway.yaml'), 'utf8'));
  const output = join(root, 'infra/access/rendered', `gateway-${releaseId}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(renderGateway(source, releaseId), null, 2) + '\n');
  process.stdout.write(output + '\n');
}

if (process.argv[1]?.endsWith('render-gateway.js')) main();
