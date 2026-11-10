export type Service = 'access' | 'authorizer' | 'billing';
export type Environment = 'development' | 'test' | 'production';
export const operations = [
  'http.authorize', 'http.callback', 'http.token', 'http.status', 'http.resume', 'http.login', 'http.billing', 'http.discovery',
  'authorizer.validate', 'billing.webhook', 'billing.listPlans', 'billing.createCheckout', 'billing.getOrder',
  'billing.reconcileOrder', 'billing.quoteUpgrade', 'billing.confirmUpgrade', 'billing.manageSubscription', 'billing.openPortal',
  'billing.reconcile', 'billing.replay', 'lambda.invoke_billing', 'dynamodb.read', 'dynamodb.transact',
  'cognito.request', 'jwks.request', 'ssm.catalog', 'ssm.secret', 'ssm.signing_key', 'gateway.provision', 'stripe.request', 'sqs.publish',
] as const;
export type Operation = typeof operations[number];
export interface TelemetryConfig { service: Service; environment: Environment; release: string; metrics?: boolean }
export function validatedConfig(input: TelemetryConfig) {
  if (!['access','authorizer','billing'].includes(input.service) || !['production','development','test'].includes(input.environment) ||
      typeof input.release !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(input.release) ||
      (input.metrics !== undefined && typeof input.metrics !== 'boolean')) throw new Error('invalid_telemetry_config');
  return Object.freeze({ service: input.service, environment: input.environment, release: input.release,
    metrics: input.metrics ?? input.environment === 'production' });
}
/** Read named nonsecret settings only. X-Ray tracing/sampling is configured in AWS IaC. */
export function configFromEnvironment(service: Service, source: Record<string, string | undefined>): TelemetryConfig {
  if (source.MCP_SERVICE !== undefined && source.MCP_SERVICE !== service) throw new Error('invalid_telemetry_service');
  const config: TelemetryConfig = { service, environment: (source.MCP_ENVIRONMENT ?? 'development') as Environment,
    release: source.MCP_RELEASE ?? 'unknown' };
  validatedConfig(config);
  return config;
}
