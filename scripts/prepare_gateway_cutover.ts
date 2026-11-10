import { readFileSync } from 'node:fs';

type Owner = 'service' | 'access' | 'billing';
type Route = { path: string; method: string; owner: Owner; alias_arn: string; authorizer: boolean; api_key_required: boolean };
export interface GatewayCutoverInput {
  schema_version: 1;
  environment: string;
  legacy_http: { api_id: string; endpoint: string; stage: string; secured: boolean; retained: boolean };
  target_rest: {
    api_id: string; endpoint: string; stage: string; deployment_id: string;
    aliases: { service: string; access: string; billing: string; authorizer: string };
    routes: Route[];
  };
  rollback: { client_config_backup_sha256: string; legacy_security_restore_plan: string; rollback_owner: string };
}

const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const apiId = /^[a-z0-9]{10}$/;
const arn = /^arn:(aws|aws-us-gov|aws-cn):lambda:([a-z0-9-]+):(\d{12}):function:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,128})$/;
const hash = /^[a-f0-9]{64}$/;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ANY']);
const requiredCoreRoutes = [
  { path: '/mcp', method: 'ANY', owner: 'service' as const, authorizer: true, apiKeyRequired: true },
  { path: '/health', method: 'GET', owner: 'service' as const, authorizer: true, apiKeyRequired: true },
  { path: '/webhooks/stripe', method: 'POST', owner: 'billing' as const, authorizer: false, apiKeyRequired: false },
];

