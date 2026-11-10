import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha256Base64 = /^[A-Za-z0-9+/]{43}=$/;
const s3Bucket = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function authorizerRelease(artifactBucket: string, artifactKey: string, artifactVersion: string, packageSha256: string) {
  if (!s3Bucket.test(artifactBucket) || !artifactKey || artifactKey.length > 1024 ||
      !artifactVersion || artifactVersion.length > 1024 || !sha256Base64.test(packageSha256)) {
    throw new Error('immutable_authorizer_zip_required');
  }

  const source = JSON.parse(readFileSync('infra/access/authorizer.yaml', 'utf8')) as Record<string, any>;
  const template = structuredClone(source);
  const release = createHash('sha256')
    .update(JSON.stringify([artifactBucket, artifactKey, artifactVersion, packageSha256]))
    .digest('hex').slice(0, 24);
  const versionName = `Version${release}`;

  template.Resources[versionName] = structuredClone(template.Resources.Version);
  template.Resources[versionName].Properties.Description = release;
  delete template.Resources.Version;
  template.Resources.Alias.Properties.FunctionVersion = { 'Fn::GetAtt': [versionName, 'Version'] };
  template.Parameters.ArtifactBucket.Default = artifactBucket;
  template.Parameters.ArtifactKey.Default = artifactKey;
  template.Parameters.ArtifactVersion.Default = artifactVersion;
  template.Parameters.PackageSha256.Default = packageSha256;
  template.Parameters.ReleaseId.Default = release;
  return template;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , artifactBucket, artifactKey, artifactVersion, packageSha256, output] = process.argv;
  if (!artifactBucket || !artifactKey || !artifactVersion || !packageSha256 || !output) {
    throw new Error('usage: render:authorizer -- artifact-bucket artifact-key artifact-version package-sha256-base64 output-path');
  }
  writeFileSync(output, JSON.stringify(authorizerRelease(artifactBucket, artifactKey, artifactVersion, packageSha256), null, 2) + '\n');
}
