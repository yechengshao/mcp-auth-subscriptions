import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoTag = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export interface AccessImageBuild {
  buildImage: string;
  runtimeImage: string;
  tag: string;
}

export function accessImageBuild(argv: string[]): AccessImageBuild {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key || !value || !['--build-image', '--runtime-image', '--tag'].includes(key) || args[key]) {
      throw new Error('usage: package:access-image --build-image node:24-bookworm-slim@sha256:<64-hex> --runtime-image public.ecr.aws/lambda/nodejs:24@sha256:<64-hex> --tag access-local:<tag>');
    }
    args[key] = value;
  }
  const buildImage = args['--build-image']!, runtimeImage = args['--runtime-image']!, tag = args['--tag']!;
  if (!/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/.test(buildImage) ||
      !/^public\.ecr\.aws\/lambda\/nodejs:24@sha256:[a-f0-9]{64}$/.test(runtimeImage) || !repoTag.test(tag)) {
    throw new Error('immutable_node24_arm64_images_required');
  }
  return { buildImage, runtimeImage, tag };
}

export function accessImageBuildArgs(input: AccessImageBuild): string[] {
  // Validate even callers that did not come through the CLI parser.
  const validated = accessImageBuild(['--build-image', input.buildImage, '--runtime-image', input.runtimeImage, '--tag', input.tag]);
  return ['buildx', 'build', '--platform', 'linux/arm64', '--load',
    '--build-arg', `NODE_BUILD_IMAGE=${validated.buildImage}`,
    '--build-arg', `LAMBDA_RUNTIME_IMAGE=${validated.runtimeImage}`,
    '--tag', validated.tag, '--file', 'access/Dockerfile', '.'];
}

function digestTree(root: string, paths: string[]): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
    }
  };
  for (const path of paths) visit(join(root, path));
  files.push(...['package.json', 'package-lock.json', 'tsconfig.json', 'access/Dockerfile', 'access/Dockerfile.dockerignore',
    'infra/access/runtime.yaml'].map(path => join(root, path)));
  for (const file of [...new Set(files)].sort()) {
    hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function buildAccessImage(input: AccessImageBuild, root = process.cwd()): string {
  const args = accessImageBuildArgs(input);
  const build = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (build.error || build.status !== 0) throw new Error('access_image_build_failed');
  const inspect = spawnSync('docker', ['image', 'inspect', input.tag, '--format', '{{.Id}}'], { cwd: root, encoding: 'utf8' });
  const imageId = inspect.status === 0 ? inspect.stdout.trim() : '';
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('access_image_digest_unavailable');
  const artifact = { schema_version: 1, platform: 'linux/arm64', tag: input.tag, image_id: imageId,
    build_image: input.buildImage, runtime_image: input.runtimeImage,
    source_sha256: digestTree(root, ['access', 'contracts', 'security', 'observability', 'billing/contracts']),
    lock_sha256: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex'),
    runtime_template_sha256: createHash('sha256').update(readFileSync(join(root, 'infra/access/runtime.yaml'))).digest('hex') };
  const path = join(root, '.artifacts', `access-image-${imageId.slice(7, 19)}.json`);
  mkdirSync(join(root, '.artifacts'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = buildAccessImage(accessImageBuild(process.argv.slice(2)));
  process.stdout.write(`Local access image build evidence: ${output}\n`);
}
