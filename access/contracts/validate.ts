import { assertSessionShape, assertTransactionShape, assertProfileShape, assertRefreshShape } from './schemas.js';
import { identityPartition } from '../../contracts/identity.js';
import { validateEntitlement } from '../../contracts/entitlement.js';
import { sha256HexPattern } from '../../contracts/patterns.js';

interface Session {
  PK: string; environment: string; purpose: 'onboarding' | 'management'; tx_id: string;
  authentication_stage: 'pending_identity' | 'identity_verified'; revoked?: boolean; identity?: { issuer: string; subject: string };
  subscriber_id?: string; created_at: number; expires_at: number; delete_after: number;
}
interface Transaction {
  PK: string; environment: string; purpose: 'onboarding' | 'management'; phase: string; identity?: { issuer: string; subject: string }; subscriber_id?: string;
  created_at: number; expires_at: number; delete_after: number;
}
const reject = (): never => { throw new Error('invalid_session_context'); };
function deadline(value: { created_at: number; expires_at: number; delete_after: number }, now: number) {
  if (!Number.isSafeInteger(now) || now < value.created_at || value.expires_at <= now ||
      value.expires_at <= value.created_at || value.expires_at > value.created_at + 1800 ||
      value.delete_after < value.expires_at + 86400) reject();
}
/** Inputs are server-loaded records; this does not authenticate a cookie or verify Cognito. */
export function validateSessionContext(input: unknown, txInput: unknown, environment: string, now: number): Session {
  assertSessionShape(input); assertTransactionShape(txInput);
  const session = input as Session; const tx = txInput as Transaction;
  deadline(session, now); deadline(tx, now);
  const prefix = `ENV#${environment}#SESSION#`;
  if (session.revoked === true || session.environment !== environment || tx.environment !== environment ||
      !session.PK.startsWith(prefix) || !sha256HexPattern.test(session.PK.slice(prefix.length)) ||
      tx.PK !== `ENV#${environment}#TX#${session.tx_id}` || session.purpose !== tx.purpose ||
      session.expires_at !== tx.expires_at ||
      (session.authentication_stage === 'pending_identity') !== (tx.phase === 'pending_identity') ||
      (session.authentication_stage === 'identity_verified' && (tx.identity?.issuer !== session.identity?.issuer ||
        tx.identity?.subject !== session.identity?.subject || tx.subscriber_id !== session.subscriber_id))) reject();
  return structuredClone(session);
}
export function validateManagementContext(session: unknown, tx: unknown, entitlement: unknown, environment: string, now: number): void {
  const value = validateSessionContext(session, tx, environment, now);
  if (value.authentication_stage !== 'identity_verified' || !value.identity) throw new Error('invalid_session_context');
  validateEntitlement(entitlement, environment, value.identity.issuer, value.identity.subject, now);
}
export function validateProfile(input: unknown, environment: string): void {
  assertProfileShape(input);
  const value = input as { PK: string; environment: string; identity: { issuer: string; subject: string } };
  if (value.environment !== environment || value.PK !== identityPartition(environment, value.identity.issuer, value.identity.subject)) throw new Error('profile_owner_mismatch');
}
export function validateRefreshRecord(input: unknown, environment: string, now: number): void {
  assertRefreshShape(input);
  const value = input as { PK: string; environment: string; issued_at: number; expires_at: number; family_expires_at: number; latest_access_expires_at: number; delete_after: number; status: string };
  const prefix = `ENV#${environment}#REFRESH#`;
  if (!Number.isSafeInteger(now) || value.environment !== environment || !value.PK.startsWith(prefix) ||
      !sha256HexPattern.test(value.PK.slice(prefix.length)) || value.issued_at > now || value.expires_at <= now ||
      value.expires_at !== value.family_expires_at || value.status !== 'active' ||
      value.delete_after < Math.max(value.family_expires_at, value.latest_access_expires_at) + 86400) throw new Error('invalid_refresh_record');
}
