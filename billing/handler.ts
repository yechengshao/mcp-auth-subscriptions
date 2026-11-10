import { createBillingHttpAdapter } from './http.js';
import { createHash } from 'node:crypto';
import { BillingStore, BillingQueue, parameterCatalog, parameterSecret } from './adapters/aws.js';
import { StripeAdapter, verifyWebhook } from './adapters/stripe.js';
import { BillingService, type RuntimeBudgets } from './service.js';
import { createBillingDispatcher, type BillingRequest } from './dispatcher.js';
import { validateQueue } from './contracts/validate.js';
import { validateBudgets } from './contracts/configuration.js';
import { Telemetry, withBillingHttpTelemetry, withSqsRecordTelemetry, withReplayTelemetry } from './observability.js';
import { configFromEnvironment } from '../observability/config.js';
import { header } from '../observability/context.js';
import { awsAccountIdPattern } from '../contracts/patterns.js';
import type { InvocationContext, HttpEvent } from '../observability/adapters.js';
export interface HandlerConfig {
  environment: string; scope: { environment: string; aws_account_id: string; region: string; stripe_account: string };
  stateTable: string; entitlementTable: string; catalogParameter: string; stripeKeyParameter: string; webhookSecretParameter: string;
  queueUrl: string; queueArn: string; replayRuleArn: string; successUrl: string; cancelUrl: string; supportEmail: string;
  live: boolean; budgets: RuntimeBudgets;
}
const required = (source: NodeJS.ProcessEnv, key: string) => { const value = source[key]; if (!value) throw new Error('missing_billing_configuration'); return value; };
export function runtimeConfig(source: NodeJS.ProcessEnv): HandlerConfig {
  const environment = required(source, 'MCP_ENVIRONMENT');
  const budgets: unknown = JSON.parse(required(source, 'BILLING_BUDGETS')); validateBudgets(budgets);
  for (const [field, variable] of Object.entries({ invocation_timeout_seconds: 'BILLING_FUNCTION_TIMEOUT', reserved_concurrency: 'BILLING_RESERVED_CONCURRENCY',
    visibility_timeout_seconds: 'BILLING_QUEUE_VISIBILITY', sqs_concurrency: 'BILLING_SQS_CONCURRENCY', batch_window_seconds: 'BILLING_BATCH_WINDOW', replay_interval_seconds: 'BILLING_REPLAY_INTERVAL' })) {
    if ((budgets as Record<string, unknown>)[field] !== Number(required(source, variable))) throw new Error('billing_infrastructure_budget_mismatch');
  }
  if ((budgets as { environment: string }).environment !== environment) throw new Error('billing_environment_mismatch');
  if (!['true','false'].includes(required(source, 'STRIPE_LIVE'))) throw new Error('invalid_stripe_mode');
  const account = required(source, 'AWS_ACCOUNT_ID'), region = required(source, 'AWS_REGION');
  const queueArn = required(source, 'BILLING_QUEUE_ARN'), replayRuleArn = required(source, 'BILLING_REPLAY_RULE_ARN');
  if (!awsAccountIdPattern.test(account) || !new RegExp(`^arn:aws:sqs:${region}:${account}:[A-Za-z0-9_-]+$`).test(queueArn) ||
      !new RegExp(`^arn:aws:events:${region}:${account}:rule/[A-Za-z0-9_.-]+$`).test(replayRuleArn)) throw new Error('billing_resource_scope_mismatch');
  const queueUrl = required(source, 'BILLING_QUEUE_URL');
  const expectedQueueUrl = `https://sqs.${region}.amazonaws.com/${account}/${queueArn.split(':')[5]}`;
  if (queueUrl !== expectedQueueUrl) throw new Error('billing_queue_url_mismatch');
  return { environment, scope: { environment, aws_account_id: account, region, stripe_account: required(source, 'STRIPE_ACCOUNT_ID') },
    stateTable: required(source, 'BILLING_STATE_TABLE'), entitlementTable: required(source, 'BILLING_ENTITLEMENTS_TABLE'),
    catalogParameter: required(source, 'BILLING_CATALOG_PARAMETER'), stripeKeyParameter: required(source, 'STRIPE_KEY_PARAMETER'),
    webhookSecretParameter: required(source, 'STRIPE_WEBHOOK_SECRET_PARAMETER'), queueUrl, queueArn,
    replayRuleArn, successUrl: required(source, 'BILLING_SUCCESS_URL'), cancelUrl: required(source, 'BILLING_CANCEL_URL'),
    supportEmail: required(source, 'BILLING_SUPPORT_EMAIL'), live: source.STRIPE_LIVE === 'true', budgets: budgets as RuntimeBudgets };
}
export function composeBillingHandler(config: HandlerConfig, service: BillingService, telemetry: Telemetry,
  readCatalog: ReturnType<typeof parameterCatalog>['read'], webhookSecret: () => Promise<string>) {
  const native = createBillingDispatcher(config.environment, config.supportEmail, {
    catalog: async () => (await readCatalog()).catalog,
    entitlement: identity => service.store.get(service.store.key(identity, 'ENTITLEMENT'), true),
    owns: request => service.owns(request), now: () => Math.floor(Date.now() / 1000),
    operations: { quoteUpgrade: request => service.quoteUpgrade(request), confirmUpgrade: request => service.confirmUpgrade(request), createCheckout: request => service.checkout(request), getOrder: request => service.getOrder(request),
      reconcileOrder: request => service.reconcile(request), manageSubscription: async request => ({
        schema_version: 1, correlation_id: request.correlation_id, outcome: 'ok', retryable: false, message: 'Select an upgrade.',
        payload: { subscription_id: request.input.subscription_id, next_action: 'select_upgrade' } }),
    },
  }, telemetry);
  const webhook = withBillingHttpTelemetry(telemetry, 'billing.webhook', async (event: HttpEvent & Record<string, any>) => {
    if (event.httpMethod !== 'POST' || event.path !== '/billing/webhook' || typeof event.body !== 'string' || Buffer.byteLength(event.body) > 1500000) return { statusCode: 400 };
    let trusted: Record<string, any>;
    let digest: string;
    const secret = await webhookSecret();
    try {
      if (event.isBase64Encoded && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body))) throw new Error('invalid_base64');
      const raw = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      digest = createHash('sha256').update(raw).digest('hex');
      trusted = verifyWebhook(raw, header(event.headers, 'stripe-signature', event.multiValueHeaders) ?? '', secret,
        config.live, config.scope.stripe_account, Math.floor(Date.now() / 1000));
    } catch { return { statusCode: 400, body: '{"error":"invalid_webhook"}' }; }
    const outcome = await service.processStripeEvent(trusted, digest);
    if (outcome === 'invalid') return { statusCode: 400 };
    return { statusCode: 200, body: '{"received":true}' };
  });
  const http = createBillingHttpAdapter(webhook);
  const record = withSqsRecordTelemetry(telemetry, async incoming => {
    if (Buffer.byteLength(incoming.body) > 4096) throw new Error('invalid_queue_message');
    const message: unknown = JSON.parse(incoming.body); validateQueue(message, config.environment);
    await service.consume(message as Record<string, any>);
  });
  const replay = withReplayTelemetry(telemetry, async () => service.replay());
  return async (event: unknown, context: InvocationContext) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid_billing_event');
    const value = event as Record<string, any>;
    const kinds = [typeof value.operation === 'string', Array.isArray(value.Records), value.source === 'aws.events', typeof value.httpMethod === 'string'];
    if (kinds.filter(Boolean).length !== 1) throw new Error('ambiguous_billing_event');
    if (kinds[0]) return native(value as BillingRequest, context);
    if (kinds[1]) {
      if (value.Records.length > 10 || value.Records.some((r: Record<string, any>) => r.eventSource !== 'aws:sqs' || r.eventSourceARN !== config.queueArn ||
          typeof r.messageId !== 'string' || typeof r.body !== 'string')) throw new Error('invalid_sqs_source');
      const batchItemFailures: { itemIdentifier: string }[] = [];
      for (const incoming of value.Records) try { await record(incoming, context); } catch { batchItemFailures.push({ itemIdentifier: incoming.messageId }); }
      return { batchItemFailures };
    }
    if (kinds[2]) {
      if (value['detail-type'] !== 'Scheduled Event' || !Array.isArray(value.resources) || value.resources.length !== 1 || value.resources[0] !== config.replayRuleArn) throw new Error('invalid_replay_source');
      await replay(value, context); return;
    }
    return http.invoke(value, context);
  };
}
let initialized: ReturnType<typeof composeBillingHandler> | undefined;
/** Lambda entrypoint. AWS clients are constructed lazily and reused on warm invocations. */
export async function handler(event: unknown, context: InvocationContext) {
  try {
    if (!initialized) {
      const config = runtimeConfig(process.env);
      const telemetry = new Telemetry(configFromEnvironment('billing', process.env));
      const store = new BillingStore(config.environment, config.stateTable, config.entitlementTable, telemetry);
      const catalog = parameterCatalog(config.catalogParameter, config.scope, telemetry, undefined, { max_age_ms: config.budgets.catalog_cache_seconds * 1000, fetch_timeout_ms: config.budgets.catalog_fetch_timeout_ms });
      const stripe = new StripeAdapter(parameterSecret(config.stripeKeyParameter, telemetry), {
        account: config.scope.stripe_account, live: config.live, successUrl: config.successUrl, cancelUrl: config.cancelUrl, maxPages: config.budgets.max_pages,
      }, telemetry);
      const service = new BillingService(store, stripe, new BillingQueue(config.queueUrl, config.environment, telemetry), () => catalog.read(),
        config.scope.stripe_account, config.supportEmail, config.budgets, telemetry);
      initialized = composeBillingHandler(config, service, telemetry, () => catalog.read(), parameterSecret(config.webhookSecretParameter, telemetry));
    }
    return await initialized(event, context);
  } catch { throw new Error('billing_invocation_failed'); }
}
