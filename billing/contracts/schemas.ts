/** Closed v1 wire/storage schemas. Authority checks and transactions belong to handlers. */
import termSchema from '../../specs/003-billing-subscriptions/contracts/service-term.schema.json' with { type: 'json' };
import { Ajv2020 } from 'ajv/dist/2020.js';

export type Schema = Record<string, unknown>;
export const text = { type: 'string', minLength: 1, maxLength: 2048 };
export const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
export const epoch = { type: 'integer', minimum: 0, maximum: 253402300799 };
export const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const positive = { ...integer, minimum: 1 };
export const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const boolean = { type: 'boolean' };
export const constant = (value: string | number | boolean): Schema => ({ const: value });
export const choice = (...values: string[]): Schema => ({ enum: values });
export const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)),
});
const map = (value: Schema): Schema => ({
  type: 'object', minProperties: 1, maxProperties: 100,
  propertyNames: id, additionalProperties: value,
});
export const identity = object({ issuer: { ...text, pattern: '^https://' }, subject: text });
export const mapping = object({ usage_plan_id: id, rest_api_id: id, stage: id });
export const term: Schema = termSchema;
export const currency = { type: 'string', pattern: '^[a-z]{3}$' };
const duration = object({
  enabled_for_purchase: boolean, service_term: { $ref: term.$id }, amount_minor: positive,
  currency, product_id: { ...text, pattern: '^prod_' }, price_id: { ...text, pattern: '^price_' },
  mode: constant('payment'), label: text,
});
export const catalogSchema = object({
  schema_version: constant(1), catalog_version: id, environment: id,
  aws_account_id: { type: 'string', pattern: '^[0-9]{12}$' }, region: id,
  stripe_account: { ...text, pattern: '^acct_' },
  plans: map(object({
    tier_order: integer, display: object({ name: text, description: text }),
    enabled_for_purchase: boolean,
    actions: { type: 'array', minItems: 1, uniqueItems: true, items: choice('purchase', 'renewal', 'upgrade') },
    usage_mapping: mapping, duration_options: map(duration),
  })),
});
export const snapshotSchema = object({
  plan_id: id, duration_option_id: id, catalog_version: id, ssm_version: positive,
  environment: id, service_term: { $ref: term.$id }, amount_minor: positive, currency,
  product_id: { ...text, pattern: '^prod_' }, price_id: { ...text, pattern: '^price_' },
  mode: constant('payment'), usage_mapping: mapping,
});
export const row = {
  PK: text, SK: text, schema_version: constant(1), entity_type: text, revision: integer,
};
export const entitlementSchema = object({
  ...row, entity_type: constant('entitlement'), SK: constant('ENTITLEMENT'),
  environment: id, identity_issuer: { ...text, pattern: '^https://' }, identity_subject: text,
  allowed: boolean, plan_id: id, duration_option_id: id, service_term: { $ref: term.$id },
  catalog_version: id, ssm_version: positive, usage_mapping: mapping, valid_until: epoch, updated_at: epoch,
});
export const orderSchema = object({
  ...row, entity_type: constant('order'), environment: id, identity,
  order_id: id, operation_id: id, intent: choice('purchase', 'renewal', 'upgrade'),
  state: choice('pending', 'paid', 'failed', 'expired', 'repair_required'), snapshot: snapshotSchema,
  created_at: epoch, updated_at: epoch,
  checkout_session_id: { ...text, pattern: '^cs_' }, payment_id: { ...text, pattern: '^pi_' },
}, ['checkout_session_id', 'payment_id']);
export const queueSchema = object({
  schema_version: constant(1), kind: constant('reconcile_payment'),
  message_type: choice('dispatch_hint', 'run'), generation: positive, environment: id,
  durable_record_key: object({ PK: text, SK: { ...text, pattern: '^WORK#[A-Za-z0-9_-]+$' } }),
  operation_id: id, correlation_id: id,
});
const target = { plan_id: id, duration_option_id: id, catalog_version: id };
const operations: Record<string, Schema> = {
  listPlans: object({}),
  createCheckout: object({ ...target, intent: choice('purchase', 'renewal') }),
  getOrder: object({ order_id: id }), reconcileOrder: object({ order_id: id }),
  quoteUpgrade: object({ ...target, subscription_id: id, source_revision: integer }),
  confirmUpgrade: object({ quote_id: id }),
  manageSubscription: object({ subscription_id: id, action: choice('upgrade', 'downgrade', 'cancel', 'refund') }),
  openPortal: object({ subscription_id: id }),
};
export const operationSchema: Schema = { oneOf: Object.entries(operations).map(([operation, input]) => object({
  schema_version: constant(1), operation: constant(operation), environment: id,
  correlation_id: id, idempotency_key: text, identity, continuation_ref: id, input,
}, ['continuation_ref'])) };
// Error payloads are closed. Operation-specific success payloads are a separate follow-up.
export const failureSchema: Schema = { oneOf: [
  ['denied', false, ['not_eligible', 'not_owner']],
  ['retryable_unavailable', true, ['dependency_unavailable']],
  ['conflict', false, ['catalog_changed', 'revision_conflict']],
  ['invalid_request', false, ['invalid_request']],
  ['support_required', false, ['unsupported_credit_case', 'financial_support_required', 'feature_unavailable']],
].map(([outcome, retryable, codes]) => object({
  schema_version: constant(1), correlation_id: id, outcome: constant(outcome as string),
  error_code: choice(...codes as string[]), retryable: constant(retryable as boolean),
  message: text,
})) };
const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
ajv.addSchema(term);
export function compile(schema: Schema): (input: unknown) => void {
  const validate = ajv.compile(schema);
  return input => {
    if (!validate(input)) throw new Error('invalid_contract'); // Never echo credentials or record values.
  };
}
