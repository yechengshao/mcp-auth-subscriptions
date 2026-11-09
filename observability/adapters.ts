import { header, parseXray, correlationId, lambdaParent } from './context.js';
import { Telemetry, type Carrier } from './telemetry.js';
import type { Operation } from './config.js';

export interface InvocationContext { awsRequestId?: string }
export interface HttpEvent {
  headers?: unknown; multiValueHeaders?: unknown;
  requestContext?: { requestId?: unknown };
}
export interface HttpResult { statusCode: number; body?: string; headers?: Record<string, string>; multiValueHeaders?: Record<string, string[]>; isBase64Encoded?: boolean }
function httpCarrier(event: HttpEvent, context: InvocationContext): Carrier {
  const parent = parseXray(header(event.headers, 'x-amzn-trace-id', event.multiValueHeaders)) ?? lambdaParent();
  return { correlationId: header(event.headers, 'x-correlation-id', event.multiValueHeaders),
    requestId: context.awsRequestId, gatewayRequestId: event.requestContext?.requestId, ...(parent ? { parent } : {}) };
}
/** Decorate the actual business Lambda handler; this does not authenticate any request. */
export function withHttpTelemetry<E extends HttpEvent>(telemetry: Telemetry, operation: Operation,
  handler: (event: E, context: InvocationContext) => Promise<HttpResult>) {
  return (event: E, context: InvocationContext): Promise<HttpResult> => {
    const carrier = httpCarrier(event, context);
    carrier.correlationId = correlationId(carrier.correlationId);
    return telemetry.observe(operation, carrier, async () => {
      try {
        const result = await handler(event, context);
        if (result.statusCode >= 500) telemetry.markServerError(operation, result.statusCode);
        const headers = Object.fromEntries(Object.entries(result.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'x-correlation-id'));
        const multi = result.multiValueHeaders ? Object.fromEntries(Object.entries(result.multiValueHeaders).filter(([key]) => key.toLowerCase() !== 'x-correlation-id')) : undefined;
        return { ...result, ...(multi ? { multiValueHeaders: multi } : {}), headers: { ...headers, 'x-correlation-id': telemetry.currentCorrelationId()! } };
      } catch (error) {
        telemetry.markServerError(operation, 500, error);
        return { statusCode: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
          'x-correlation-id': telemetry.currentCorrelationId()! },
          body: JSON.stringify({ error: operation === 'http.token' ? 'server_error' : 'internal_server_error' }) };
      }
    });
  };
}
export function withAuthorizerTelemetry<E extends HttpEvent, R>(telemetry: Telemetry, handler: (event: E, context: InvocationContext) => Promise<R>) {
  return async (event: E, context: InvocationContext): Promise<R> => {
    try {
      return await telemetry.observe('authorizer.validate', httpCarrier(event, context), () => handler(event, context), {
        expectedError: error => error instanceof Error && error.message === 'Unauthorized',
      });
    } catch (error) {
      // Lambda/platform error logs must never receive an original token/parser exception.
      throw new Error(error instanceof Error && error.message === 'Unauthorized' ? 'Unauthorized' : 'authorizer_failed');
    }
  };
}
export interface NativeEvent { operation: string; correlation_id: string; trace_context?: { 'x-amzn-trace-id': string } }
const nativeOperations = new Map<string, Operation>([
  'listPlans','createCheckout','getOrder','reconcileOrder','quoteUpgrade','confirmUpgrade','manageSubscription','openPortal',
].map(operation => [operation, `billing.${operation}` as Operation]));
export function withNativeTelemetry<E extends NativeEvent, R>(telemetry: Telemetry, handler: (event: E, context: InvocationContext) => Promise<R>) {
  return async (event: E, context: InvocationContext) => {
    const parent = parseXray(event.trace_context?.['x-amzn-trace-id']) ?? lambdaParent();
    const operation = nativeOperations.get(event.operation) ?? 'billing.reconcile';
    const carrier: Carrier = { correlationId: event.correlation_id, requestId: context.awsRequestId, ...(parent ? { parent } : {}) };
    const id = correlationId(carrier.correlationId); carrier.correlationId = id;
    try { return await telemetry.observe(operation, carrier, () => handler(event, context)); }
    catch {
      return { schema_version: 1, correlation_id: id, outcome: 'retryable_unavailable', error_code: 'dependency_unavailable',
        retryable: true, message: 'Service temporarily unavailable; retry safely.',
        payload: { retry_after_seconds: 5, next_attempt_at: Math.floor(Date.now() / 1000) + 5 } };
    }
  };
}
export interface SqsRecord { messageId: string; body: string; attributes?: { AWSTraceHeader?: string } }
export function withSqsRecordTelemetry<R>(telemetry: Telemetry, handler: (record: SqsRecord, context: InvocationContext) => Promise<R>) {
  return async (record: SqsRecord, context: InvocationContext): Promise<R> => {
    let workflowId: unknown;
    // Only a diagnostic field is read, not payment/identity authority. Business code validates the full message.
    if (Buffer.byteLength(record.body) <= 4096) try { workflowId = (JSON.parse(record.body) as { correlation_id?: unknown }).correlation_id; } catch { /* Invalid JSON belongs to business validation. */ }
    const parent = parseXray(record.attributes?.AWSTraceHeader) ?? lambdaParent();
    try {
      return await telemetry.observe('billing.reconcile', { correlationId: workflowId, requestId: context.awsRequestId,
        ...(parent ? { parent } : {}) }, () => handler(record, context));
    } catch { throw new Error('billing_record_failed'); }
  };
}
export function withReplayTelemetry<E, R>(telemetry: Telemetry, handler: (event: E, context: InvocationContext) => Promise<R>) {
  return async (event: E, context: InvocationContext): Promise<R> => {
    const parent = lambdaParent();
    try { return await telemetry.observe('billing.replay', { requestId: context.awsRequestId, ...(parent ? { parent } : {}) }, () => handler(event, context)); }
    catch { throw new Error('billing_replay_failed'); }
  };
}
/** Relay existing AWS tracking metadata only; native AWS services own segment creation. */
export function propagateNative<T extends { correlation_id: string }>(telemetry: Telemetry, event: T) {
  const trace = telemetry.currentTraceHeader();
  return { ...event, correlation_id: telemetry.currentCorrelationId() ?? correlationId(event.correlation_id),
    ...(trace ? { trace_context: { 'x-amzn-trace-id': trace } } : {}) };
}
export function propagateSqs<T extends { MessageBody: string; MessageSystemAttributes?: Record<string, unknown> }>(telemetry: Telemetry, request: T) {
  const trace = telemetry.currentTraceHeader();
  return { ...request, ...(trace ? { MessageSystemAttributes: { ...request.MessageSystemAttributes,
    AWSTraceHeader: { DataType: 'String', StringValue: trace } } } : {}) };
}
