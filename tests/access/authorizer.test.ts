import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizer, type RequestEvent } from '../../authorizer/handler.js';
import { TrustedJwks } from '../../security/jwks.js';
import { Telemetry } from '../../observability/telemetry.js';
import { identityFixture, claims, now, trust } from './support/identity_fixture.js';
const fixture = await identityFixture();
const arn = `arn:aws:execute-api:us-east-1:000000000000:fixtureapi/test/POST/mcp`;
const event = (token: string): RequestEvent => ({ type: 'REQUEST', methodArn: arn, headers: { Authorization: `Bearer ${token}` } });
function app(clock = now, loader = async (_signal: AbortSignal): Promise<unknown> => fixture.jwks) {
  const logs: string[] = [];
  const handler = createAuthorizer(trust, new TrustedJwks(loader), new Telemetry({ service: 'authorizer', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) }), () => clock);
  return { handler, logs };
}
test('REQUEST authorizer returns exact ARN policy and private top-level usage key, with no datastore ports', async () => {
  const { handler, logs } = app();
  const result = await handler(event(await fixture.sign()), {});
  assert.equal(result.principalId, claims.sub); assert.equal(result.usageIdentifierKey, claims.usageIdentifierKey);
  assert.deepEqual(result.policyDocument.Statement, [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: arn }]);
  assert.equal(JSON.stringify(result.context).includes(claims.usageIdentifierKey), false);
  assert.equal(logs.join('').includes(claims.usageIdentifierKey), false);
});
test('wrong issuer/resource/client/type, excessive lifetime, paid bound and privacy claims deny', async () => {
  for (const change of [{ iss: 'https://wrong.invalid' }, { aud: 'https://wrong.invalid/mcp' }, { aud: [trust.resource] }, { client_id: 'other' },
    { token_use: 'id' }, { exp: now + 3601 }, { subscription_valid_until: now + 3599 }, { exp: now }, { iat: now + 1 },
    { usageIdentifierKey: '' }, { entitlement_revision: -1 }, { email: 'PRIVATE_EMAIL_SENTINEL' }]) {
    await assert.rejects(app().handler(event(await fixture.sign(change)), {}), /^Error: Unauthorized$/);
  }
});
test('signed usage key tampering, embedded key URLs and foreign signatures deny without MCP invocation', async () => {
  const signed = await fixture.sign(); const parts = signed.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, usageIdentifierKey: 'TAMPEREDKEY123456789012345' })).toString('base64url');
  await assert.rejects(app().handler(event(parts.join('.')), {}), /Unauthorized/);
  await assert.rejects(app().handler(event(await fixture.sign({}, { jku: 'https://evil.invalid/keys' })), {}), /Unauthorized/);
  const other = await identityFixture(); await assert.rejects(app().handler(event(await other.sign()), {}), /Unauthorized/);
});
test('wrong REST account/API/stage/method or HTTP-v2 events deny before key retrieval', async () => {
  let reads = 0; const { handler } = app(now, async () => { reads++; return fixture.jwks; });
  const signed = await fixture.sign();
  for (const changes of [{ methodArn: arn.replace('000000000000', '111111111111') }, { methodArn: arn.replace('/test/', '/other/') },
    { methodArn: arn.replace('fixtureapi', 'otherapi') }, { methodArn: arn + '/*' }, { methodArn: arn.replace('POST', 'DELETE') },
    { routeArn: arn }, { version: '2.0' }]) await assert.rejects(handler({ ...event(signed), ...changes }, {}), /Unauthorized/);
  assert.equal(reads, 0);
});
test('valid JWT with insufficient scope returns exact Deny policy without a key', async () => {
  const result = await app().handler(event(await fixture.sign({ scope: 'other:scope' })), {});
  assert.equal(result.policyDocument.Statement[0]!.Effect, 'Deny'); assert.equal(result.usageIdentifierKey, undefined);
});
test('expiry is strict at paid-through even with allowed clock skew; no current subscription lookup', async () => {
  await assert.rejects(app(now + 3600).handler(event(await fixture.sign()), {}), /Unauthorized/);
  const handler = createAuthorizer({ ...trust, clockSkewSeconds: 30 }, new TrustedJwks(async () => fixture.jwks), new Telemetry({ service: 'authorizer', environment: 'test', release: 'fixture' }), () => now + 3600);
  await assert.rejects(handler(event(await fixture.sign({ subscription_valid_until: now + 3600 })), {}), /Unauthorized/);
});
test('trusted-key outage is diagnosed separately without leaking tokens or provider errors', async () => {
  const { handler, logs } = app(now, async () => { throw new Error('PRIVATE_PROVIDER_SENTINEL'); });
  const token = await fixture.sign(); await assert.rejects(handler(event(token), {}), /authorizer_failed/);
  for (const secret of [token, claims.usageIdentifierKey, 'PRIVATE_PROVIDER_SENTINEL']) assert.equal(logs.join('').includes(secret), false);
});
test('malformed events and duplicate authorization headers cannot select credentials', async () => {
  const { handler } = app();
  await assert.rejects(handler(null as any, {}), /Unauthorized/);
  const token = await fixture.sign();
  await assert.rejects(handler({ ...event(token), multiValueHeaders: { Authorization: [`Bearer ${token}`, 'Bearer other'] } }, {}), /Unauthorized/);
});
