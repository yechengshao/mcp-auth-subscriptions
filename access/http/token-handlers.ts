import type { RequestHandler } from 'express';
import type { Telemetry } from '../../observability/telemetry.js';
import { AccessTokens, OAuthTokenFailure } from '../tokens.js';

function form(value: unknown, allowed: string[], required: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthTokenFailure(400, 'invalid_request');
  const result: Record<string, string> = {};
  for (const [name, field] of Object.entries(value)) {
    if (!allowed.includes(name) || typeof field !== 'string' || field.length > 4096 || !field.length) {
      throw new OAuthTokenFailure(400, 'invalid_request');
    }
    result[name] = field;
  }
  if (required.some(name => !Object.hasOwn(result, name))) throw new OAuthTokenFailure(400, 'invalid_request');
  return result;
}

function oauthFailure(response: Parameters<RequestHandler>[1], error: unknown, telemetry: Telemetry): void {
  if (error instanceof OAuthTokenFailure) {
    if (error.status === 503) response.set('retry-after', '5');
    response.status(error.status).json({ error: error.oauthError });
    return;
  }
  telemetry.markServerError('http.token', 503, error);
  response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable' });
}

/** Thin form-encoded OAuth adapter; all grant and persistence rules live in AccessTokens. */
export function createTokenHandlers(tokens: AccessTokens, telemetry: Telemetry): { token: RequestHandler; revoke: RequestHandler } {
  const token: RequestHandler = async (request, response) => {
    try {
      const body = form(request.body, ['grant_type','code','client_id','redirect_uri','code_verifier','resource',
        'refresh_token','scope'], ['grant_type','client_id']);
      if (body.grant_type === 'authorization_code') {
        const values = form(body, ['grant_type','code','client_id','redirect_uri','code_verifier','resource'],
          ['grant_type','code','client_id','redirect_uri','code_verifier','resource']);
        const result = await tokens.exchangeCode({ code: values.code!, clientId: values.client_id!,
          redirectUri: values.redirect_uri!, codeVerifier: values.code_verifier!, resource: values.resource! });
        response.status(200).json(result);
        return;
      }
      if (body.grant_type === 'refresh_token') {
        const values = form(body, ['grant_type','client_id','refresh_token','resource','scope'],
          ['grant_type','client_id','refresh_token']);
        const result = await tokens.refresh({ refreshToken: values.refresh_token!, clientId: values.client_id!,
          ...(values.resource ? { resource: values.resource } : {}), ...(values.scope ? { scope: values.scope } : {}) });
        response.status(200).json(result);
        return;
      }
      throw new OAuthTokenFailure(400, 'unsupported_grant_type');
    } catch (error) { oauthFailure(response, error, telemetry); }
  };
  const revoke: RequestHandler = async (request, response) => {
    try {
      const body = form(request.body, ['token','client_id','token_type_hint'], ['token','client_id']);
      await tokens.revoke({ token: body.token!, clientId: body.client_id!,
        ...(body.token_type_hint ? { tokenTypeHint: body.token_type_hint } : {}) });
      response.status(200).end();
    } catch (error) { oauthFailure(response, error, telemetry); }
  };
  return { token, revoke };
}
