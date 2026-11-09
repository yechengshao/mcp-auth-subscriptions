import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
/** Give each immutable image a distinct retained Lambda version resource for safe alias updates. */
export function releaseTemplate(image: string) {
  if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('digest_pinned_image_required');
  const template = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8'));
  const release = createHash('sha256').update(image).digest('hex').slice(0, 24);
  const version = `Version${release}`;
  template.Resources[version] = template.Resources.Version;
  template.Resources[version].Properties.Description = release;
  delete template.Resources.Version;
  template.Resources.Alias.Properties.FunctionVersion = { 'Fn::GetAtt': [version, 'Version'] };
  template.Parameters.ImageUri.Default = image;
  template.Parameters.ReleaseId.Default = release;
  return template;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , image, output] = process.argv;
  if (!image || !output) throw new Error('usage: render:billing-runtime -- image-uri output-path');
  writeFileSync(output, JSON.stringify(releaseTemplate(image), null, 2) + '\n');
}
