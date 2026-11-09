import { object, id, text, epoch, integer, positive, compile } from './schemas.js';

export const budgetsSchema = object({
  schema_version: { const: 1 }, environment: id,
  invocation_timeout_seconds: { ...positive, maximum: 900 }, batch_window_seconds: { ...integer, maximum: 300 },
  visibility_timeout_seconds: { ...positive, maximum: 43200 }, sqs_concurrency: { ...positive, minimum: 2, maximum: 1000 },
  reserved_concurrency: positive, page_size: { ...positive, maximum: 100 }, max_pages: positive,
  processing_budget_ms: positive, processing_lease_seconds: positive, reconciliation_max_attempts: positive,
  dispatch_max_attempts: positive, dispatch_backoff_seconds: positive, delivery_replay_grace_seconds: positive,
  replay_interval_seconds: positive, recovery_horizon_seconds: positive, history_retention_seconds: positive,
  initial_delay_seconds: { ...integer, maximum: 900 }, quote_lifetime_seconds: positive,
  catalog_cache_seconds: { ...positive, maximum: 60 }, catalog_fetch_timeout_ms: { ...positive, maximum: 3000 },
});
const shape = compile(budgetsSchema);
export function validateBudgets(input: unknown): void {
  shape(input);
  const value = input as Record<string, number>;
  if (value.visibility_timeout_seconds! < 6 * value.invocation_timeout_seconds! + value.batch_window_seconds! ||
      value.sqs_concurrency! >= value.reserved_concurrency! || value.processing_budget_ms! >= value.invocation_timeout_seconds! * 1000 ||
      value.processing_lease_seconds! * 1000 <= value.processing_budget_ms! ||
      value.history_retention_seconds! <= value.recovery_horizon_seconds! ||
      value.recovery_horizon_seconds! <= value.replay_interval_seconds!) throw new Error('invalid_billing_budgets');
}
const resourceShape = compile(object({
  environment: id,
  entitlement_table_arn: { ...text, pattern: '^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]+$' },
  billing_alias_arn: { ...text, pattern: '^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:[A-Za-z][A-Za-z0-9_-]*$' },
}));
/** Narrow interface statements to compose into future access IaC; no resources are created. */
export function accessReadGrants(input: unknown) {
  resourceShape(input);
  const value = input as { environment: string; entitlement_table_arn: string; billing_alias_arn: string };
  const tableParts = value.entitlement_table_arn.split(':'), aliasParts = value.billing_alias_arn.split(':');
  if (tableParts[3] !== aliasParts[3] || tableParts[4] !== aliasParts[4]) throw new Error('resource_scope_mismatch');
  return [
    { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], Resource: value.entitlement_table_arn },
    { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: value.billing_alias_arn },
  ];
}
// Used by result/payload schemas; no timestamps or arbitrary contact URLs are accepted as identifiers.
export const retryHintSchema = object({ retry_after_seconds: { ...positive, maximum: 900 }, next_attempt_at: epoch });
