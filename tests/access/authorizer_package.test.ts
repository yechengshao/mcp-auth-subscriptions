import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageAuthorizer } from '../../infra/access/package-authorizer.js';
import { authorizerRelease } from '../../infra/access/release-authorizer.js';
import { readStoredZip } from '../../infra/access/zip.js';

test('authorizer template deploys a managed Node.js ZIP and pins immutable artifact inputs', () => {
  const packageSha256 = Buffer.alloc(32, 7).toString('base64');
  const rendered = authorizerRelease('mcp-release-artifacts', 'authorizer/test/0123.zip', 'version-123', packageSha256);
  const fn = rendered.Resources.Function.Properties;
  assert.equal(fn.Runtime, 'nodejs24.x');
  assert.equal(fn.Handler, 'authorizer/handler.handler');
  assert.deepEqual(fn.Architectures, ['arm64']);
  assert.equal(fn.PackageType, undefined);
  assert.deepEqual(fn.Code, {
    S3Bucket: { Ref: 'ArtifactBucket' },
    S3Key: { Ref: 'ArtifactKey' },
    S3ObjectVersion: { Ref: 'ArtifactVersion' },
  });
  assert.equal(rendered.Parameters.ArtifactBucket.Default, 'mcp-release-artifacts');
  assert.equal(rendered.Parameters.ArtifactKey.Default, 'authorizer/test/0123.zip');
  assert.equal(rendered.Parameters.ArtifactVersion.Default, 'version-123');
  const versionName = Object.keys(rendered.Resources).find(name => /^Version[0-9a-f]{24}$/.test(name));
  assert.ok(versionName);
  assert.deepEqual(rendered.Resources[versionName!].Properties.CodeSha256, { Ref: 'PackageSha256' });
  assert.equal(rendered.Parameters.PackageSha256.Default, packageSha256);
  assert.deepEqual(rendered.Resources.Alias.Properties.FunctionVersion, { 'Fn::GetAtt': [versionName, 'Version'] });
  assert.throws(() => authorizerRelease('bad/bucket', 'key.zip', 'version', packageSha256), /immutable_authorizer_zip_required/);
  assert.throws(() => authorizerRelease('mcp-release-artifacts', 'key.zip', 'version', 'not-a-hash'), /immutable_authorizer_zip_required/);
});

test('authorizer ZIP is lean, carries checksums, and executes its real Lambda handler', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'authorizer-package-test-'));
  const archive = join(workspace, 'authorizer.zip');
  const extracted = join(workspace, 'extracted');
  const extractedRoot = resolve(extracted);
  const previousEnvironment = { ...process.env };
  const previousFetch = globalThis.fetch;

  try {
    const packageResult = packageAuthorizer(archive);
    const archiveBytes = readFileSync(archive);
    const packaged = readStoredZip(archiveBytes);
    const names = [...packaged.keys()];
    for (const required of ['authorizer/handler.js', 'security/service-token.js', 'contracts/patterns.js', 'observability/telemetry.js', 'node_modules/jose/package.json', 'META-INF/authorizer-build.json', 'package.json']) {
      assert.ok(packaged.has(required), `missing ZIP entry ${required}`);
    }
    assert.equal(packaged.has('contracts/schema.js'), false, 'authorizer must not pull in AJV-backed schemas');
    assert.equal(names.some(name => name.startsWith('node_modules/ajv/')), false, 'authorizer ZIP must stay free of AJV');
    for (const entry of names) {
      assert.equal(entry.startsWith('access/'), false);
      assert.equal(entry.startsWith('billing/'), false);
      assert.equal(entry.startsWith('tests/'), false);
      assert.equal(entry.endsWith('.ts'), false);
      assert.equal(entry.endsWith('package-lock.json'), false);
    }

    const evidence = JSON.parse(readFileSync(`${archive}.metadata.json`, 'utf8'));
    const actualDigest = createHash('sha256').update(archiveBytes).digest();
    assert.equal(evidence.packageSha256Hex, actualDigest.toString('hex'));
    assert.equal(evidence.packageSha256Base64, actualDigest.toString('base64'));
    assert.equal(packageResult.packageSha256Hex, evidence.packageSha256Hex);
    assert.equal(evidence.runtime, 'nodejs24.x');
    assert.equal(evidence.architecture, 'arm64');
    assert.equal(evidence.dependency.name, 'jose');
    assert.equal(evidence.dependency.version, '6.2.17');
    assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.authorizerLockSha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.buildConfigSha256, /^[a-f0-9]{64}$/);
    assert.ok(evidence.packageBytes > 0);

    const secondArchive = join(workspace, 'authorizer-repeat.zip');
    assert.equal(packageAuthorizer(secondArchive).packageSha256Hex, evidence.packageSha256Hex, 'ZIP output must be reproducible for identical inputs');
    for (const [name, data] of packaged) {
      const target = resolve(extractedRoot, name);
      assert.ok(target.startsWith(`${extractedRoot}${sep}`), 'ZIP paths must remain under extraction root');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }

    process.env.AUTHORIZER_CONFIG = JSON.stringify({
      issuer: 'https://login.example.invalid/test', resource: 'https://api.example.invalid/test/mcp',
      clientIds: ['fixture_host'], clockSkewSeconds: 0, accountId: '000000000000', region: 'us-east-1',
      apiId: 'fixtureapi', stage: 'test', routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }],
    });
    process.env.SERVICE_JWKS_URI = 'https://login.example.invalid/test/keys';
    process.env.MCP_ENVIRONMENT = 'test';
    process.env.MCP_SERVICE = 'authorizer';
    process.env.MCP_RELEASE = 'package-smoke';

    const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
    const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'smoke_key', alg: 'RS256', use: 'sig' };
    const config = JSON.parse(process.env.AUTHORIZER_CONFIG!);
    let fetches = 0;
    globalThis.fetch = async input => {
      assert.equal(String(input), process.env.SERVICE_JWKS_URI);
      fetches++;
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const { handler } = await import(`${pathToFileURL(join(extractedRoot, 'authorizer/handler.js')).href}?package-test`);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.issuer, sub: 'subscriber_fixture', aud: config.resource, client_id: 'fixture_host', grant_id: 'grant_fixture',
      scope: 'mcp:invoke', iat: now, nbf: now, exp: now + 60, jti: 'jti_fixture', token_use: 'access', plan_id: 'fixture',
      subscription_valid_until: now + 600, entitlement_revision: 1, usageIdentifierKey: 'USAGEKEYSENTINEL123456789012345',
    };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'smoke_key', typ: 'at+jwt' }).sign(pair.privateKey);
    const methodArn = 'arn:aws:execute-api:us-east-1:000000000000:fixtureapi/test/POST/mcp';
    const result = await handler({ type: 'REQUEST', methodArn, headers: { Authorization: `Bearer ${token}` } }, { awsRequestId: 'package_smoke' });
    assert.equal(result.policyDocument.Statement[0].Resource, methodArn);
    assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
    assert.equal(result.usageIdentifierKey, claims.usageIdentifierKey);

    const altered = token.split('.');
    altered[1] = Buffer.from(JSON.stringify({ ...claims, plan_id: 'changed' })).toString('base64url');
    await assert.rejects(handler({ type: 'REQUEST', methodArn, headers: { Authorization: `Bearer ${altered.join('.')}` } }, {}), /Unauthorized/);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('billing runtime remains isolated from the authorizer JWT package', () => {
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
