import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoredZip, type ZipEntry } from './zip.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const compiledDirectories = ['authorizer', 'security', 'observability'];

function collectFiles(directory: string, extension?: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path, extension);
    return entry.isFile() && (!extension || entry.name.endsWith(extension)) ? [path] : [];
  });
}

function digestFiles(files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    hash.update(relative(repositoryRoot, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function dependencyVersion(path: string): string {
  return JSON.parse(readFileSync(path, 'utf8')).version as string;
}

export function packageAuthorizer(outputPath = '.artifacts/authorizer.zip') {
  const output = resolve(repositoryRoot, outputPath);
  const authorizerManifestPath = join(repositoryRoot, 'authorizer/package.json');
  const authorizerLockPath = join(repositoryRoot, 'authorizer/package-lock.json');
  const rootLockPath = join(repositoryRoot, 'package-lock.json');
  const authorizerManifest = JSON.parse(readFileSync(authorizerManifestPath, 'utf8')) as { name: string; version: string; dependencies: Record<string, string> };
  const authorizerLock = JSON.parse(readFileSync(authorizerLockPath, 'utf8')) as { packages: Record<string, { version?: string }> };
  const lockedJose = authorizerLock.packages['node_modules/jose']?.version;
  const rootLockedJose = JSON.parse(readFileSync(rootLockPath, 'utf8')).packages['node_modules/jose']?.version as string | undefined;
  const installedJosePath = join(repositoryRoot, 'node_modules/jose');
  const installedJose = dependencyVersion(join(installedJosePath, 'package.json'));
  if (Object.keys(authorizerManifest.dependencies).join(',') !== 'jose' ||
      authorizerManifest.dependencies.jose !== lockedJose || rootLockedJose !== lockedJose || installedJose !== lockedJose) {
    throw new Error('authorizer_dependency_lock_mismatch');
  }

  for (const directory of compiledDirectories) {
    if (!statSync(join(repositoryRoot, 'dist', directory), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`authorizer_build_output_missing:${directory}`);
    }
  }

  const sourceFiles = ['authorizer', 'security', 'observability']
    .flatMap(directory => collectFiles(join(repositoryRoot, directory), '.ts'))
    .concat(join(repositoryRoot, 'contracts/patterns.ts'));
  const buildConfigFiles = [
    join(repositoryRoot, 'package.json'), rootLockPath, join(repositoryRoot, 'tsconfig.json'),
    authorizerManifestPath, authorizerLockPath,
  ];
  const provenance = {
    schemaVersion: 1,
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    handler: 'authorizer/handler.handler',
    sourceSha256: digestFiles(sourceFiles),
    authorizerLockSha256: createHash('sha256').update(readFileSync(authorizerLockPath)).digest('hex'),
    buildConfigSha256: digestFiles(buildConfigFiles),
    dependency: { name: 'jose', version: lockedJose },
  };

  const entries: ZipEntry[] = [];
  for (const directory of compiledDirectories) {
    for (const path of collectFiles(join(repositoryRoot, 'dist', directory), '.js')) {
      entries.push({ name: relative(join(repositoryRoot, 'dist'), path).replaceAll('\\', '/'), data: readFileSync(path) });
    }
  }
  const sharedPatterns = join(repositoryRoot, 'dist/contracts/patterns.js');
  if (!statSync(sharedPatterns, { throwIfNoEntry: false })?.isFile()) throw new Error('authorizer_build_output_missing:contracts/patterns.js');
  entries.push({ name: 'contracts/patterns.js', data: readFileSync(sharedPatterns) });
  const joseRuntimeDir = join(installedJosePath, 'dist/webapi');
  for (const path of collectFiles(joseRuntimeDir, '.js')) {
    entries.push({ name: `node_modules/${relative(join(repositoryRoot, 'node_modules'), path).replaceAll('\\', '/')}`, data: readFileSync(path) });
  }
  for (const file of ['package.json', 'LICENSE.md']) {
    const path = join(installedJosePath, file);
    entries.push({ name: `node_modules/jose/${file}`, data: readFileSync(path) });
  }

  const runtimeManifest = {
    name: authorizerManifest.name,
    version: authorizerManifest.version,
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    dependencies: { jose: lockedJose },
  };
  entries.push({ name: 'package.json', data: `${JSON.stringify(runtimeManifest, null, 2)}\n` });
  entries.push({ name: 'META-INF/authorizer-build.json', data: `${JSON.stringify(provenance, null, 2)}\n` });

  const archive = createStoredZip(entries);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, archive);
  chmodSync(output, 0o644);
  const packageHash = createHash('sha256').update(archive).digest();
  const evidence = {
    ...provenance,
    packageSha256Hex: packageHash.toString('hex'),
    packageSha256Base64: packageHash.toString('base64'),
    packageBytes: archive.length,
  };
  writeFileSync(`${output}.metadata.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return { output, ...evidence };
}
