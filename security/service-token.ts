import type { JWTPayload } from 'jose';
import { identifierPattern, registeredClientIdPattern, usageIdentifierKeyPattern } from '../contracts/patterns.js';
export interface TokenTrust { issuer: string; resource: string; clientIds: string[]; clockSkewSeconds: number }
export interface ServiceClaims extends JWTPayload {
  iss: string; sub: string; aud: string; client_id: string; grant_id: string; scope: string;
  iat: number; nbf: number; exp: number; jti: string; token_use: 'access'; plan_id: string;
  subscription_valid_until: number; entitlement_revision: number; usageIdentifierKey: string;
}
export const opaqueId = identifierPattern;
export function validateHttps(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_trust_configuration');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('invalid_trust_configuration');
}
export function validateTrust(input: TokenTrust): TokenTrust {
  validateHttps(input.issuer); validateHttps(input.resource);
  if (!Array.isArray(input.clientIds) || !input.clientIds.length || input.clientIds.length > 100 ||
      input.clientIds.some(id => typeof id !== 'string' || !registeredClientIdPattern.test(id)) || new Set(input.clientIds).size !== input.clientIds.length ||
      !Number.isInteger(input.clockSkewSeconds) || input.clockSkewSeconds < 0 || input.clockSkewSeconds > 30) throw new Error('invalid_trust_configuration');
  return structuredClone(input);
}
export function parseScopes(input: unknown): string[] {
  if (typeof input !== 'string' || !input.length || input.length > 2048 || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(input)) throw new Error('invalid_access_token');
  const values = input.split(' ');
  if (values.length > 32 || new Set(values).size !== values.length) throw new Error('invalid_access_token');
  return values;
}
/** Signature verification is separate. These checks never consult a datastore. */
export function validateServiceClaims(input: JWTPayload, trust: TokenTrust, now: number): ServiceClaims {
  const reject = (): never => { throw new Error('invalid_access_token'); };
  const allowed = new Set(['iss','sub','aud','client_id','grant_id','scope','iat','nbf','exp','jti','token_use','plan_id','subscription_valid_until','entitlement_revision','usageIdentifierKey']);
  if (Object.keys(input).some(key => !allowed.has(key)) || !Number.isSafeInteger(now) || now < 0) reject();
  const p = input as ServiceClaims;
  if (p.iss !== trust.issuer || p.aud !== trust.resource || !trust.clientIds.includes(p.client_id) || p.token_use !== 'access' ||
      ![p.sub, p.grant_id, p.jti, p.plan_id].every(value => typeof value === 'string' && opaqueId.test(value)) ||
      typeof p.usageIdentifierKey !== 'string' || !usageIdentifierKeyPattern.test(p.usageIdentifierKey)) reject();
  for (const value of [p.iat,p.nbf,p.exp,p.subscription_valid_until]) if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799) reject();
  if (!Number.isSafeInteger(p.entitlement_revision) || p.entitlement_revision < 0 || p.nbf > p.iat || p.exp <= p.iat ||
      p.exp > p.iat + 3600 || p.exp > p.subscription_valid_until || p.iat > now + trust.clockSkewSeconds ||
      p.nbf > now + trust.clockSkewSeconds || p.exp <= now - trust.clockSkewSeconds || now >= p.subscription_valid_until) reject();
  parseScopes(p.scope);
  return p;
}
