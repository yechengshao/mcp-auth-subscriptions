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
  const resource = new URL(config.resource);
  const issuer = new URL(config.issuer);
  const resourceAlias = `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`;
  const authorizationAliases = new Set([
    `/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`,
    `/.well-known/openid-configuration${issuer.pathname === '/' ? '' : issuer.pathname}`,
  ]);
  const resourceDocument = () => ({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: metadata.scopes_supported });
  const sendMetadata = (_request: express.Request, response: express.Response) => {
    if (extension) { response.json(metadata); return; }
    response.status(503).set('retry-after', '5').json({ error: 'authorization_not_ready' });
  };
  const sendResource = (_request: express.Request, response: express.Response) => {
    if (extension) { response.json(resourceDocument()); return; }
    response.status(503).set('retry-after', '5').json({ error: 'authorization_not_ready' });
  };
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    router.get(path, sendMetadata);
  }
  router.get('/.well-known/oauth-protected-resource', sendResource);
  if (!authorizationAliases.has('/.well-known/oauth-authorization-server')) {
    for (const path of authorizationAliases) router.get(path, sendMetadata);
  }
  if (resourceAlias !== '/.well-known/oauth-protected-resource') router.get(resourceAlias, sendResource);
  return router;
}
