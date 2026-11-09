import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { validatedConfig, operations, type Operation, type TelemetryConfig } from './config.js';
import { correlationId, xrayHeader, type TraceContext } from './context.js';

export type Outcome = 'unexpected_error' | 'server_error' | 'initialized' | 'completed' |
  'payment_confirmed' | 'entitlement_committed' | 'subscription_revoked' | 'binding_configured' | 'grant_revoked';
const outcomes: readonly Outcome[] = ['unexpected_error','server_error','initialized','completed',
  'payment_confirmed','entitlement_committed','subscription_revoked','binding_configured','grant_revoked'];
export interface Carrier { correlationId?: unknown; parent?: TraceContext; requestId?: unknown; gatewayRequestId?: unknown }
interface Active { correlationId: string; parent?: TraceContext; startedAt: number; requestId?: string; gatewayRequestId?: string }
const opaque = /^[A-Za-z0-9_-]{1,64}$/;
function identifier(value: unknown): string | undefined { return typeof value === 'string' && opaque.test(value) ? value : undefined; }
function safeFrames(error: unknown) {
  try {
    if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
    const message = error.message;
    const stack = error.stack;
    if (typeof message !== 'string' || message.length > 8192 || stack.length > 32768) return [];
    // Drop the ENTIRE message prefix, including forged multiline "at ..." content.
    const prefix = message ? `${error.name}: ${message}\n` : `${error.name}\n`;
    if (!stack.startsWith(prefix)) return [];
    return stack.slice(prefix.length).split('\n').slice(0, 8).flatMap(line => {
      const match = /(?:at\s+([A-Za-z0-9_.$<>]+)\s+\()?([^()]+):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!match) return [];
      const file = basename(match[2]!).replace(/^file:/, '');
      if (!/^[A-Za-z0-9_.-]{1,96}$/.test(file)) return [];
      return [{ file, line: Number(match[3]), function: /^[A-Za-z0-9_.$]{1,96}$/.test(match[1] ?? '') ? match[1] : 'function' }];
    });
  } catch { return []; }

}
export class Telemetry {
  readonly config: ReturnType<typeof validatedConfig>;
  readonly #storage = new AsyncLocalStorage<Active>();
  #started = false;
  constructor(input: TelemetryConfig, private readonly options: { sink?: (line: string) => void; now?: () => number } = {}) {
    this.config = validatedConfig(input);
  }
  currentCorrelationId(): string | undefined { return this.#storage.getStore()?.correlationId; }
  currentTraceHeader(): string | undefined {
    const parent = this.#storage.getStore()?.parent;
    return parent ? xrayHeader(parent) : undefined;
  }
  log(level: 'error' | 'transition' | 'summary', operation: Operation, outcome: Outcome,
      fields: { duration_ms?: number; status_code?: number; error?: unknown } = {}): void {
    if (!operations.includes(operation) || !outcomes.includes(outcome)) return;
    // No success/polling/cache-hit logging. Callers explicitly mark critical transitions.
    if (level === 'summary' && outcome === 'completed') return;
    try {
      const active = this.#storage.getStore(), parent = active?.parent;
      const record = {
        timestamp: new Date((this.options.now ?? Date.now)()).toISOString(), level: level === 'error' ? 'ERROR' : 'INFO',
        service: this.config.service, environment: this.config.environment, release: this.config.release,
        operation, outcome, ...(active ? { correlation_id: active.correlationId } : {}),
        ...(active?.requestId ? { request_id: active.requestId } : {}),
        ...(active?.gatewayRequestId ? { gateway_request_id: active.gatewayRequestId } : {}),
        ...(parent?.sampled ? { trace_id: parent.traceId, trace_parent_id: parent.parentId } : {}),
        ...(Number.isFinite(fields.duration_ms) && fields.duration_ms! >= 0 ? { duration_ms: Math.round(fields.duration_ms! * 1000) / 1000 } : {}),
        ...(Number.isInteger(fields.status_code) && fields.status_code! >= 100 && fields.status_code! <= 599 ? { status_code: fields.status_code } : {}),
        ...(fields.error ? { error_category: 'unexpected_failure', frames: safeFrames(fields.error) } : {}),
      };
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) <= 4096) (this.options.sink ?? (line => { process.stdout.write(line); }))(line);
    } catch { /* CloudWatch output failures never repeat a charge or fail a request. */ }
  }
  async observe<T>(operation: Operation, carrier: Carrier, work: () => Promise<T>, options: { expectedError?: (error: unknown) => boolean } = {}): Promise<T> {
    if (!operations.includes(operation)) throw new Error('invalid_observation_operation');
    const previous = this.#storage.getStore();
    const parent = carrier.parent ?? previous?.parent;
    const correlation = carrier.correlationId !== undefined ? correlationId(carrier.correlationId) : previous?.correlationId ?? correlationId(undefined);
    const requestId = identifier(carrier.requestId) ?? previous?.requestId;
    const gatewayRequestId = identifier(carrier.gatewayRequestId) ?? previous?.gatewayRequestId;
    const active: Active = { correlationId: correlation, startedAt: performance.now(), ...(parent ? { parent } : {}),
      ...(requestId ? { requestId } : {}), ...(gatewayRequestId ? { gatewayRequestId } : {}) };
    return this.#storage.run(active, async () => {
      if (!previous && !this.#started) { this.#started = true; this.log('summary', operation, 'initialized'); }
      try { return await work(); }
      catch (error) {
        if (!options.expectedError?.(error)) this.log('error', operation, 'unexpected_error', { error, duration_ms: performance.now() - active.startedAt });
        throw error;
      }
    });
  }
  async dependency<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
    // Measure/log failures only; native AWS tracing owns invocation-level segments.
    return this.observe(operation, {}, work);
  }
  markServerError(operation: Operation, status: number, error?: unknown): void {
    const active = this.#storage.getStore();
    this.log('error', operation, 'server_error', { status_code: status, ...(error ? { error } : {}),
      ...(active ? { duration_ms: performance.now() - active.startedAt } : {}) });
  }
  metric(name: string, value: number): void {
    const metrics: Record<string, { service: string; unit: string }> = {
      BillingWebhookCommitFailureCount: { service: 'billing', unit: 'Count' },
      BillingReconcileDueAgeSeconds: { service: 'billing', unit: 'Seconds' },
      AccessProvisioningFailureCount: { service: 'access', unit: 'Count' },
      AccessProvisioningAttemptLatencyMs: { service: 'access', unit: 'Milliseconds' },
    };
    const descriptor = metrics[name];
    if (!this.config.metrics || !descriptor || descriptor.service !== this.config.service || !Number.isFinite(value) || value < 0) return;
    try {
      const record = { _aws: { Timestamp: (this.options.now ?? Date.now)(), CloudWatchMetrics: [{
        Namespace: 'MCP/Operations', Dimensions: [['service','environment']], Metrics: [{ Name: name, Unit: descriptor.unit, StorageResolution: 60 }],
      }] }, service: this.config.service, environment: this.config.environment, [name]: value };
      (this.options.sink ?? (line => { process.stdout.write(line); }))(JSON.stringify(record) + '\n');
    } catch { /* Metrics never affect application work. */ }
  }
}
