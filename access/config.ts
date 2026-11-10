import { validateHttps, opaqueId, parseScopes } from '../security/service-token.js';
export interface RegisteredClient { client_id: string; redirect_uris: string[]; scopes: string[] }
export interface CognitoConfiguration { issuer: string; domain: string; clientId: string; callbackUri: string; scopes: string[] }
export interface AccessConfiguration {
  environment: string; issuer: string; resource: string; clientConfigVersion: string; cookieName: string;
  clients: RegisteredClient[]; cognito: CognitoConfiguration;
}
function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_access_configuration');
}
export function endpoint(config: { issuer: string }, path: string) { return config.issuer.replace(/\/$/, '') + path; }
export function validateCognitoConfiguration(input: CognitoConfiguration) {
  fields(input, ['issuer','domain','clientId','callbackUri','scopes']);
  validateHttps(input.issuer); validateHttps(input.domain); validateHttps(input.callbackUri);
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(input.issuer) ||
      new URL(input.domain).pathname !== '/' || !/^[A-Za-z0-9_]{1,128}$/.test(input.clientId) || !Array.isArray(input.scopes) ||
      !input.scopes.includes('openid') || parseScopes(input.scopes.join(' ')).length !== input.scopes.length) throw new Error('invalid_access_configuration');
  return structuredClone(input);
}
export function validateAccessConfiguration(input: AccessConfiguration) {
  fields(input, ['environment','issuer','resource','clientConfigVersion','cookieName','clients','cognito']);
  validateHttps(input.issuer); validateHttps(input.resource);
  if (!opaqueId.test(input.environment) || !opaqueId.test(input.clientConfigVersion) || !/^__Host-[A-Za-z0-9_-]{1,80}$/.test(input.cookieName) ||
      !new URL(input.resource).pathname.endsWith('/mcp') || !Array.isArray(input.clients) || input.clients.length < 1 || input.clients.length > 100) throw new Error('invalid_access_configuration');
  const seen = new Set<string>();
  for (const client of input.clients) {
    fields(client, ['client_id','redirect_uris','scopes']);
    if (typeof client.client_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(client.client_id) || seen.has(client.client_id) ||
        !Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10 ||
        new Set(client.redirect_uris).size !== client.redirect_uris.length || !Array.isArray(client.scopes) ||
        parseScopes(client.scopes.join(' ')).length !== client.scopes.length) throw new Error('invalid_access_configuration');
    for (const uri of client.redirect_uris) {
      if (typeof uri !== 'string' || uri.length > 2048 || uri.includes('*')) throw new Error('invalid_access_configuration');
      const parsed = new URL(uri);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('invalid_access_configuration');
    }
    seen.add(client.client_id);
  }
  validateCognitoConfiguration(input.cognito);
  if (input.cognito.callbackUri !== endpoint(input, '/oauth/cognito/callback')) throw new Error('invalid_access_configuration');
  return structuredClone(input);
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
  const scopes = parseScopes(value.scope);
  if (scopes.some(scope => !client.scopes.includes(scope))) throw new Error('invalid_request');
  return { client_id: client.client_id, redirect_uri: value.redirect_uri!, resource: config.resource, scopes,
    code_challenge: value.code_challenge!, code_challenge_method: 'S256' as const, state: value.state,
    issuer: config.issuer, client_config_version: config.clientConfigVersion };
}
