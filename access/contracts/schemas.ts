import { object, constant, choice, id, text, epoch, integer, digest, identity, boolean, correlation, compile, type Schema } from '../../contracts/schema.js';
import { s256ChallengePattern } from '../../contracts/patterns.js';
const row = { PK: text, SK: text, entity_type: text, revision: integer };

const purpose = choice('onboarding', 'management');
const verified = { identity, subscriber_id: id };
const selectedOffer = object({ plan_id: id, duration_option_id: id, catalog_version: id, intent: choice('purchase', 'renewal') });
const sessionCommon = {
  ...row, entity_type: constant('session'), SK: constant('SESSION'), environment: id,
  purpose, tx_id: id, revoked: boolean, csrf_digest: digest, created_at: epoch, expires_at: epoch, delete_after: epoch,
};
export const sessionSchema: Schema = { oneOf: [
  object({ ...sessionCommon, authentication_stage: constant('pending_identity') }, ['revoked']),
  object({ ...sessionCommon, authentication_stage: constant('identity_verified'), ...verified, grant_id: id }, ['grant_id', 'revoked']),
] };
const txCommon = {
  ...row, entity_type: constant('transaction'), SK: constant('STATE'), environment: id,
  created_at: epoch, expires_at: epoch, delete_after: epoch,
  correlation_id: correlation, order_id: id, attempts: integer, next_attempt_at: epoch,
  error_category: choice('dependency_unavailable', 'session_expired', 'configuration_error'), selected_offer: selectedOffer,
};
const downstream = object({
  client_id: text, redirect_uri: { ...text, pattern: '^https://' }, resource: { ...text, pattern: '^https://' },
  scopes: { type: 'array', uniqueItems: true, items: text },
  code_challenge: { type: 'string', pattern: s256ChallengePattern.source },
  code_challenge_method: constant('S256'), state: text, issuer: { ...text, pattern: '^https://' }, client_config_version: id,
});
const txOptional = ['correlation_id', 'order_id', 'attempts', 'next_attempt_at', 'error_category', 'selected_offer'];
export const transactionSchema: Schema = { oneOf: [
  ...(['onboarding', 'management'] as const).flatMap(purpose => {
    const route: Record<string, Schema> = purpose === 'onboarding' ? { downstream, grant_id: id } : { local_destination: constant('/billing') };
    const optional = purpose === 'onboarding' ? txOptional : [...txOptional, 'grant_id'];
    return [
      object({ ...txCommon, purpose: constant(purpose), ...route, phase: constant('pending_identity') }, optional),
      object({ ...txCommon, purpose: constant(purpose), ...route, ...verified,
        phase: purpose === 'management' ? constant('identity_verified') : choice('identity_verified', 'checkout_pending', 'payment_pending', 'code_ready', 'code_issued', 'redeemed') }, optional),
      object({ ...txCommon, purpose: constant(purpose), ...route, phase: constant('failed'), ...verified }, [...optional, 'identity', 'subscriber_id']),
      object({ ...txCommon, purpose: constant(purpose), ...route, phase: constant('cancelled'), ...verified },
        [...optional, 'identity', 'subscriber_id']),
    ];
  }),
] };
export const profileSchema = object({
  ...row, entity_type: constant('identity_profile'), SK: constant('PROFILE'), environment: id,
  identity, subscriber_id: id,
});
export const refreshSchema = object({
  ...row, entity_type: constant('refresh_credential'), SK: constant('TOKEN'), environment: id,
  grant_id: id, subscriber_id: id, client_id: text, resource: text, sequence: integer,
  status: choice('active', 'consumed'), issued_at: epoch, expires_at: epoch,
  family_expires_at: epoch, latest_access_expires_at: epoch, delete_after: epoch,
});
/**
 * Read-side view of a record schema: unknown top-level fields are ignored so a
 * rolled-back release can read records written by a newer one. Known fields and
 * nested objects keep their closed checks. Writes use the strict schemas.
 */
export function tolerantRecord(schema: Schema): Schema {
  if (Array.isArray(schema.oneOf)) return { ...schema, oneOf: schema.oneOf.map(branch => tolerantRecord(branch as Schema)) };
  return schema.type === 'object' ? { ...schema, additionalProperties: true } : schema;
}
/**
 * Top-level names that must never be ignored on read when a record does not declare them.
 * They cover credentials and fields that route or authorize behavior.
 */
// delete_after is the table TTL attribute: DynamoDB expires items by it even when the validator ignores it.
const sensitiveName = /token|secret|key|verifier|password|credential|private|^raw_|local_destination|downstream|grant_id|phase|purpose|authentication_stage|subscriber_id|delete_after/i;
/** Compiles a read-side validator: unknown benign fields pass; unknown sensitive names fail; known fields keep their checks. */
export function compileTolerant(schema: Schema): (input: unknown) => void {
  const branches = (Array.isArray(schema.oneOf) ? schema.oneOf : [schema]) as Schema[];
  const compiled = branches.map(branch => ({
    declared: new Set(Object.keys((branch.properties ?? {}) as Record<string, unknown>)),
    validate: compile(tolerantRecord(branch)),
  }));
  return input => {
    if (!input || typeof input !== 'object') throw new Error('invalid_contract');
    const keys = Object.keys(input);
    // Mirror oneOf: exactly one branch must accept the record, and that branch must declare every sensitive name it carries.
    let matches = 0;
    for (const branch of compiled) {
      try { branch.validate(input); } catch { continue; }
      if (keys.some(key => sensitiveName.test(key) && !branch.declared.has(key))) continue;
      matches++;
    }
    if (matches !== 1) throw new Error('invalid_contract');
  };
}
export const assertSessionShape = compileTolerant(sessionSchema);
export const assertTransactionShape = compileTolerant(transactionSchema);
export const assertProfileShape = compileTolerant(profileSchema);
export const assertRefreshShape = compileTolerant(refreshSchema);
