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
const routeOperations: Record<string, Operation> = { '/authorize': 'http.authorize', '/login': 'http.login', '/oauth/cognito/callback': 'http.callback',
  '/billing': 'http.billing', '/onboarding': 'http.status', '/logout': 'http.login', '/token': 'http.token', '/revoke': 'http.token', '/onboarding/resume': 'http.resume' };
export async function composeAccessHandler(config: AccessConfiguration, sessions: BrowserSessions, publicJwks: unknown, telemetry: Telemetry) {
  const app = await createAccessApp(config, sessions, publicJwks);
  const proxy = serverlessExpress({ app, eventSourceName: 'AWS_API_GATEWAY_V1', respondWithErrors: false, logSettings: { level: 'none' } });
  return async (event: unknown, context: InvocationContext): Promise<HttpResult> => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid_access_event');
    const value = event as HttpEvent & Record<string, any>;
    if (typeof value.httpMethod !== 'string' || typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > 2048 ||
        value.version !== undefined || value.routeKey !== undefined || value.Records !== undefined || value.operation !== undefined || value.source !== undefined || (value.requestContext as Record<string, unknown> | undefined)?.http !== undefined) throw new Error('invalid_access_event');
    const observed = withAccessHttpTelemetry(telemetry, routeOperations[value.path] ?? 'http.discovery', async () => {
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
      const configPath = process.env.ACCESS_CONFIG_PATH, publicKeysPath = process.env.ACCESS_PUBLIC_JWKS_PATH;
      const state = process.env.ACCESS_STATE_TABLE, entitlements = process.env.BILLING_ENTITLEMENTS_TABLE;
      if (!configPath || !publicKeysPath || !state || !entitlements) throw new Error('invalid_access_configuration');
      const config = validateAccessConfiguration(JSON.parse(readFileSync(configPath, 'utf8')) as AccessConfiguration);
      if (config.environment !== process.env.MCP_ENVIRONMENT) throw new Error('invalid_access_configuration');
      const telemetry = new Telemetry(configFromEnvironment('access', process.env));
      const store = new AccessStore(config.environment, state, entitlements, telemetry);
      return composeAccessHandler(config, new BrowserSessions(config, store, new CognitoIdentity(config.cognito, telemetry), telemetry), JSON.parse(readFileSync(publicKeysPath, 'utf8')), telemetry);
    })().catch(() => { initialized = undefined; throw new Error('access_configuration_failed'); });
    return await (await initialized)(event, context);
  } catch { throw new Error('access_invocation_failed'); }
}
