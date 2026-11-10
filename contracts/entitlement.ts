import { object, row, constant, id, text, boolean, positive, mapping, epoch, term, compile, type Schema } from './schema.js';
import { identityPartition } from './identity.js';

/** Billing-owned persisted projection consumed by access without importing billing workflows. */
export const entitlementSchema: Schema = object({
  ...row, entity_type: constant('entitlement'), SK: constant('ENTITLEMENT'),
  environment: id, identity_issuer: { ...text, pattern: '^https://' }, identity_subject: text,
  allowed: boolean, plan_id: id, duration_option_id: id, service_term: { $ref: term.$id },
  catalog_version: id, ssm_version: positive, usage_mapping: mapping, valid_until: epoch, updated_at: epoch,
});

const entitlementShape = compile(entitlementSchema);
interface Entitlement {
  PK: string; environment: string; identity_issuer: string; identity_subject: string; allowed: boolean; valid_until: number;
}

export function validateEntitlement(input: unknown, environment: string, issuer: string, subject: string, now: number): void {
  entitlementShape(input);
  const value = input as Entitlement;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_clock');
  if (value.environment !== environment || value.identity_issuer !== issuer || value.identity_subject !== subject ||
      value.PK !== identityPartition(environment, issuer, subject)) throw new Error('entitlement_owner_mismatch');
  if (!value.allowed || value.valid_until <= now) throw new Error('not_eligible');
}
