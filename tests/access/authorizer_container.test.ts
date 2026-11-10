import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('authorizer runtime manifest is isolated from signing, data, billing and framework SDKs', () => {
  const manifest = JSON.parse(readFileSync('authorizer/package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('authorizer/package-lock.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['jose']);
  assert.equal(lock.packages['node_modules/jose'].version, manifest.dependencies.jose);
  const source = readFileSync('authorizer/Dockerfile', 'utf8').split('FROM ${LAMBDA_IMAGE}')[1]!;
  for (const forbidden of ['dist/access', 'dist/billing', 'tests/', 'smoke.mjs', 'SSM', 'Stripe']) assert.equal(source.includes(forbidden), false);
  assert.ok(source.includes('dist/security')); assert.ok(source.includes('dist/authorizer/handler.handler'));
});
test('billing image keeps the new service-token signing dependency outside its runtime', () => {
  const manifest = JSON.parse(readFileSync('billing/package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('billing/package-lock.json', 'utf8'));
  assert.equal(manifest.dependencies.jose, undefined);
  assert.equal(lock.packages['node_modules/jose'], undefined);
  const source = readFileSync('Dockerfile.billing', 'utf8');
  assert.ok(source.includes('COPY --from=dependencies /app/node_modules'));
  const runtime = source.split('FROM ${LAMBDA_IMAGE}')[1]!;
  assert.equal(runtime.includes('dist/security'), false);
  assert.ok(runtime.includes('dist/contracts'), 'billing runtime must include its shared contract modules');
});
