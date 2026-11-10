/** Closed v1 wire/storage schemas. Authority checks and transactions belong to handlers. */
import { text, id, epoch, integer, positive, digest, boolean, constant, choice, object, correlation,
  traceContext, identity, mapping, term, row, compile, type Schema } from '../../contracts/schema.js';
export { text, id, epoch, integer, positive, digest, boolean, constant, choice, object, correlation,
  traceContext, identity, mapping, term, row, compile } from '../../contracts/schema.js';
export type { Schema } from '../../contracts/schema.js';
import { entitlementSchema } from '../../contracts/entitlement.js';
export { entitlementSchema } from '../../contracts/entitlement.js';
const map = (value: Schema): Schema => ({
  type: 'object', minProperties: 1, maxProperties: 100,
  propertyNames: id, additionalProperties: value,
});
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
export const orderSchema = object({
  ...row, entity_type: constant('order'), environment: id, identity,
  order_id: id, operation_id: id, intent: choice('purchase', 'renewal', 'upgrade'),
  state: choice('pending', 'paid', 'failed', 'expired', 'repair_required'), snapshot: snapshotSchema,
  created_at: epoch, updated_at: epoch,
  checkout_session_id: { ...text, pattern: '^cs_' }, payment_id: { ...text, pattern: '^pi_' },
  quote_id: id, payable_minor: positive, credit_minor: integer,
}, ['checkout_session_id', 'payment_id', 'quote_id', 'payable_minor', 'credit_minor']);
export const queueSchema = object({
  schema_version: constant(1), kind: constant('reconcile_payment'),
  message_type: choice('dispatch_hint', 'run'), generation: positive, environment: id,
  durable_record_key: object({ PK: text, SK: { ...text, pattern: '^WORK#[A-Za-z0-9_-]+$' } }),
  operation_id: id, correlation_id: correlation,
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
  correlation_id: correlation, idempotency_key: text, identity, continuation_ref: id, trace_context: traceContext, input,
}, ['continuation_ref', 'trace_context'])) };
// Error payloads are closed. Operation-specific success payloads are a separate follow-up.
export const failureSchema: Schema = { oneOf: [
  ['denied', false, ['not_eligible', 'not_owner']],
  ['retryable_unavailable', true, ['dependency_unavailable']],
  ['conflict', false, ['catalog_changed', 'revision_conflict']],
  ['invalid_request', false, ['invalid_request']],
  ['support_required', false, ['unsupported_credit_case', 'financial_support_required', 'feature_unavailable']],
].map(([outcome, retryable, codes]) => object({
  schema_version: constant(1), correlation_id: correlation, outcome: constant(outcome as string),
  error_code: choice(...codes as string[]), retryable: constant(retryable as boolean),
  message: text,
})) };
