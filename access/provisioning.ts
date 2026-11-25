import { identifierPattern } from '../contracts/patterns.js';
import { validateAccessBudgets } from './contracts/configuration.js';
import { ApiGatewayUsagePlans } from './adapters/api-gateway.js';
import type { AccessRow } from './model.js';
import type { Telemetry } from '../observability/telemetry.js';
import { UsageBindingProvisioner, type ApiGatewayUsagePlanPort } from './usage_bindings.js';
import type { RestApiTargetSource } from './rest-api-target.js';

export interface AccessProvisioningConfiguration {
  target: { stage: string };
  budgets: {
    schema_version: 1; provisioning_budget_ms: number; sdk_timeout_ms: number; lease_seconds: number;
    max_attempts: number; backoff_min_ms: number; backoff_max_ms: number;
  };
}

/** Composition root for the hexagonal provisioning use case and its AWS-native adapter. */
export function createUsageBindingProvisioner(store: {
  readonly environment: string;
  get(key: { PK: string; SK: string }): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: { PK: string; SK: string }; expectedRevision?: number; projection?: boolean;
  }>): Promise<void>;
}, telemetry: Telemetry, input: AccessProvisioningConfiguration, resolveTarget: RestApiTargetSource, gateway?: ApiGatewayUsagePlanPort,
runtime: { now?: () => number; random?: () => number } = {}) {
  if (!input || !input.target || typeof resolveTarget !== 'function' || !identifierPattern.test(input.target.stage)) {
    throw new Error('invalid_access_provisioning_configuration');
  }
  validateAccessBudgets(input.budgets);
  const port = gateway ?? new ApiGatewayUsagePlans(telemetry, { timeoutMs: input.budgets.sdk_timeout_ms });
  return new UsageBindingProvisioner(store, port, telemetry, resolveTarget, {
    maxAttempts: input.budgets.max_attempts, leaseSeconds: input.budgets.lease_seconds,
    backoffMinMs: input.budgets.backoff_min_ms, backoffMaxMs: input.budgets.backoff_max_ms,
    provisioningBudgetMs: input.budgets.provisioning_budget_ms, sdkTimeoutMs: input.budgets.sdk_timeout_ms,
  }, runtime.now, runtime.random);
}
