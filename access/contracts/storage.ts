import { object, row, constant, choice, id, text, epoch, integer, positive, boolean, digest, identity, mapping, compile, type Schema } from '../../billing/contracts/schemas.js';
import { sessionSchema, transactionSchema, profileSchema, refreshSchema } from './schemas.js';
import { identityPartition } from '../../billing/contracts/validate.js';
import { canonicalJson } from '../../billing/contracts/canonical.js';

const base = { ...row, environment: id };
const scopes = { type: 'array', uniqueItems: true, items: text };
const challenge = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const keyValue = { type: 'string', pattern: '^[A-Za-z0-9]{20,128}$' };
const mutation = object({
  generation: integer, desired_entitlement_revision: integer,
  status: choice('idle', 'reserved', 'dispatching', 'acknowledged', 'uncertain', 'repair_required'),
  step: choice('create_key', 'remove_association', 'add_association'),
  target: mapping, owner_invocation_id: id, step_started_at: epoch,
  api_key_id: id, evidence: choice('accepted', 'closed', 'unknown'),
}, ['step', 'target', 'owner_invocation_id', 'step_started_at', 'api_key_id', 'evidence']);
export const accessRecordSchemas: Record<string, Schema> = {
  session: sessionSchema, transaction: transactionSchema, identity_profile: profileSchema, refresh_credential: refreshSchema,
  upstream_attempt: object({ ...base, entity_type: constant('upstream_attempt'), SK: constant('ATTEMPT'),
    tx_id: id, session_digest: digest, nonce_digest: digest,
    pkce_verifier: { type: 'string', pattern: '^[A-Za-z0-9._~-]{43,128}$' },
    cognito_client_id: id, cognito_issuer: { ...text, pattern: '^https://' }, callback_uri: { ...text, pattern: '^https://' },
    created_at: epoch, expires_at: epoch, delete_after: epoch, consumed: boolean,
  }, ['pkce_verifier']),
  authorization_code: object({ ...base, entity_type: constant('authorization_code'), SK: constant('CODE'),
    tx_id: id, subscriber_id: id, client_id: text, resource: { ...text, pattern: '^https://' },
    redirect_uri: { ...text, pattern: '^https://' }, code_challenge: challenge, code_challenge_method: constant('S256'),
    grant_id: id, issued_at: epoch, transaction_expires_at: epoch, expires_at: epoch, delete_after: epoch, consumed: boolean,
  }),
  grant_family: object({ ...base, entity_type: constant('grant_family'), SK: constant('FAMILY'), grant_id: id,
    identity, subscriber_id: id, client_id: text, resource: { ...text, pattern: '^https://' }, scopes,
    status: choice('active', 'revoked'), refresh_expires_at: epoch, rotation_counter: integer,
    latest_access_expires_at: epoch, created_at: epoch, delete_after: epoch,
    revoked_at: epoch, revocation_reason: choice('logout', 'replay', 'subscription_revoked', 'support'),
  }, ['revoked_at', 'revocation_reason']),
  subscriber_binding: object({ ...base, entity_type: constant('subscriber_binding'), subscriber_id: id,
    plan_id: id, duration_option_id: id, catalog_version: id, entitlement_revision: integer, usage_mapping: mapping,
    state: choice('pending', 'configured', 'error'), operation_id: id, api_key_value: keyValue, api_key_id: id,
    attempts: integer, next_attempt_at: epoch, lease_owner: id, fence: positive, lease_until: epoch,
    mutation, error_class: choice('dependency_unavailable', 'configuration_error', 'uncertain_effect', 'exhausted'), updated_at: epoch,
  }, ['api_key_id', 'error_class']),
};
const validators = new Map(Object.entries(accessRecordSchemas).map(([kind, schema]) => [kind, compile(schema)]));
function invalid(): never { throw new Error('invalid_access_record'); }
export function validateAccessRecord(input: unknown, environment: string): void {
  if (!input || typeof input !== 'object') invalid();
  const value = input as Record<string, unknown>, kind = value.entity_type as string;
  const validate = validators.get(kind);
  if (!validate) invalid();
  validate(value);
  if (value.environment !== environment) invalid();
  let pk: string;
  switch (kind) {
    case 'transaction':
      if (!(value.PK as string).startsWith(`ENV#${environment}#TX#`) ||
          !/^[A-Za-z0-9_-]{1,128}$/.test((value.PK as string).slice(`ENV#${environment}#TX#`.length))) invalid();
      pk = value.PK as string; break;
    case 'identity_profile': {
      const owner = value.identity as { issuer: string; subject: string };
      pk = identityPartition(environment, owner.issuer, owner.subject); break;
    }
    case 'grant_family': pk = `ENV#${environment}#GRANT#${value.grant_id as string}`; break;
    case 'subscriber_binding': {
      const mapping = value.usage_mapping as { rest_api_id: string; stage: string };
      pk = `ENV#${environment}#SUBSCRIBER#${value.subscriber_id as string}`;
      if (value.SK !== `REST#${mapping.rest_api_id}#STAGE#${mapping.stage}`) invalid();
      const mutation = value.mutation as Record<string, unknown>;
      if (mutation.status !== 'idle' && ['step', 'target', 'owner_invocation_id', 'step_started_at'].some(key => mutation[key] === undefined)) invalid();
      if (mutation.status !== 'idle' && mutation.generation === 0) invalid();
      if (value.state === 'configured' && (!value.api_key_id || mutation.desired_entitlement_revision !== value.entitlement_revision ||
          !['idle', 'acknowledged'].includes(mutation.status as string))) invalid();
      if (value.state === 'configured' && mutation.status === 'acknowledged' &&
          (mutation.step !== 'add_association' || !['accepted', 'closed'].includes(mutation.evidence as string) ||
           mutation.api_key_id !== value.api_key_id || canonicalJson(mutation.target) !== canonicalJson(value.usage_mapping))) invalid();
      break;
    }
    default: {
      const namespace = { session: 'SESSION', upstream_attempt: 'UPSTREAM', authorization_code: 'CODE', refresh_credential: 'REFRESH' }[kind];
      if (!namespace) invalid();
      const prefix = `ENV#${environment}#${namespace}#`;
      pk = value.PK as string;
      if (!pk.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(pk.slice(prefix.length))) invalid();
    }
  }
  if (value.PK !== pk) invalid();
  if (['session', 'transaction', 'upstream_attempt'].includes(kind)) {
    if ((value.expires_at as number) <= (value.created_at as number) ||
        (value.expires_at as number) > (value.created_at as number) + 1800) invalid();
  }
  if (kind === 'upstream_attempt' && ((value.consumed === false && value.pkce_verifier === undefined) ||
      (value.consumed === true && value.pkce_verifier !== undefined))) invalid();
  if (kind === 'authorization_code' && ((value.expires_at as number) <= (value.issued_at as number) ||
      (value.expires_at as number) > Math.min((value.issued_at as number) + 60, value.transaction_expires_at as number))) invalid();
  if (kind === 'grant_family' && ((value.status === 'revoked') !== (value.revoked_at !== undefined && value.revocation_reason !== undefined) ||
      (value.status === 'active' && (value.revoked_at !== undefined || value.revocation_reason !== undefined)) ||
      (value.refresh_expires_at as number) <= (value.created_at as number))) invalid();
  if (kind === 'refresh_credential' && (value.expires_at !== value.family_expires_at ||
      (value.expires_at as number) <= (value.issued_at as number))) invalid();
  if (value.delete_after !== undefined) {
    const end = Math.max((value.expires_at ?? value.refresh_expires_at ?? 0) as number,
      (value.family_expires_at ?? 0) as number, (value.latest_access_expires_at ?? 0) as number);
    if ((value.delete_after as number) < end + 86400) invalid();
  }
}
