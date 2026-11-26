import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { accessScopes, redirectUriAllowed, type AccessConfiguration } from '../config.js';
import type { Telemetry } from '../../observability/telemetry.js';

/** Fixed public-client registration (2026-11-26 amendment). Every caller receives the same Cognito app client ID; nothing is stored. */
const maxRedirectUris = 8;
const grantTypes: readonly string[] = ['authorization_code', 'refresh_token'];
const responseTypes: readonly string[] = ['code'];

class RegistrationFailure extends Error {
  constructor(readonly status: number, readonly oauthError: string) { super(oauthError); }
}

function reject(oauthError: string, status = 400): never { throw new RegistrationFailure(status, oauthError); }

function stringList(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && allowed.includes(item));
}

/** Validates the registration body before any response. Returns the redirect URIs to echo back. */
export function validateRegistration(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid_client_metadata');
  const metadata = body as Record<string, unknown>;
  if (Object.hasOwn(metadata, 'client_secret')) reject('invalid_client_metadata');
  if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'none') reject('invalid_client_metadata');
  if (metadata.grant_types !== undefined && !stringList(metadata.grant_types, grantTypes)) reject('invalid_client_metadata');
  if (metadata.response_types !== undefined && !stringList(metadata.response_types, responseTypes)) reject('invalid_client_metadata');
  if (metadata.scope !== undefined) {
    if (typeof metadata.scope !== 'string') reject('invalid_client_metadata');
    const scopes = metadata.scope.split(' ').filter(Boolean);
    if (!scopes.length || scopes.some(scope => !accessScopes.includes(scope))) reject('invalid_client_metadata');
  }
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > maxRedirectUris) reject('invalid_redirect_uri');
  if (uris.some(uri => !redirectUriAllowed(typeof uri === 'string' ? uri : undefined))) reject('invalid_redirect_uri');
  return uris as string[];
}

/** Public, unauthenticated registration route. It grants no access; tokens still need a completed sign-in. */
export function registrationRoutes(config: AccessConfiguration, telemetry: Telemetry) {
  const router = express.Router();
  const json = express.json({ limit: '8kb', type: 'application/json', strict: true });
  const register: RequestHandler = (request, response) => {
    try {
      if (!request.is('application/json')) reject('invalid_client_metadata');
      const redirectUris = validateRegistration(request.body);
      telemetry.log('transition', 'http.register', 'registration_accepted');
      response.status(201).json({ client_id: config.cognito.clientId, redirect_uris: redirectUris, token_endpoint_auth_method: 'none' });
    } catch (error) {
      if (error instanceof RegistrationFailure) {
        telemetry.log('transition', 'http.register', 'registration_rejected', { status_code: error.status });
        response.status(error.status).json({ error: error.oauthError });
        return;
      }
      telemetry.markServerError('http.register', 503, error);
      response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable' });
    }
  };
  // Parser failures (wrong type, oversize, malformed JSON) use the registration error vocabulary, not the global one.
  const parserErrors: ErrorRequestHandler = (error, _request, response, _next) => {
    const type = (error as { type?: unknown } | undefined)?.type;
    if (type === 'entity.too.large') { response.status(413).json({ error: 'invalid_client_metadata' }); return; }
    response.status(400).json({ error: 'invalid_client_metadata' });
  };
  router.post('/register', json, register, parserErrors);
  return router;
}
