import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const imageTagPattern = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface BillingImageBuild {
  buildImage: string;
  runtimeImage: string;
  tag: string;
}

export function billingImageBuild(argv: string[]): BillingImageBuild {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key || !value || !['--build-image', '--runtime-image', '--tag'].includes(key) || values[key]) {
      throw new Error('usage: package:billing-image --build-image node:24-bookworm-slim@sha256:<64-hex> --runtime-image public.ecr.aws/lambda/nodejs:24@sha256:<64-hex> --tag billing-local:<tag>');
    }
    values[key] = value;
  }
  const buildImage = values['--build-image']!, runtimeImage = values['--runtime-image']!, tag = values['--tag']!;
  if (!/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/.test(buildImage) ||
      !/^public\.ecr\.aws\/lambda\/nodejs:24@sha256:[a-f0-9]{64}$/.test(runtimeImage) || !imageTagPattern.test(tag)) {
    throw new Error('immutable_node24_arm64_images_required');
  }
  return { buildImage, runtimeImage, tag };
}

export function billingImageBuildArgs(input: BillingImageBuild): string[] {
  const validated = billingImageBuild(['--build-image', input.buildImage, '--runtime-image', input.runtimeImage, '--tag', input.tag]);
  return ['buildx', 'build', '--platform', 'linux/arm64', '--load',
    '--build-arg', `BUILD_IMAGE=${validated.buildImage}`,
    '--build-arg', `LAMBDA_IMAGE=${validated.runtimeImage}`,
    '--tag', validated.tag, '--file', 'Dockerfile.billing', '.'];
}

function sourceDigest(root: string): string {
  const files = new Set<string>();
  for (const path of ['billing', 'contracts', 'observability']) {
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && (file.endsWith('.ts') || file.endsWith('.json'))) files.add(file);
      }
    };
    visit(join(root, path));
  }
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'billing/package.json', 'billing/package-lock.json',
    'Dockerfile.billing', '.dockerignore', 'infra/billing/runtime.yaml', 'infra/billing/release.ts',
    'specs/003-billing-subscriptions/contracts/service-term.schema.json']) files.add(join(root, path));
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

export function buildBillingImage(input: BillingImageBuild, root = process.cwd()): string {
  const args = billingImageBuildArgs(input);
  const build = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (build.error || build.status !== 0) throw new Error('billing_image_build_failed');
  const inspect = spawnSync('docker', ['image', 'inspect', input.tag, '--format', '{{.Id}}'], { cwd: root, encoding: 'utf8' });
  const imageId = inspect.status === 0 ? inspect.stdout.trim() : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('billing_image_digest_unavailable');
  const evidence = {
    schema_version: 1,
    component: 'billing',
    platform: 'linux/arm64',
    tag: input.tag,
    local_image_id: imageId,
    build_image: input.buildImage,
    runtime_image: input.runtimeImage,
    source_sha256: sourceDigest(root),
    root_lock_sha256: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex'),
    billing_lock_sha256: createHash('sha256').update(readFileSync(join(root, 'billing/package-lock.json'))).digest('hex'),
    runtime_template_sha256: createHash('sha256').update(readFileSync(join(root, 'infra/billing/runtime.yaml'))).digest('hex'),
    ecr_manifest_digest: null,
  };
  const directory = join(root, '.artifacts');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `billing-image-${imageId.slice(7, 19)}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = buildBillingImage(billingImageBuild(process.argv.slice(2)));
  process.stdout.write(`Local billing image evidence: ${output}\n`);
}
