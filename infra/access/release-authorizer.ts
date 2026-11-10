import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { immutableLambdaRelease } from '../immutable-release.js';
export function authorizerRelease(image: string) {
  return immutableLambdaRelease(JSON.parse(readFileSync('infra/access/authorizer.yaml', 'utf8')), image);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , image, output] = process.argv;
  if (!image || !output) throw new Error('usage: render:authorizer -- image-uri output-path');
  writeFileSync(output, JSON.stringify(authorizerRelease(image), null, 2) + '\n');
}
