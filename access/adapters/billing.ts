import { randomUUID } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { validateOperation } from '../../billing/contracts/validate.js';
import { validateResult } from '../../billing/contracts/results.js';
import { correlationIdPattern } from '../../contracts/patterns.js';
import type { Telemetry } from '../../observability/telemetry.js';
import type { BillingCall, BillingOperation, BillingPort, BillingResult } from '../ports.js';
export type { BillingCall, BillingOperation, BillingResult } from '../ports.js';
export type BillingInvocationFailureKind = 'unavailable' | 'invalid_response' | 'configuration';
export class BillingInvocationFailure extends Error {
  constructor(readonly kind: BillingInvocationFailureKind) { super('billing_service_unavailable'); }
}
export interface BillingInvocationConfiguration { environment: string; accountId: string; aliasArn: string; timeoutMs?: number }

function validateConfiguration(input: BillingInvocationConfiguration) {
  if (!input || !/^[A-Za-z0-9_-]{1,128}$/.test(input.environment) || !/^[0-9]{12}$/.test(input.accountId) ||
      !/^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]+:[A-Za-z][A-Za-z0-9_-]*$/.test(input.aliasArn) ||
      (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 250 || input.timeoutMs > 29_000))) {
    throw new Error('invalid_billing_invocation_configuration');
  }
  if (input.aliasArn.split(':')[4] !== input.accountId) throw new Error('invalid_billing_invocation_configuration');
  return { environment: input.environment, aliasArn: input.aliasArn, timeoutMs: input.timeoutMs ?? 10_000 };
}

/** IAM-only access→billing call. Browser input is never accepted as an envelope. */
export class BillingAliasInvoker implements BillingPort {
  private readonly config: ReturnType<typeof validateConfiguration>;
  private readonly client: LambdaClient;
  constructor(private readonly telemetry: Telemetry, config: BillingInvocationConfiguration,
    client?: LambdaClient) {
    this.config = validateConfiguration(config);
    this.client = client ?? new LambdaClient({ maxAttempts: 1, requestHandler: {
      connectionTimeout: Math.min(1_000, this.config.timeoutMs), requestTimeout: this.config.timeoutMs,
    } });
  }

  async invoke(call: BillingCall): Promise<BillingResult> {
    if ((call.operation === 'listPlans' || call.operation === 'createCheckout') && !call.continuationRef) {
      throw new BillingInvocationFailure('configuration');
    }
    const correlation_id = this.telemetry.currentCorrelationId() ?? randomUUID();
    if (!correlationIdPattern.test(correlation_id)) throw new BillingInvocationFailure('configuration');
    const trace = this.telemetry.currentTraceHeader();
    const request = {
      schema_version: 1 as const, operation: call.operation, environment: this.config.environment, correlation_id,
      idempotency_key: call.idempotencyKey, identity: call.identity,
      ...(call.continuationRef ? { continuation_ref: call.continuationRef } : {}),
      ...(trace ? { trace_context: { 'x-amzn-trace-id': trace } } : {}), input: call.input,
    };
    try { validateOperation(request, this.config.environment); }
    catch { throw new BillingInvocationFailure('configuration'); }
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.byteLength > 32 * 1024) throw new BillingInvocationFailure('configuration');
    let result;
    try {
      result = await this.telemetry.dependency('lambda.invoke_billing', async () => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.config.timeoutMs);
        try {
          return await this.client.send(new InvokeCommand({ FunctionName: this.config.aliasArn,
            InvocationType: 'RequestResponse', Payload: payload }), { abortSignal: abort.signal });
        } finally { clearTimeout(timer); }
      });
    } catch { throw new BillingInvocationFailure('unavailable'); }
    if (result.FunctionError || result.StatusCode !== 200 || !result.Payload || result.Payload.byteLength > 64 * 1024) {
      throw new BillingInvocationFailure(result.FunctionError || result.StatusCode === 200 ? 'invalid_response' : 'unavailable');
    }
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.Payload)); }
    catch { throw new BillingInvocationFailure('invalid_response'); }
    try {
      validateResult(decoded, call.operation, typeof call.input.action === 'string' ? call.input.action : undefined);
      if (!decoded || typeof decoded !== 'object' || (decoded as Record<string, unknown>).correlation_id !== correlation_id) {
        throw new Error('correlation_mismatch');
      }
      return decoded as BillingResult;
    } catch { throw new BillingInvocationFailure('invalid_response'); }
  }
}
