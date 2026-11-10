import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { endpoint, stringParameters, type AccessConfiguration } from '../config.js';
import { Management, ManagementFailure, type ManagementAction } from '../management.js';
import { BrowserSessions, SessionFailure, type BrowserContext } from '../sessions.js';
import type { Telemetry } from '../../observability/telemetry.js';
import type { Operation } from '../../observability/config.js';
import { browserContext, escapeHtml, logoutForm } from './cookies.js';
import type { createOnboardingHandlers } from './onboarding-handlers.js';

type OnboardingHandlers = ReturnType<typeof createOnboardingHandlers>;
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function managementFailure(response: Response, error: unknown, telemetry: Telemetry, operation: Operation) {
  if (error instanceof ManagementFailure) {
    if (error.retryable) response.set('retry-after', '5');
    response.status(error.status).json({ error: error.code, ...(error.retryable ? { retryable: true } : {}) });
    return;
  }
  if (error instanceof SessionFailure) { response.status(error.status).json({ error: error.code }); return; }
  if (error instanceof Error && error.message === 'invalid_request') { response.status(400).json({ error: 'invalid_request' }); return; }
  telemetry.markServerError(operation, 503, error);
  response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable', retryable: true });
}

async function verifiedManagementContext(config: AccessConfiguration, sessions: BrowserSessions, request: Request,
  response: Response): Promise<BrowserContext | undefined> {
  const context = await browserContext(sessions, config, request.headers.cookie, response);
  if (!context) return undefined;
  if (context.session.purpose !== 'management') {
    response.status(403).json({ error: 'invalid_management_session' });
    return undefined;
  }
  return context;
}