function fail(): never { throw new Error('invalid_gateway_cutover_manifest'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalHttps(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
function canonicalRestEndpoint(value: string, apiId: string, stage: string): boolean {
  try {
    const url = new URL(value);
    return canonicalHttps(value) && url.hostname.startsWith(`${apiId}.execute-api.`) &&
      (url.hostname.endsWith('.amazonaws.com') || url.hostname.endsWith('.amazonaws.com.cn')) &&
      url.pathname === `/${stage}`;
  } catch { return false; }
}
function aliasArn(value: unknown): value is string { return typeof value === 'string' && arn.test(value); }
function routeAllowed(route: Route): boolean {
  const { path, method, owner } = route;
  if (!path.startsWith('/') || path.length > 256 || path.includes('//') || path.includes('*') || path.includes('+') || path.includes('..') ||
      !allowedMethods.has(method) || (method !== 'ANY' && method !== method.toUpperCase())) return false;
  if (owner === 'service') return (path === '/mcp' && method === 'ANY') || (path === '/health' && method === 'GET');
  if (owner === 'billing') return path === '/webhooks/stripe' && method === 'POST';
  if (path.startsWith('/.well-known/')) return method === 'GET';
  const exact: Record<string, readonly string[]> = {
    '/jwks.json': ['GET'], '/billing': ['GET'], '/login': ['GET'], '/authorize': ['GET'],
    '/oauth/cognito/callback': ['GET'], '/onboarding': ['GET'], '/onboarding/status': ['POST'],
    '/onboarding/resume': ['POST'], '/token': ['POST'], '/revoke': ['POST'], '/logout': ['POST'],
    '/billing/plans': ['GET'], '/billing/checkout': ['POST'], '/billing/return': ['GET'],
    '/billing/orders/{orderId}': ['GET'], '/billing/subscriptions/{subscriptionRef}/manage': ['POST'],
    '/billing/portal': ['POST'],
  };
  return exact[path]?.includes(method) ?? false;
}

/** Validate a manually collected manifest and produce a plan-only review artifact; performs no cloud/client actions. */
export function prepareGatewayCutover(input: unknown) {
  if (!record(input) || input.schema_version !== 1 || typeof input.environment !== 'string' || !id.test(input.environment) ||
      !record(input.legacy_http) || !record(input.target_rest) || !record(input.rollback)) fail();
  const legacy = input.legacy_http as GatewayCutoverInput['legacy_http'];
  const target = input.target_rest as GatewayCutoverInput['target_rest'];
  const rollback = input.rollback as GatewayCutoverInput['rollback'];
  if (!apiId.test(legacy.api_id) || !canonicalHttps(legacy.endpoint) || !(id.test(legacy.stage) || legacy.stage === '$default') ||
      typeof legacy.secured !== 'boolean' || !legacy.secured || typeof legacy.retained !== 'boolean' || !legacy.retained ||
      !apiId.test(target.api_id) || target.api_id === legacy.api_id || !canonicalHttps(target.endpoint) ||
      target.endpoint === legacy.endpoint || !id.test(target.stage) || target.stage === '$default' ||
      !id.test(target.deployment_id) || !hash.test(rollback.client_config_backup_sha256) ||
      typeof rollback.legacy_security_restore_plan !== 'string' || rollback.legacy_security_restore_plan.trim().length < 12 ||
      typeof rollback.rollback_owner !== 'string' || !id.test(rollback.rollback_owner) ||
      !record(target.aliases) || !Array.isArray(target.routes)) fail();
  if (!canonicalRestEndpoint(target.endpoint, target.api_id, target.stage)) fail();

  const aliases = target.aliases as GatewayCutoverInput['target_rest']['aliases'];
  if (![aliases.service, aliases.access, aliases.billing, aliases.authorizer].every(aliasArn)) fail();
  const components = [aliases.service, aliases.access, aliases.billing, aliases.authorizer].map(value => arn.exec(value)!);
  if (new Set([aliases.service, aliases.access, aliases.billing, aliases.authorizer]).size !== 4 ||
      new Set(components.map(value => `${value[2]}:${value[3]}`)).size !== 1) fail();

  const seen = new Set<string>();
  const routes = target.routes as Route[];
  for (const route of routes) {
    if (!record(route) || !['service', 'access', 'billing'].includes(route.owner) || !aliasArn(route.alias_arn) ||
        typeof route.authorizer !== 'boolean' || typeof route.api_key_required !== 'boolean' || !routeAllowed(route)) fail();
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) fail();
    seen.add(key);
    const expectedAlias = aliases[route.owner];
    if (route.alias_arn !== expectedAlias) fail();
    if (route.owner === 'service' && (!route.authorizer || !route.api_key_required)) fail();
    if (route.owner !== 'service' && (route.authorizer || route.api_key_required)) fail();
  }
  for (const required of requiredCoreRoutes) {
    const actual = routes.find(route => route.path === required.path && route.method === required.method);
    if (!actual || actual.owner !== required.owner || actual.authorizer !== required.authorizer ||
        actual.api_key_required !== required.apiKeyRequired) fail();
  }
  return {
    schema_version: 1,
    mode: 'read_only_cutover_preflight',
    environment: input.environment,
    legacy_endpoint: { protocol: 'HTTP_API', api_id: legacy.api_id, stage: legacy.stage, endpoint: legacy.endpoint, secured: true, retained: true },
    target_endpoint: { protocol: 'REST_API', api_id: target.api_id, stage: target.stage, deployment_id: target.deployment_id, endpoint: target.endpoint },
    reviewed_aliases: { service: aliases.service, access: aliases.access, billing: aliases.billing, authorizer: aliases.authorizer },
    routes_reviewed: routes.map(({ method, path, owner }) => ({ method, path, owner })),
    rollback: { client_config_backup_sha256: rollback.client_config_backup_sha256,
      legacy_security_restore_plan: rollback.legacy_security_restore_plan.trim(), rollback_owner: rollback.rollback_owner },
    cutover_executed: false,
    cloud_state_independently_verified: false,
    manual_review_required: true,
  };
}

if (process.argv[1]?.endsWith('/prepare_gateway_cutover.js')) {
  try {
    const inputPath = process.argv[2];
    if (!inputPath || process.argv.length !== 3) throw new Error('usage: prepare_gateway_cutover <manifest.json>');
    const input = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
    process.stdout.write(`${JSON.stringify(prepareGatewayCutover(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid_gateway_cutover_manifest'}\n`);
    process.exitCode = 2;
  }
}
