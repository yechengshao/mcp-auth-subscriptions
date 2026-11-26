import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync('.github/workflows/test-access.yml', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
test('the isolated access job fails without lockfiles and runs only the access suites before packaging the authorizer', () => {
  const access = job('access');
  assert.ok(access.includes('test -f package-lock.json && test -f authorizer/package-lock.json'));
  assert.ok(access.includes('run: npm run check:access'));
  assert.equal(/run: npm run check\s*$/m.test(access), false, 'the access job must not run the full suite');
  const order = ['npm ci\n', 'npm run check:access', 'npm ci --prefix authorizer --omit=dev', 'npm run package:authorizer', 'unzip -t .artifacts/authorizer.zip', 'cfn-lint infra/access/*.yaml'];
  let position = -1;
  for (const step of order) { const next = access.indexOf(step, position + 1); assert.ok(next > position, `${step} is missing or out of order`); position = next; }
});
test('the full job keeps billing and observability checks in CI', () => {
  const full = job('full');
  assert.ok(/run: npm run check\s*$/m.test(full));
  assert.ok(full.includes('cfn-lint infra/observability/template.json infra/observability/alarm-topic.yaml infra/billing/*.yaml infra/access/*.yaml'));
});
test('check:access covers exactly the access test directory and typechecks first', () => {
  assert.equal(packageJson.scripts['check:access'], 'npm run typecheck && npm run test:access');
  assert.ok(packageJson.scripts['test:access']!.includes('dist/tests/access/*.test.js'));
  assert.equal(packageJson.scripts['test:access']!.includes('tests/billing'), false);
});

test('the constitution records the Service Decoupling principle and its current version', () => {
  const constitution = readFileSync('.specify/memory/constitution.md', 'utf8');
  assert.ok(constitution.includes('### Service Decoupling'));
  assert.ok(constitution.includes('**Version**: 1.8.0'));
  assert.ok(constitution.includes('- **1.7.0 — 2026-11-25**'));
  assert.ok(constitution.includes('- **Deploy inputs are minimal.**'));
  assert.ok(constitution.includes('- **1.8.0 — 2026-11-26**'));
});
