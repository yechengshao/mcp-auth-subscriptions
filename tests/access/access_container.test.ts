import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = readFileSync('access/Dockerfile', 'utf8');
const ignore = readFileSync('access/Dockerfile.dockerignore', 'utf8').split('\n').map(line => line.trim());

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|js|mjs|json)$/.test(name) ? [path] : [];
  });
}

test('access image copies only the access runtime and its shared contracts into the final stage', () => {
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM ${LAMBDA_RUNTIME_IMAGE}'));
  const copies = finalStage.split('\n').filter(line => line.startsWith('COPY --from=build'));
  assert.deepEqual(copies.map(line => line.split(' ').at(-2)), [
    '/app/package.json', '/app/dist/access', '/app/dist/billing/contracts', '/app/dist/contracts',
    '/app/specs/003-billing-subscriptions/contracts/service-term.schema.json',
    '/app/dist/security', '/app/dist/observability', '/app/node_modules',
  ]);
  assert.doesNotMatch(finalStage, /COPY \. /);
});

test('access image build removes tests, scripts, infra and dev dependencies before the final stage', () => {
  assert.match(dockerfile, /rm -rf dist\/tests dist\/authorizer dist\/infra dist\/scripts/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /npm ci/);
});

test('build context excludes secret, credential and local-state files', () => {
  for (const pattern of ['.env', '.env.*', '*.pem', '*.key', 'secrets', '.aws', '.npmrc', '.git', 'node_modules']) {
    assert.ok(ignore.includes(pattern), `${pattern} must be excluded from the build context`);
  }
});

test('access runtime sources import no MCP, TradingView or card-processing code', () => {
  const roots = ['access', 'billing/contracts', 'security', 'observability'];
  const forbidden = [/tradingview/i, /modelcontextprotocol/, /tradingview_mcp/, /\bmcp\//, /card_number|\bcvc\b|sk_live|sk_test/i];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test('access image pins both base images through build arguments with no mutable defaults', () => {
  assert.match(dockerfile, /^ARG NODE_BUILD_IMAGE$/m);
  assert.match(dockerfile, /^ARG LAMBDA_RUNTIME_IMAGE$/m);
  assert.doesNotMatch(dockerfile, /^ARG \w+=/m);
  assert.doesNotMatch(dockerfile, /FROM (node|public\.ecr\.aws)[^$]*:(latest|\d+)\s*$/m);
});
