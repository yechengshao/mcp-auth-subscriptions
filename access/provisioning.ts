import { validateAccessBudgets } from './contracts/configuration.js';
import { ApiGatewayUsagePlans } from './adapters/api-gateway.js';
import type { AccessRow } from './model.js';
import type { Telemetry } from '../observability/telemetry.js';
import { UsageBindingProvisioner, type ApiGatewayUsagePlanPort } from './usage_bindings.js';
import type { RestApiTargetSource } from './rest-api-target.js';

/**
 * Provisioning budgets are code, not a deploy input. They bound the gateway calls made inside one request
 * (timeouts, retries, lease and total time) and are checked by tests. To change them, change this file.
 */
export const provisioningBudgets = {
  schema_version: 1 as const, provisioning_budget_ms: 10_000, sdk_timeout_ms: 3_000, lease_seconds: 60,
  max_attempts: 5, backoff_min_ms: 2_000, backoff_max_ms: 30_000,
};
validateAccessBudgets(provisioningBudgets);

/** Composition root for the hexagonal provisioning use case and its AWS-native adapter. */
export function createUsageBindingProvisioner(store: {
  readonly environment: string;
  get(key: { PK: string; SK: string }): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: { PK: string; SK: string }; expectedRevision?: number; projection?: boolean;
  }>): Promise<void>;
}, telemetry: Telemetry, resolveTarget: RestApiTargetSource, gateway?: ApiGatewayUsagePlanPort,
runtime: { now?: () => number; random?: () => number } = {}) {
  const port = gateway ?? new ApiGatewayUsagePlans(telemetry, { timeoutMs: provisioningBudgets.sdk_timeout_ms });
  return new UsageBindingProvisioner(store, port, telemetry, resolveTarget, {
    maxAttempts: provisioningBudgets.max_attempts, leaseSeconds: provisioningBudgets.lease_seconds,
    backoffMinMs: provisioningBudgets.backoff_min_ms, backoffMaxMs: provisioningBudgets.backoff_max_ms,
    provisioningBudgetMs: provisioningBudgets.provisioning_budget_ms, sdkTimeoutMs: provisioningBudgets.sdk_timeout_ms,
  }, runtime.now, runtime.random);
}
