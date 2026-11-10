import express from 'express';
import { endpoint, type AccessConfiguration } from '../config.js';
import { BrowserSessions } from '../sessions.js';
import type { OAuthExtension } from './types.js';
import { browserContext, logoutForm, escapeHtml } from './cookies.js';

export function managementRoutes(config: AccessConfiguration, sessions: BrowserSessions, extension?: OAuthExtension) {
  const router = express.Router();
  router.get('/billing', async (request, response) => {
    const context = await browserContext(sessions, config, request.headers.cookie, response);
    if (!context) return;
    const entitlement = await sessions.currentPaidEntitlement(context);
    if (!entitlement) {
      response.status(403).json({ error: 'subscription_required', message: 'Reconnect from your AI client to select a plan.' });
      return;
    }
    response.type('html').send(`<!doctype html><html><body><h1>Subscription</h1><p>Plan: ${escapeHtml(entitlement.plan_id)}</p><p>Paid through (UTC epoch): ${escapeHtml(entitlement.valid_until)}</p>${logoutForm(config, context)}</body></html>`);
  });
  router.get('/onboarding', async (request, response) => {
    const context = await browserContext(sessions, config, request.headers.cookie, response);
    if (!context) return;
    if (context.session.purpose !== 'onboarding') { response.redirect(303, endpoint(config, '/billing')); return; }
    if (extension) { await extension.onboarding(context, request, response); return; }
    response.status(503).set('retry-after', '5').type('html').send(`<!doctype html><html><body><h1>Connection setup</h1><p>Connection setup is temporarily unavailable. Try again later.</p>${logoutForm(config, context)}</body></html>`);
  });
  return router;
}
