import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from 'jose';
import type { ServiceClaims } from '../../../security/service-token.js';
import type { AuthorizerConfig } from '../../../authorizer/handler.js';
export const now = 1800000000;
export const trust: AuthorizerConfig = { issuer: 'https://login.example.invalid/test', resource: 'https://api.example.invalid/test/mcp',
  clientIds: ['host_fixture'], clockSkewSeconds: 0, region: 'us-east-1', accountId: '000000000000', apiId: 'fixtureapi', stage: 'test',
  routes: [{ method: 'POST', path: 'mcp', scope: 'mcp:invoke' }, { method: 'GET', path: 'health', scope: 'mcp:invoke' }] };
export const claims: ServiceClaims = { iss: trust.issuer, sub: 'subscriber_fixture', aud: trust.resource, client_id: 'host_fixture',
  grant_id: 'grant_fixture', scope: 'mcp:invoke', iat: now, nbf: now, exp: now + 3600, jti: 'jti_fixture', token_use: 'access',
  plan_id: 'basic', subscription_valid_until: now + 7200, entitlement_revision: 1, usageIdentifierKey: 'PRIVATEUSAGEKEYSENTINEL1234567890' };
/** Ephemeral RSA only; no key values are persisted in fixture files. */
export async function identityFixture(kid = 'fixture_key') {
  const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const publicJwk = { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  return { ...pair, publicJwk, pem: await exportPKCS8(pair.privateKey), jwks: { keys: [publicJwk] },
    sign: (changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
      new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid, ...header }).sign(pair.privateKey) };
}
