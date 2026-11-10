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
import { createServiceTokenSigner, createSigningKeyCache, ssmSigningLoader, type SigningConfiguration } from './signing.js';
import { BillingAliasInvoker } from './adapters/billing.js';
import { createUsageBindingProvisioner, type AccessProvisioningConfiguration } from './provisioning.js';
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
    'ACCESS_AWS_ACCOUNT_ID', 'ACCESS_BILLING_LAMBDA_ALIAS_ARN', 'ACCESS_CONFIG_JSON', 'ACCESS_PUBLIC_JWKS_JSON',
    'ACCESS_SIGNING_CONFIG_JSON', 'ACCESS_PROVISIONING_CONFIG_JSON', 'ACCESS_TOKEN_TTL_SECONDS'];
  const size = keys.reduce((total, key) => total + Buffer.byteLength(key) + Buffer.byteLength(source[key] ?? '') + 2, 0);
  if (size > 3800) throw new Error('invalid_access_configuration');
}
export async function composeAccessHandler(config: AccessConfiguration, sessions: BrowserSessions, publicJwks: unknown,
  telemetry: Telemetry, extension?: OAuthExtension) {
  const app = await createAccessApp(config, sessions, publicJwks, extension);
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
      const signingConfigured = process.env.ACCESS_SIGNING_CONFIG_JSON !== undefined || process.env.ACCESS_SIGNING_CONFIG_PATH !== undefined;
      const provisioningConfigured = process.env.ACCESS_PROVISIONING_CONFIG_JSON !== undefined || process.env.ACCESS_PROVISIONING_CONFIG_PATH !== undefined;
      const billingAliasArn = process.env.ACCESS_BILLING_LAMBDA_ALIAS_ARN, accountId = process.env.ACCESS_AWS_ACCOUNT_ID;
      if (!state || !entitlements || !signingConfigured || !provisioningConfigured || !billingAliasArn || !accountId) {
        throw new Error('invalid_access_configuration');
      }
      const config = validateAccessConfiguration(configuredJson('ACCESS_CONFIG_JSON', 'ACCESS_CONFIG_PATH') as AccessConfiguration);
      if (config.environment !== process.env.MCP_ENVIRONMENT) throw new Error('invalid_access_configuration');
      const telemetry = new Telemetry(configFromEnvironment('access', process.env));
      const store = new AccessStore(config.environment, state, entitlements, telemetry);
      const sessions = new BrowserSessions(config, store, new CognitoIdentity(config.cognito, telemetry), telemetry);
      const signing = configuredJson('ACCESS_SIGNING_CONFIG_JSON', 'ACCESS_SIGNING_CONFIG_PATH') as SigningConfiguration;
      const provisioning = configuredJson('ACCESS_PROVISIONING_CONFIG_JSON', 'ACCESS_PROVISIONING_CONFIG_PATH') as AccessProvisioningConfiguration;
      const trust = { issuer: config.issuer, resource: config.resource,
        clientIds: config.clients.map(client => client.client_id), clockSkewSeconds: 5 };
      const keyCache = createSigningKeyCache(ssmSigningLoader(signing, telemetry), signing);
      const tokens = new AccessTokens(store, createServiceTokenSigner(trust, keyCache), {
        ...trust, accessTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? '3600'),
        restApiId: provisioning.target.rest_api_id, stage: provisioning.target.stage,
      }, telemetry);
      const billing = new BillingAliasInvoker(telemetry, { environment: config.environment, accountId, aliasArn: billingAliasArn });
      const provisioner = createUsageBindingProvisioner(store, telemetry, provisioning);
      const onboarding = new Onboarding(store, billing, provisioner, telemetry);
      const management = new Management(store, billing, provisioner, telemetry);
      const extension = createOAuthExtension({ config, sessions, tokens, onboarding, management, telemetry });
      return composeAccessHandler(config, sessions, configuredJson('ACCESS_PUBLIC_JWKS_JSON', 'ACCESS_PUBLIC_JWKS_PATH'), telemetry, extension);
    })().catch(() => { initialized = undefined; throw new Error('access_configuration_failed'); });
    return await (await initialized)(event, context);
  } catch { throw new Error('access_invocation_failed'); }
}
