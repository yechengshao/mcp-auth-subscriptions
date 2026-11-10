import { immutableLambdaRelease } from '../immutable-release.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
/** Give each immutable image a distinct retained Lambda version resource for safe alias updates. */
export function releaseTemplate(image: string) {
  return immutableLambdaRelease(JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8')), image);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , image, output] = process.argv;
  if (!image || !output) throw new Error('usage: render:billing-runtime -- image-uri output-path');
  writeFileSync(output, JSON.stringify(releaseTemplate(image), null, 2) + '\n');
}