function billingReturnPage(config: AccessConfiguration, context: BrowserContext) {
  const nonce = randomBytes(18).toString('base64url');
  const statusUrl = safeJson(endpoint(config, '/billing/status'));
  const csrf = safeJson(context.csrf);
  const pageUrl = escapeHtml(endpoint(config, '/billing'));
  const script = `(function(){const message=document.getElementById('message');let attempts=0;let timer;async function check(){clearTimeout(timer);try{const r=await fetch(${statusUrl},{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:${csrf}})});const s=await r.json();if(s.state==='activation_ready'){message.textContent='Your payment and access are ready. Your existing connection key has been retained.';return;}if(s.state==='payment_failed'){message.textContent='Payment did not complete. Your previous access remains unchanged.';return;}if(r.status===409||r.status===403){message.textContent='This management session expired. Sign in again to check your subscription.';return;}}catch(_){}attempts++;if(attempts>=12){message.textContent='This is taking longer than expected. Return to subscription settings and check again.';return;}timer=setTimeout(check,Math.min(2000*Math.pow(2,Math.min(attempts-1,4)),30000));}timer=setTimeout(check,0);})();`;
  return { html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Updating subscription</title><body><main><h1 id="message">Payment or access activation is processing</h1><p>We will update your existing access after Billing confirms payment.</p><a href="${pageUrl}">Return to subscription settings</a>${logoutForm(config, context)}</main><script nonce="${nonce}">${script}</script></body></html>`,
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
}

function amount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? ((value as number) / 100).toFixed(2) : '0.00';
}
function planForms(config: AccessConfiguration, context: BrowserContext, plans: Array<Record<string, unknown>>, currentPlan: string,
  subscriptionId: string, catalogVersion: string) {
  const action = escapeHtml(endpoint(config, `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/manage`));
  const forms: string[] = [];
  for (const raw of plans) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const plan = raw as Record<string, unknown>;
    if (typeof plan.plan_id !== 'string' || plan.plan_id === currentPlan || typeof plan.name !== 'string' || !Array.isArray(plan.duration_options)) continue;
    const options = plan.duration_options.map(rawOption => {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return '';
      const option = rawOption as Record<string, unknown>;
      if (typeof option.duration_option_id !== 'string' || typeof option.label !== 'string' ||
          typeof option.currency !== 'string' || !Number.isSafeInteger(option.amount_minor)) return '';
      return `<button name="duration_option_id" value="${escapeHtml(option.duration_option_id)}" type="submit">${escapeHtml(option.label)} · ${amount(option.amount_minor)} ${escapeHtml(option.currency.toUpperCase())}</button>`;
    }).filter(Boolean).join(' ');
    if (!options) continue;
    forms.push(`<form method="post" action="${action}"><input type="hidden" name="csrf_token" value="${escapeHtml(context.csrf)}"><input type="hidden" name="action" value="quote_upgrade"><input type="hidden" name="plan_id" value="${escapeHtml(plan.plan_id)}"><input type="hidden" name="catalog_version" value="${escapeHtml(catalogVersion)}"><h2>${escapeHtml(plan.name)}</h2>${typeof plan.description === 'string' ? `<p>${escapeHtml(plan.description)}</p>` : ''}${options}</form>`);
  }
  return forms.join('') || '<p>No other purchasable plans are currently available.</p>';
}

export function createManagementHandlers(config: AccessConfiguration, sessions: BrowserSessions, management: Management,
  onboarding: OnboardingHandlers, telemetry: Telemetry) {
  const managementPage: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedManagementContext(config, sessions, request, response);
      if (!context) return;
      const details = await management.details(context), offers = await management.plans(context);
      const forms = planForms(config, context, offers.plans, details.plan_id, details.subscription_id, offers.catalog_version);
      response.status(200).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Subscription</title><body><main><h1>Subscription</h1><p>Plan: ${escapeHtml(details.plan_id)}</p><p>Paid through (UTC epoch): ${escapeHtml(details.valid_until)}</p><h2>Upgrade</h2><p>Unused value from the current term is applied as credit. A successful upgrade starts a new selected term. Downgrades, cancellation and refunds are handled by support.</p>${forms}<form method="post" action="${escapeHtml(endpoint(config, '/billing/portal'))}"><input type="hidden" name="csrf_token" value="${escapeHtml(context.csrf)}"><button type="submit">Contact support about billing</button></form>${logoutForm(config, context)}</main></body></html>`);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  const manageSubscription: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedManagementContext(config, sessions, request, response);
      if (!context) return;
      const raw = request.params.subscriptionRef;
      const subscriptionId = typeof raw === 'string' ? raw : '';
      const body = stringParameters(request.body, ['csrf_token', 'action', 'plan_id', 'duration_option_id', 'catalog_version', 'quote_id']);
      if (!Object.hasOwn(body, 'csrf_token') || typeof body.action !== 'string') throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      let action: ManagementAction;
      if (body.action === 'quote_upgrade') {
        if (!body.plan_id || !body.duration_option_id || !body.catalog_version) throw new Error('invalid_request');
        action = { action: 'quote_upgrade' as const, plan_id: body.plan_id,
          duration_option_id: body.duration_option_id, catalog_version: body.catalog_version };
      } else if (body.action === 'confirm_upgrade') {
        if (!body.quote_id) throw new Error('invalid_request');
        action = { action: 'confirm_upgrade' as const, quote_id: body.quote_id };
      } else if (['downgrade', 'cancel', 'refund'].includes(body.action)) action = { action: body.action as 'downgrade' | 'cancel' | 'refund' };
      else throw new Error('invalid_request');
      const result = await management.manage(context, subscriptionId, action);
      if (result.kind === 'redirect') { response.redirect(303, result.url); return; }
      if (result.kind === 'pending') {
        const page = billingReturnPage(config, context);
        response.status(202).set('retry-after', String(result.retry_after_seconds)).set('content-security-policy', page.csp).type('html').send(page.html);
        return;
      }
      if (result.kind === 'support') {
        response.status(409).type('html').send(`<!doctype html><html><body><h1>Contact support</h1><p>This request needs assistance.</p><a href="mailto:${escapeHtml(result.email)}">${escapeHtml(result.email)}</a>${logoutForm(config, context)}</body></html>`);
        return;
      }
      const quote = result.quote;
      const quoteId = typeof quote.quote_id === 'string' ? quote.quote_id : '';
      const currency = typeof quote.currency === 'string' ? quote.currency.toUpperCase() : '';
      const pay = endpoint(config, `/billing/subscriptions/${encodeURIComponent(subscriptionId)}/manage`);
      response.status(200).type('html').send(`<!doctype html><html><body><h1>Review upgrade</h1><p>New plan: ${escapeHtml(quote.plan_id)}</p><p>Full price: ${escapeHtml(amount(quote.full_amount_minor))} ${escapeHtml(currency)}</p><p>Unused-term credit: ${escapeHtml(amount(quote.credit_minor))} ${escapeHtml(currency)}</p><p>Due today: ${escapeHtml(amount(quote.payable_minor))} ${escapeHtml(currency)}</p><form method="post" action="${escapeHtml(pay)}"><input type="hidden" name="csrf_token" value="${escapeHtml(context.csrf)}"><input type="hidden" name="action" value="confirm_upgrade"><input type="hidden" name="quote_id" value="${escapeHtml(quoteId)}"><button type="submit">Continue to Stripe</button></form>${logoutForm(config, context)}</body></html>`);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  const managementStatus: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedManagementContext(config, sessions, request, response);
      if (!context) return;
      const body = stringParameters(request.body, ['csrf_token']);
      if (!Object.hasOwn(body, 'csrf_token')) throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      const value = await management.status(context);
      if (value.state !== 'activation_ready') response.set('retry-after', String(value.retry_after_seconds ?? 5));
      response.status(value.state === 'activation_ready' ? 200 : 202).json(value);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  const billingPortal: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedManagementContext(config, sessions, request, response);
      if (!context) return;
      const body = stringParameters(request.body, ['csrf_token']);
      if (!Object.hasOwn(body, 'csrf_token')) throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      const result = await management.portal(context);
      if (result.kind !== 'support') throw new ManagementFailure(503, 'portal_disabled');
      response.status(200).type('html').send(`<!doctype html><html><body><h1>Contact support</h1><p>For cancellation, downgrade, refund or billing questions, contact our support team.</p><a href="mailto:${escapeHtml(result.email)}">${escapeHtml(result.email)}</a>${logoutForm(config, context)}</body></html>`);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  const orderStatus: RequestHandler = async (request, response, next) => {
    const context = await browserContext(sessions, config, request.headers.cookie, response);
    if (!context) return;
    if (context.session.purpose === 'onboarding') return onboarding.orderStatus(request, response, next);
    try {
      const raw = request.params.orderId;
      const value = await management.orderStatus(context, typeof raw === 'string' ? raw : '');
      if (value.state === 'pending') response.set('retry-after', String(value.retry_after_seconds ?? 5));
      response.status(value.state === 'pending' ? 202 : 200).json(value);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  const billingReturn: RequestHandler = async (request, response, next) => {
    const context = await browserContext(sessions, config, request.headers.cookie, response);
    if (!context) return;
    if (context.session.purpose === 'onboarding') return onboarding.billingReturn(request, response, next);
    try {
      const page = billingReturnPage(config, context);
      response.status(200).set('content-security-policy', page.csp).type('html').send(page.html);
    } catch (error) { managementFailure(response, error, telemetry, 'http.billing'); }
  };

  return { managementPage, manageSubscription, managementStatus, billingPortal, orderStatus, billingReturn };
}
