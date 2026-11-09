import { object, constant, choice, id, text, epoch, integer, positive, boolean, currency, term,
  failureSchema, correlation, compile, type Schema } from './schemas.js';
import { retryHintSchema } from './configuration.js';

const orderStatus = object({
  order_id: id, state: choice('pending', 'paid', 'failed', 'expired', 'repair_required'),
  activation_ref: id,
});
const checkout = object({
  order_id: id, checkout_url: { type: 'string', pattern: '^https://checkout\\.stripe\\.com/c/pay/[^\\s]+$', maxLength: 4096 },
});
const planList = object({ catalog_version: id, plans: { type: 'array', maxItems: 100, items: object({
  plan_id: id, name: text, description: text, duration_options: { type: 'array', minItems: 1, maxItems: 100,
    items: object({ duration_option_id: id, label: text, service_term: { $ref: term.$id }, amount_minor: positive, currency }) },
}) } });
const quote = object({ quote_id: id, subscription_id: id, source_revision: integer,
  plan_id: id, duration_option_id: id, service_term: { $ref: term.$id },
  full_amount_minor: positive, credit_minor: integer, payable_minor: positive, currency,
  expires_at: epoch, starts_new_term: constant(true),
});
const successPayloads: Record<string, Schema> = {
  listPlans: planList, createCheckout: checkout, getOrder: orderStatus, reconcileOrder: orderStatus,
  quoteUpgrade: quote, confirmUpgrade: checkout,
  manageSubscription: object({ subscription_id: id, next_action: constant('select_upgrade') }),
};
const base = { schema_version: constant(1), correlation_id: correlation, retryable: boolean, message: text };
const supportPayload = object({ support_email: { type: 'string', pattern: '^[A-Za-z0-9.!#$%&\u0027*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$', maxLength: 254 } });
const failures = (failureSchema as { oneOf: Schema[] }).oneOf.map(schema => {
  const properties = schema.properties as Record<string, Schema>;
  const outcome = (properties.outcome as { const: string }).const;
  return object({ ...properties, payload: outcome === 'support_required' ? supportPayload :
    outcome === 'retryable_unavailable' ? retryHintSchema : object({}) });
});
const failure = compile({ oneOf: failures });
const success = new Map(Object.entries(successPayloads).map(([operation, payload]) => [operation, compile(object({
  ...base, outcome: constant('ok'), retryable: constant(false), payload,
}))]));
const pending = compile(object({ ...base, outcome: constant('pending'), retryable: constant(true),
  payload: object({ order_id: id, activation_ref: id, reason: choice('payment_pending', 'activation_pending'), retry: retryHintSchema }),
}));
/** Validates the result against its trusted native request; does not execute that request. */
export function validateResult(input: unknown, operation: string, action?: string): void {
  const value = input as { outcome?: string; payload?: Record<string, unknown> } | null;
  if (!value || typeof value !== 'object') throw new Error('invalid_billing_result');
  if (value.outcome === 'ok') {
    const validate = success.get(operation);
    if (!validate || (operation === 'manageSubscription' && action !== 'upgrade')) throw new Error('invalid_billing_result');
    validate(value);
    if (operation === 'quoteUpgrade') {
      const payload = value.payload!;
      if ((payload.full_amount_minor as number) - (payload.credit_minor as number) !== payload.payable_minor) throw new Error('invalid_billing_result');
    }
  } else if (value.outcome === 'pending') {
    if (!['createCheckout', 'confirmUpgrade', 'getOrder', 'reconcileOrder'].includes(operation)) throw new Error('invalid_billing_result');
    pending(value);
  } else {
    if (!['listPlans', 'createCheckout', 'getOrder', 'reconcileOrder', 'quoteUpgrade', 'confirmUpgrade', 'manageSubscription', 'openPortal'].includes(operation)) throw new Error('invalid_billing_result');
    failure(value);
    if (operation === 'openPortal' && (input as { error_code: string }).error_code !== 'feature_unavailable') throw new Error('invalid_billing_result');
    if (operation === 'manageSubscription' && action !== 'upgrade' &&
        (value.outcome === 'conflict' || (value.outcome === 'support_required' &&
          (input as { error_code: string }).error_code !== 'financial_support_required'))) throw new Error('invalid_billing_result');
  }
}
export const browserStatus = {
  ok: 200, pending: 202, denied: 403, retryable_unavailable: 503,
  conflict: 409, invalid_request: 400, support_required: 409,
} as const;
