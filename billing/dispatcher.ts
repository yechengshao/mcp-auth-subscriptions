import { validateOperation, validateEntitlement, type Catalog } from './contracts/validate.js';
import { publicPlans } from './contracts/validate.js';
import { validateResult } from './contracts/results.js';
import { Telemetry, withNativeTelemetry } from './observability.js';
export interface BillingRequest {
  schema_version: 1; operation: string; environment: string; correlation_id: string;
  idempotency_key: string; identity: { issuer: string; subject: string };
  continuation_ref?: string; trace_context?: { 'x-amzn-trace-id': string }; input: Record<string, unknown>;
}
export interface BillingPorts {
  catalog(): Promise<Catalog>;
  entitlement(identity: BillingRequest['identity']): Promise<unknown>;
  /** Must resolve order/subscription/quote ownership from persisted records, never browser metadata. */
  owns(request: BillingRequest): Promise<boolean>;
  /** Mutating operations must persist intent and use fenced transactions before effects. */
  operations: Partial<Record<string, (request: BillingRequest) => Promise<unknown>>>;
  now(): number;
}
/** Native Lambda invocation only: deployment IAM must restrict InvokeFunction to the access alias caller.
 * No HTTP events, cookies or browser-provided identity are accepted at this boundary.
 */
export function createBillingDispatcher(environment: string, supportEmail: string, ports: BillingPorts, telemetry: Telemetry) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error('invalid_support_email');
  return withNativeTelemetry(telemetry, async (request: BillingRequest) => {
    validateOperation(request, environment);
    const result = (outcome: string, error_code: string, payload: unknown = {}) => ({
      schema_version: 1, correlation_id: request.correlation_id, outcome, error_code,
      retryable: false, message: 'Request could not be completed.', payload,
    });
    let response: unknown;
    const operation = request.operation;
    if (['listPlans', 'createCheckout'].includes(operation) && !request.continuation_ref) {
      response = result('invalid_request', 'invalid_request');
    } else if (!['listPlans', 'createCheckout'].includes(operation) && !await ports.owns(request)) {
      response = result('denied', 'not_owner');
    } else {
      if (['quoteUpgrade', 'confirmUpgrade', 'manageSubscription', 'openPortal'].includes(operation)) {
        const entitlement = await telemetry.dependency('dynamodb.read', () => ports.entitlement(request.identity));
        try {
          validateEntitlement(entitlement, environment, request.identity.issuer, request.identity.subject, ports.now());
        } catch (error) {
          if (error instanceof Error && error.message === 'not_eligible') response = result('denied', 'not_eligible');
          else throw error;
        }
      }
      if (!response) {
        if (operation === 'openPortal' || (operation === 'manageSubscription' && request.input.action !== 'upgrade')) {
          response = result('support_required', operation === 'openPortal' ? 'feature_unavailable' : 'financial_support_required', { support_email: supportEmail });
        } else if (operation === 'listPlans') {
          response = { schema_version: 1, correlation_id: request.correlation_id, outcome: 'ok', retryable: false,
            message: 'Available plans.', payload: publicPlans(await ports.catalog()) };
        } else {
          const handler = ports.operations[operation];
          if (!handler) throw new Error('operation_not_configured');
          response = await handler(request);
        }
      }
    }
    validateResult(response, operation, typeof request.input.action === 'string' ? request.input.action : undefined);
    return response;
  });
}
