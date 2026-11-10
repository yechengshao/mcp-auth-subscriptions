import express, { type RequestHandler } from 'express';
import { endpoint, type AccessConfiguration } from '../config.js';
import type { OAuthExtension } from './types.js';

export function discoveryRoutes(config: AccessConfiguration, publicJwks: unknown, extension?: OAuthExtension) {
  const router = express.Router();
  router.get('/jwks.json', (_request, response) => { response.json(publicJwks); });
  const unavailable: RequestHandler = (_request, response) => {
    response.status(503).set('retry-after', '5').json({ error: 'authorization_not_ready' });
  };
  const metadata = {
    issuer: config.issuer,
    authorization_endpoint: endpoint(config, '/authorize'),
    token_endpoint: endpoint(config, '/token'),
    revocation_endpoint: endpoint(config, '/revoke'),
    jwks_uri: endpoint(config, '/jwks.json'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...new Set(config.clients.flatMap(client => client.scopes))],
  };
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    router.get(path, extension ? (_request, response) => { response.json(metadata); } : unavailable);
  }
  router.get('/.well-known/oauth-protected-resource', extension ? (_request, response) => {
    response.json({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: metadata.scopes_supported });
  } : unavailable);
  return router;
}
