import express from 'express';
import { isDeepStrictEqual } from 'node:util';
import { validateAccessConfiguration, type AccessConfiguration } from './config.js';
import { BrowserSessions } from './sessions.js';
import { publicKeySet } from '../security/jwks.js';
import { accessErrors } from './http/errors.js';
import { discoveryRoutes } from './http/discovery-routes.js';
import { identityRoutes } from './http/identity-routes.js';
import { managementRoutes } from './http/management-routes.js';
import { oauthRoutes } from './http/oauth-routes.js';
import type { OAuthExtension } from './http/types.js';
export type { OAuthExtension } from './http/types.js';

/** Compose the HTTP boundary from focused protocol, browser and management routers. */
export async function createAccessApp(input: AccessConfiguration, sessions: BrowserSessions, publicJwks: unknown, extension?: OAuthExtension) {
  const config = validateAccessConfiguration(input), published = structuredClone(publicJwks);
  if (!isDeepStrictEqual(config, sessions.config)) throw new Error('access_configuration_mismatch');
  await publicKeySet(published);
  if (extension && ['token','revoke','resume','checkout','status','orderStatus','billingReturn','plans','onboarding',
    'managementPage','manageSubscription','managementStatus','billingPortal'].some(key => typeof extension[key as keyof OAuthExtension] !== 'function')) {
    throw new Error('invalid_access_extensions');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    });
    next();
  });

  app.use(discoveryRoutes(config, published, extension));
  app.use(identityRoutes(config, sessions));
  app.use(managementRoutes(config, sessions, extension));
  app.use(oauthRoutes(extension));
  app.use((_request, response) => { response.status(404).json({ error: 'not_found' }); });
  app.use(accessErrors(config, sessions.telemetry));
  return app;
}
