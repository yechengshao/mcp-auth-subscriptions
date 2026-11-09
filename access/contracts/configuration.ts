import { object, constant, positive, compile } from '../../billing/contracts/schemas.js';
const shape = compile(object({
  schema_version: constant(1), provisioning_budget_ms: positive, sdk_timeout_ms: positive,
  lease_seconds: positive, max_attempts: positive, backoff_min_ms: positive, backoff_max_ms: positive,
}));
export function validateAccessBudgets(input: unknown): void {
  shape(input);
  const value = input as Record<string, number>;
  if (value.sdk_timeout_ms! >= value.provisioning_budget_ms! ||
      value.lease_seconds! * 1000 <= value.provisioning_budget_ms! ||
      value.backoff_min_ms! > value.backoff_max_ms!) throw new Error('invalid_access_budgets');
}
