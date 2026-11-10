import { decodeProtectedHeader, jwtVerify } from 'jose';
import { TrustedJwks, remoteJwks } from '../security/jwks.js';
import { validateTrust, validateServiceClaims, parseScopes, opaqueId, type TokenTrust } from '../security/service-token.js';
import { header } from '../observability/context.js';
import { withAuthorizerTelemetry, type HttpEvent } from '../observability/adapters.js';
import { Telemetry } from '../observability/telemetry.js';
import { configFromEnvironment } from '../observability/config.js';
import { awsAccountIdPattern, identifierPattern } from '../contracts/patterns.js';
export interface AuthorizerConfig extends TokenTrust {
  region: string; accountId: string; apiId: string; stage: string;
  routes: Array<{ method: string; path: string; scope: string }>;
}
export interface RequestEvent extends HttpEvent { type: string; methodArn: string; routeArn?: unknown; version?: unknown }
export function validateAuthorizerConfig(input: AuthorizerConfig) {
  const fields = ['issuer','resource','clientIds','clockSkewSeconds','region','accountId','apiId','stage','routes'];
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !fields.includes(key))) throw new Error('invalid_authorizer_configuration');
  validateTrust(input);
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(input.region) || !awsAccountIdPattern.test(input.accountId) ||
      !/^[a-z0-9]{1,32}$/.test(input.apiId) || !identifierPattern.test(input.stage) || !Array.isArray(input.routes) || !input.routes.length || input.routes.length > 32) throw new Error('invalid_authorizer_configuration');
  const seen = new Set<string>();
  for (const route of input.routes) {
    if (!route || typeof route !== 'object' || Object.keys(route).some(key => !['method','path','scope'].includes(key))) throw new Error('invalid_authorizer_configuration');
    const id = `${route.method}/${route.path}`;
    if (!['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].includes(route.method) ||
        !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route.path) || parseScopes(route.scope).length !== 1 || seen.has(id)) throw new Error('invalid_authorizer_configuration');
    seen.add(id);
  }
  return structuredClone(input);
}
export function createAuthorizer(input: AuthorizerConfig, jwks: TrustedJwks, telemetry: Telemetry, now = () => Math.floor(Date.now() / 1000)) {
  const config = validateAuthorizerConfig(input);
  const prefix = `arn:aws:execute-api:${config.region}:${config.accountId}:${config.apiId}/${config.stage}/`;
  const observed = withAuthorizerTelemetry(telemetry, async (event: RequestEvent) => {
    const deny = (): never => { throw new Error('Unauthorized'); };
    if (event.type !== 'REQUEST' || event.routeArn !== undefined || event.version !== undefined || typeof event.methodArn !== 'string' || !event.methodArn.startsWith(prefix)) deny();
    const route = config.routes.find(route => event.methodArn === `${prefix}${route.method}/${route.path}`);
    if (!route) deny();
    const authorization = header(event.headers, 'authorization', event.multiValueHeaders);
    if (!authorization || authorization.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) deny();
    const token = authorization!.slice(7);
    let kid: string;
    try {
      const protectedHeader = decodeProtectedHeader(token);
      if (protectedHeader.alg !== 'RS256' || protectedHeader.typ !== 'at+jwt' || typeof protectedHeader.kid !== 'string' || !opaqueId.test(protectedHeader.kid) ||
          ['jku','jwk','x5u','x5c','crit'].some(key => protectedHeader[key] !== undefined)) deny();
      kid = protectedHeader.kid!;
    } catch { return deny(); }
    let key: CryptoKey;
    try { key = await jwks.get(kid); }
    catch (error) {
      if (error instanceof Error && error.message === 'unknown_signing_key') return deny();
      throw new Error('trusted_keys_unavailable');
    }
    let claims;
    try {
      const result = await jwtVerify(token, key, { algorithms: ['RS256'], issuer: config.issuer, audience: config.resource,
        clockTolerance: config.clockSkewSeconds, currentDate: new Date(now() * 1000) });
      claims = validateServiceClaims(result.payload, config, now());
    } catch (error) {
      if (error instanceof Error && error.message !== 'invalid_access_token' &&
          !error.name.startsWith('JWT') && !error.name.startsWith('JWS') && !error.name.startsWith('JOSE')) throw new Error('verification_unavailable');
      return deny();
    }
    if (!claims) deny();
    const permitted = parseScopes(claims!.scope).includes(route!.scope);
    return { principalId: claims!.sub,
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: permitted ? 'Allow' : 'Deny', Resource: event.methodArn }] },
      ...(permitted ? { usageIdentifierKey: claims!.usageIdentifierKey } : {}), context: { authorization: permitted ? 'access' : 'insufficient_scope' } };
  });
  return (event: RequestEvent, context: { awsRequestId?: string }) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return Promise.reject(new Error('Unauthorized'));
    return observed(event, context);
  };
}
let initialized: ReturnType<typeof createAuthorizer> | undefined;
export async function handler(event: RequestEvent, context: { awsRequestId?: string }) {
  if (!initialized) {
    try {
      const raw = process.env.AUTHORIZER_CONFIG; if (!raw || !process.env.SERVICE_JWKS_URI) throw new Error('invalid_configuration');
      const config = JSON.parse(raw) as AuthorizerConfig;
      const telemetry = new Telemetry(configFromEnvironment('authorizer', process.env));
      const source = remoteJwks(process.env.SERVICE_JWKS_URI, (url, init) => fetch(url, { ...init, headers: {
        ...(telemetry.currentCorrelationId() ? { 'x-correlation-id': telemetry.currentCorrelationId()! } : {}),
        ...(telemetry.currentTraceHeader() ? { 'x-amzn-trace-id': telemetry.currentTraceHeader()! } : {}),
      } }), work => telemetry.dependency('jwks.request', work));
      initialized = createAuthorizer(config, source, telemetry);
    } catch { throw new Error('authorizer_configuration_failed'); }
  }
  return initialized(event, context);
}
