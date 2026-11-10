import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { validateAccessConfiguration, endpoint, stringParameters, type AccessConfiguration } from './config.js';
import { BrowserSessions, SessionFailure, type BrowserContext } from './sessions.js';
import { CognitoFailure } from './identity.js';
import { publicKeySet } from '../security/jwks.js';
export interface OAuthExtension {
  token: RequestHandler; revoke: RequestHandler; resume: RequestHandler;
  onboarding: (context: BrowserContext, request: express.Request, response: express.Response) => Promise<void>;
}
/** Registration is server-owned. Missing issuance/provisioning extensions keep discovery fail-closed. */
export async function createAccessApp(input: AccessConfiguration, sessions: BrowserSessions, publicJwks: unknown, extension?: OAuthExtension) {
  const config = validateAccessConfiguration(input), published = structuredClone(publicJwks);
  await publicKeySet(published);
  if (extension && ['token','revoke','resume','onboarding'].some(key => typeof extension[key as keyof OAuthExtension] !== 'function')) throw new Error('invalid_access_extensions');
  const app = express(); app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({ 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" }); next();
  });
  function cookies(response: express.Response, value: { token: string; csrf: string; expires_at: number }) {
    const maxAge = sessions.remaining(value.expires_at) * 1000;
    for (const [name, raw] of [[config.cookieName, value.token], [config.cookieName + '-csrf', value.csrf]])
      response.cookie(name!, raw, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge });
  }
  function clear(response: express.Response) {
    for (const name of [config.cookieName, config.cookieName + '-csrf']) response.clearCookie(name, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
  }
  app.get('/jwks.json', (_request, response) => { response.json(published); });
  const unavailable: RequestHandler = (_request, response) => { response.status(503).set('retry-after', '5').json({ error: 'authorization_not_ready' }); };
  const metadata = { issuer: config.issuer, authorization_endpoint: endpoint(config, '/authorize'), token_endpoint: endpoint(config, '/token'),
    revocation_endpoint: endpoint(config, '/revoke'), jwks_uri: endpoint(config, '/jwks.json'), response_types_supported: ['code'],
    grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...new Set(config.clients.flatMap(client => client.scopes))] };
  for (const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'])
    app.get(path, extension ? (_request, response) => { response.json(metadata); } : unavailable);
  app.get('/.well-known/oauth-protected-resource', extension ? (_request, response) => {
    response.json({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: metadata.scopes_supported });
  } : unavailable);
  app.get('/authorize', async (request, response) => {
    const started = await sessions.start('onboarding', request.query);
    cookies(response, started); response.redirect(302, started.location);
  });
  app.get('/login', async (request, response) => {
    const started = await sessions.start('management', request.query);
    cookies(response, started); response.redirect(302, started.location);
  });
  app.get('/oauth/cognito/callback', async (request, response) => {
    const parameters = stringParameters(request.query, ['state','code','error','error_description','iss']);
    try {
      const result = await sessions.callback(request.headers.cookie, parameters);
      cookies(response, result); response.redirect(303, endpoint(config, result.destination));
    } catch (error) { if (error instanceof SessionFailure && error.code === 'login_cancelled') clear(response); throw error; }
  });
  async function pageContext(cookie: unknown, response: express.Response): Promise<BrowserContext | undefined> {
    try { return await sessions.context(cookie); }
    catch (error) {
      if (!(error instanceof SessionFailure && error.status === 401)) throw error;
      clear(response); response.redirect(302, endpoint(config, '/login')); return undefined;
    }
  }
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  function logoutForm(context: BrowserContext) {
    return `<form method="post" action="${escape(endpoint(config, '/logout'))}"><input type="hidden" name="csrf_token" value="${escape(context.csrf)}"><button>Sign out</button></form>`;
  }
  app.get('/billing', async (request, response) => {
    const context = await pageContext(request.headers.cookie, response); if (!context) return;
    const entitlement = await sessions.store.entitlement(context.session.identity);
    if (!sessions.eligible(entitlement)) {
      response.status(403).json({ error: 'subscription_required', message: 'Reconnect from your AI client to select a plan.' }); return;
    }
    response.type('html').send(`<!doctype html><html><body><h1>Subscription</h1><p>Plan: ${escape(entitlement!.plan_id)}</p><p>Paid through (UTC epoch): ${escape(entitlement!.valid_until)}</p>${logoutForm(context)}</body></html>`);
  });
  app.get('/onboarding', async (request, response) => {
    const context = await pageContext(request.headers.cookie, response); if (!context) return;
    if (context.session.purpose !== 'onboarding') { response.redirect(303, endpoint(config, '/billing')); return; }
    if (extension) { await extension.onboarding(context, request, response); return; }
    // No payment/code issuance is offered until the bounded provisioning and token modules are composed.
    response.status(503).set('retry-after', '5').type('html').send(`<!doctype html><html><body><h1>Connection setup</h1><p>Connection setup is temporarily unavailable. Try again later.</p>${logoutForm(context)}</body></html>`);
  });
  const form = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 });
  app.post('/logout', form, async (request, response) => {
    const parameters = stringParameters(request.body, ['csrf_token']);
    const context = await sessions.context(request.headers.cookie, false);
    sessions.csrf(context, request.get('origin'), parameters.csrf_token);
    await sessions.logout(context); clear(response); response.status(200).json({ signed_out: true });
  });
  if (extension) {
    app.post('/token', form, extension.token); app.post('/revoke', form, extension.revoke); app.post('/onboarding/resume', form, extension.resume);
  }
  app.use((_request, response) => { response.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof SessionFailure) { response.status(error.status).json({ error: error.code, ...(error.status === 401 ? { action: endpoint(config, '/login') } : {}) }); return; }
    if (error instanceof CognitoFailure) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof Error && ['invalid_request','invalid_access_token'].includes(error.message)) { response.status(400).json({ error: 'invalid_request' }); return; }
    sessions.store.telemetry.log('error', 'http.login', 'unexpected_error', { error });
    response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable' });
  };
  app.use(errors);
  return app;
}
