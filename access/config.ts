import { validateHttps, opaqueId, parseScopes } from '../security/service-token.js';

export interface RegisteredClient { client_id: string; redirect_uris: string[]; scopes: string[] }
export interface CognitoConfiguration { issuer: string; domain: string; clientId: string; callbackUri: string; scopes: string[] }
export interface AccessConfiguration {
  environment: string; issuer: string; resource: string; clientConfigVersion: string; cookieName: string;
  clients: RegisteredClient[]; cognito: CognitoConfiguration;
}

function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) {
    throw new Error('invalid_access_configuration');
  }
}

function validScopes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(scope => typeof scope !== 'string')) return false;
  try { return parseScopes(value.join(' ')).length === value.length; }
  catch { return false; }
}

export function endpoint(config: { issuer: string }, path: string) { return config.issuer.replace(/\/$/, '') + path; }

export function validateCognitoConfiguration(input: unknown): CognitoConfiguration {
  fields(input, ['issuer','domain','clientId','callbackUri','scopes']);
  if (typeof input.issuer !== 'string' || typeof input.domain !== 'string' || typeof input.clientId !== 'string' ||
      typeof input.callbackUri !== 'string' || !validScopes(input.scopes)) throw new Error('invalid_access_configuration');
  validateHttps(input.issuer); validateHttps(input.domain); validateHttps(input.callbackUri);
  const domain = new URL(input.domain);
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(input.issuer) ||
      domain.pathname !== '/' || !/^[A-Za-z0-9_]{1,128}$/.test(input.clientId) || !input.scopes.includes('openid')) {
    throw new Error('invalid_access_configuration');
  }
  return structuredClone(input) as unknown as CognitoConfiguration;
}

export function validateAccessConfiguration(input: unknown): AccessConfiguration {
  fields(input, ['environment','issuer','resource','clientConfigVersion','cookieName','clients','cognito']);
  if (typeof input.environment !== 'string' || typeof input.issuer !== 'string' || typeof input.resource !== 'string' ||
      typeof input.clientConfigVersion !== 'string' || typeof input.cookieName !== 'string' ||
      !Array.isArray(input.clients) || input.clients.length < 1 || input.clients.length > 100) {
    throw new Error('invalid_access_configuration');
  }
  validateHttps(input.issuer); validateHttps(input.resource);
  if (!opaqueId.test(input.environment) || !opaqueId.test(input.clientConfigVersion) ||
      !/^__Host-[A-Za-z0-9_-]{1,80}$/.test(input.cookieName) || !new URL(input.resource).pathname.endsWith('/mcp')) {
    throw new Error('invalid_access_configuration');
  }
  const seen = new Set<string>();
  for (const raw of input.clients) {
    fields(raw, ['client_id','redirect_uris','scopes']);
    if (typeof raw.client_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(raw.client_id) || seen.has(raw.client_id) ||
        !Array.isArray(raw.redirect_uris) || !raw.redirect_uris.length || raw.redirect_uris.length > 10 ||
        raw.redirect_uris.some(uri => typeof uri !== 'string') || new Set(raw.redirect_uris).size !== raw.redirect_uris.length ||
        !validScopes(raw.scopes)) throw new Error('invalid_access_configuration');
    for (const uri of raw.redirect_uris) {
      if (uri.length > 2048 || uri.includes('*')) throw new Error('invalid_access_configuration');
      let parsed: URL;
      try { parsed = new URL(uri); } catch { throw new Error('invalid_access_configuration'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw new Error('invalid_access_configuration');
      }
    }
    seen.add(raw.client_id);
  }
  const cognito = validateCognitoConfiguration(input.cognito);
  if (cognito.callbackUri !== endpoint(input, '/oauth/cognito/callback')) throw new Error('invalid_access_configuration');
  return structuredClone({ ...input, cognito }) as unknown as AccessConfiguration;
}

export function stringParameters(input: unknown, allowed: string[]): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key) || typeof value !== 'string' || !value || value.length > 4096) throw new Error('invalid_request');
    result[key] = value;
  }
  return result;
}

export function authorizeParameters(config: AccessConfiguration, input: unknown) {
  const value = stringParameters(input, ['response_type','client_id','redirect_uri','resource','scope','state','code_challenge','code_challenge_method']);
  const client = config.clients.find(client => client.client_id === value.client_id);
  if (!client || value.response_type !== 'code' || !client.redirect_uris.includes(value.redirect_uri!) || value.resource !== config.resource ||
      !value.state || value.state.length > 2048 || value.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(value.code_challenge ?? '') ||
      Buffer.from(value.code_challenge!, 'base64url').toString('base64url') !== value.code_challenge) throw new Error('invalid_request');
  let scopes: string[];
  try { scopes = parseScopes(value.scope); } catch { throw new Error('invalid_request'); }
  if (scopes.some(scope => !client.scopes.includes(scope))) throw new Error('invalid_request');
  return { client_id: client.client_id, redirect_uri: value.redirect_uri!, resource: config.resource, scopes,
    code_challenge: value.code_challenge!, code_challenge_method: 'S256' as const, state: value.state,
    issuer: config.issuer, client_config_version: config.clientConfigVersion };
}
