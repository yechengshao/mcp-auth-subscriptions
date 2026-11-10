import { createHash } from 'node:crypto';
/** Keep old published versions verifiable and point aliases at a new version per image digest. */
export function immutableLambdaRelease(source: Record<string, any>, image: string) {
  if (!/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('digest_pinned_image_required');
  const template = structuredClone(source);
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
