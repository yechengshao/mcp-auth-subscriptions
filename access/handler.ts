import { readFileSync } from 'node:fs';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { AccessStore } from './store.js';
import { CognitoIdentity } from './identity.js';
import { BrowserSessions } from './sessions.js';
import { createAccessApp } from './app.js';
import { validateAccessConfiguration, type AccessConfiguration } from './config.js';
import { withAccessHttpTelemetry, Telemetry } from './observability.js';
import { configFromEnvironment, type Operation } from '../observability/config.js';
import type { HttpEvent, HttpResult, InvocationContext } from '../observability/adapters.js';
import type { OAuthExtension } from './http/types.js';
import { createOAuthExtension } from './http/oauth-extension.js';
import { AccessTokens } from './tokens.js';
import { awsSigningBackend, createServiceTokenSigner, createSigningKeys, type PublicKeySource } from './signing.js';
import { BillingAliasInvoker } from './adapters/billing.js';
import { createBillingAliasResolver } from './billing-alias.js';
import { createUsageBindingProvisioner } from './provisioning.js';
import { createRestApiTarget } from './rest-api-target.js';
import { Onboarding } from './onboarding.js';
import { Management } from './management.js';
const routeOperations: Record<string, Operation> = { '/authorize': 'http.authorize', '/login': 'http.login', '/oauth/cognito/callback': 'http.callback',
  '/billing': 'http.billing', '/billing/checkout': 'http.billing', '/billing/return': 'http.billing',
  '/billing/plans': 'http.billing', '/billing/status': 'http.billing', '/billing/portal': 'http.billing',
  '/onboarding': 'http.status', '/onboarding/status': 'http.status', '/logout': 'http.login', '/token': 'http.token',
  '/revoke': 'http.token', '/onboarding/resume': 'http.resume' };
function configuredJson(environmentName: string, pathName: string): unknown {
  const source = process.env[environmentName];
  if (source !== undefined) {
    if (source.length > 16_384) throw new Error('invalid_access_configuration');
    return JSON.parse(source) as unknown;
  }
  const path = process.env[pathName];
  if (!path) throw new Error('invalid_access_configuration');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
function assertRuntimeEnvironmentSize(source: Record<string, string | undefined>) {
  const keys = ['MCP_SERVICE', 'MCP_ENVIRONMENT', 'MCP_RELEASE', 'ACCESS_STATE_TABLE', 'BILLING_ENTITLEMENTS_TABLE',
    'ACCESS_AWS_ACCOUNT_ID', 'BILLING_ALIAS_PARAMETER_NAME', 'ACCESS_CONFIG_JSON', 'ACCESS_SIGNING_KEY_ARN_PARAMETER', 'ACCESS_REST_API_ID_PARAMETER',
    'ACCESS_STAGE_PARAMETER', 'ACCESS_TOKEN_TTL_SECONDS'];
  const size = keys.reduce((total, key) => total + Buffer.byteLength(key) + Buffer.byteLength(source[key] ?? '') + 2, 0);
  if (size > 3800) throw new Error('invalid_access_configuration');
}
export async function composeAccessHandler(config: AccessConfiguration, sessions: BrowserSessions, publicKeys: PublicKeySource,
  telemetry: Telemetry, extension?: OAuthExtension) {
  const app = await createAccessApp(config, sessions, publicKeys, extension);
  const proxy = serverlessExpress({ app, eventSourceName: 'AWS_API_GATEWAY_V1', respondWithErrors: false, logSettings: { level: 'none' } });
  return async (event: unknown, context: InvocationContext): Promise<HttpResult> => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid_access_event');
    const value = event as HttpEvent & Record<string, any>;
    if (typeof value.httpMethod !== 'string' || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 2048 ||
        value.version !== undefined || value.routeKey !== undefined || value.Records !== undefined || value.operation !== undefined || value.source !== undefined || (value.requestContext as Record<string, unknown> | undefined)?.http !== undefined) throw new Error('invalid_access_event');
    const operation = routeOperations[value.path] ?? (value.path.startsWith('/billing/orders/') ||
      value.path.startsWith('/billing/subscriptions/') ? 'http.billing' : 'http.discovery');
    const observed = withAccessHttpTelemetry(telemetry, operation, async () => {
      const result = await proxy(value, context as any, () => undefined);
      if (!result) throw new Error('invalid_access_response');
      return result as HttpResult;
    });
    return observed(value, context);
  };
}
let initialized: Promise<Awaited<ReturnType<typeof composeAccessHandler>>> | undefined;
export async function handler(event: unknown, context: InvocationContext) {
  try {
    if (!initialized) initialized = (async () => {
      assertRuntimeEnvironmentSize(process.env);
      const state = process.env.ACCESS_STATE_TABLE, entitlements = process.env.BILLING_ENTITLEMENTS_TABLE;
      const signingKeyParameter = process.env.ACCESS_SIGNING_KEY_ARN_PARAMETER, restApiParameter = process.env.ACCESS_REST_API_ID_PARAMETER;
      const stageParameter = process.env.ACCESS_STAGE_PARAMETER;
      const accountId = process.env.ACCESS_AWS_ACCOUNT_ID, billingAliasParameter = process.env.BILLING_ALIAS_PARAMETER_NAME;
      if (!state || !entitlements || !signingKeyParameter || !restApiParameter || !stageParameter || !accountId || !billingAliasParameter) {
        throw new Error('invalid_access_configuration');
      }
      const config = validateAccessConfiguration(configuredJson('ACCESS_CONFIG_JSON', 'ACCESS_CONFIG_PATH') as AccessConfiguration);
      if (config.environment !== process.env.MCP_ENVIRONMENT) throw new Error('invalid_access_configuration');
      const telemetry = new Telemetry(configFromEnvironment('access', process.env));
      const store = new AccessStore(config.environment, state, entitlements, telemetry);
      const sessions = new BrowserSessions(config, store, new CognitoIdentity(config.cognito, telemetry), telemetry);
      const trust = { issuer: config.issuer, resource: config.resource,
        clientIds: config.clients.map(client => client.client_id), clockSkewSeconds: 5 };
      const keys = createSigningKeys(awsSigningBackend(signingKeyParameter, telemetry));
      const restApiTarget = createRestApiTarget(restApiParameter, stageParameter);
      const tokens = new AccessTokens(store, createServiceTokenSigner(trust, keys), {
        ...trust, accessTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? '3600'), target: restApiTarget,
      }, telemetry);
      const billingAliasArn = await createBillingAliasResolver(billingAliasParameter, accountId)();
      const billing = new BillingAliasInvoker(telemetry, { environment: config.environment, accountId, aliasArn: billingAliasArn });
      const provisioner = createUsageBindingProvisioner(store, telemetry, restApiTarget);
      const onboarding = new Onboarding(store, billing, provisioner, telemetry);
      const management = new Management(store, billing, provisioner, telemetry);
      const extension = createOAuthExtension({ config, sessions, tokens, onboarding, management, telemetry });
      return composeAccessHandler(config, sessions, keys, telemetry, extension);
    })().catch(() => { initialized = undefined; throw new Error('access_configuration_failed'); });
    return await (await initialized)(event, context);
  } catch { throw new Error('access_invocation_failed'); }
}
