import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { StateKey } from './model.js';

export const credentialDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const newOpaqueCredential = () => randomBytes(32).toString('base64url');
export const authCodeKey = (environment: string, code: string): StateKey => ({
  PK: `ENV#${environment}#CODE#${credentialDigest(code)}`, SK: 'CODE',
});
export const refreshCredentialKey = (environment: string, token: string): StateKey => ({
  PK: `ENV#${environment}#REFRESH#${credentialDigest(token)}`, SK: 'TOKEN',
});
export const grantFamilyKey = (environment: string, grantId: string): StateKey => ({
  PK: `ENV#${environment}#GRANT#${grantId}`, SK: 'FAMILY',
});
export const transactionKey = (environment: string, transactionId: string): StateKey => ({
  PK: `ENV#${environment}#TX#${transactionId}`, SK: 'STATE',
});
export const subscriberBindingKey = (environment: string, subscriberId: string, restApiId: string, stage: string): StateKey => ({
  PK: `ENV#${environment}#SUBSCRIBER#${subscriberId}`, SK: `REST#${restApiId}#STAGE#${stage}`,
});

export function matchesS256(verifier: string, challenge: string): boolean {
  const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const left = Buffer.from(actual, 'ascii'), right = Buffer.from(challenge, 'ascii');
  return left.length === right.length && timingSafeEqual(left, right);
}
