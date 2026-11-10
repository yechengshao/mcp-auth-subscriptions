import { object, row, constant, choice, id, text, epoch, integer, digest, identity, boolean, correlation, compile, type Schema } from '../../contracts/schema.js';

const purpose = choice('onboarding', 'management');
const verified = { identity, subscriber_id: id };
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
  error_category: choice('dependency_unavailable', 'session_expired', 'configuration_error'),
};
const downstream = object({
  client_id: text, redirect_uri: { ...text, pattern: '^https://' }, resource: { ...text, pattern: '^https://' },
  scopes: { type: 'array', uniqueItems: true, items: text },
  code_challenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  code_challenge_method: constant('S256'), state: text, issuer: { ...text, pattern: '^https://' }, client_config_version: id,
});
const txOptional = ['correlation_id', 'order_id', 'grant_id', 'attempts', 'next_attempt_at', 'error_category'];
export const transactionSchema: Schema = { oneOf: [
  ...(['onboarding', 'management'] as const).flatMap(purpose => {
    const route: Record<string, Schema> = purpose === 'onboarding' ? { downstream, grant_id: id } : { local_destination: constant('/billing') };
    return [
      object({ ...txCommon, purpose: constant(purpose), ...route, phase: constant('pending_identity') }, txOptional),
      object({ ...txCommon, purpose: constant(purpose), ...route, ...verified,
        phase: purpose === 'management' ? constant('identity_verified') : choice('identity_verified', 'payment_pending', 'code_ready', 'code_issued', 'redeemed') }, txOptional),
      object({ ...txCommon, purpose: constant(purpose), ...route, phase: constant('failed'), ...verified }, [...txOptional, 'identity', 'subscriber_id']),
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
export const assertSessionShape = compile(sessionSchema);
export const assertTransactionShape = compile(transactionSchema);
export const assertProfileShape = compile(profileSchema);
export const assertRefreshShape = compile(refreshSchema);
