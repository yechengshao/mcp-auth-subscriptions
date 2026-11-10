import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'smoke_key', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const config = { issuer: 'https://login.example.invalid/test', resource: 'https://api.example.invalid/test/mcp',
  clientIds: ['fixture_host'], clockSkewSeconds: 0, accountId: '000000000000', region: 'us-east-1', apiId: 'fixtureapi', stage: 'test',
  routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }] };
process.env.AUTHORIZER_CONFIG = JSON.stringify(config);
process.env.SERVICE_JWKS_URI = 'https://login.example.invalid/test/keys';
process.env.MCP_ENVIRONMENT = 'test'; process.env.MCP_SERVICE = 'authorizer'; process.env.MCP_RELEASE = 'smoke';
let requests = 0;
globalThis.fetch = async url => {
  assert.equal(String(url), process.env.SERVICE_JWKS_URI); requests++;
  return new Response(JSON.stringify({ keys: [publicJwk] }));
};
const { handler } = await import('./dist/authorizer/handler.js');
const claims = { iss: config.issuer, sub: 'subscriber_fixture', aud: config.resource, client_id: 'fixture_host', grant_id: 'grant_fixture',
  scope: 'mcp:invoke', iat: now, nbf: now, exp: now + 60, jti: 'jti_fixture', token_use: 'access', plan_id: 'fixture',
  subscription_valid_until: now + 600, entitlement_revision: 1, usageIdentifierKey: 'USAGEKEYSENTINEL123456789012345' };
const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'smoke_key', typ: 'at+jwt' }).sign(pair.privateKey);
const event = { type: 'REQUEST', methodArn: 'arn:aws:execute-api:us-east-1:000000000000:fixtureapi/test/POST/mcp', headers: { Authorization: `Bearer ${token}` } };
const response = await handler(event, { awsRequestId: 'smoke_invocation' });
assert.equal(response.policyDocument.Statement[0].Resource, event.methodArn);
assert.equal(response.policyDocument.Statement[0].Effect, 'Allow');
assert.equal(response.usageIdentifierKey, claims.usageIdentifierKey);
const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify({ ...claims, plan_id: 'changed' })).toString('base64url');
await assert.rejects(handler({ ...event, headers: { Authorization: `Bearer ${parts.join('.')}` } }, {}), /Unauthorized/);
assert.equal(requests, 1);
assert.deepEqual(Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies), ['jose']);
console.log(JSON.stringify({ authorizer_allow: true, tamper_denied: true, datastore_dependencies: false }));
