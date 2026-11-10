import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { endpoint, stringParameters, type AccessConfiguration } from '../config.js';
import { Onboarding, OnboardingFailure } from '../onboarding.js';
import { BrowserSessions, SessionFailure, type BrowserContext } from '../sessions.js';
import type { Telemetry } from '../../observability/telemetry.js';
import type { Operation } from '../../observability/config.js';
import { browserContext, escapeHtml, logoutForm } from './cookies.js';

function safeJson(value: unknown) { return JSON.stringify(value).replace(/</g, '\\u003c'); }

function statusDocument(config: AccessConfiguration, context: BrowserContext): { html: string; csp: string } {
  const nonce = randomBytes(18).toString('base64url');
  const statusUrl = safeJson(endpoint(config, '/onboarding/status'));
  const resumeUrl = escapeHtml(endpoint(config, '/onboarding/resume'));
  const csrf = escapeHtml(context.csrf);
  const script = `(function(){const f=document.getElementById('resume');const message=document.getElementById('message');let attempts=0;let timer;async function check(){clearTimeout(timer);try{const token=f.querySelector('input[name="csrf_token"]').value;const r=await fetch(${statusUrl},{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:token})});const s=await r.json();if(s.state==='checkout_ready'&&typeof s.checkout_url==='string'){location.assign(s.checkout_url);return;}if(s.state==='activation_ready'){f.submit();return;}if(s.state==='completed'){message.textContent='This connection has already completed. Return to your AI client and reconnect if needed.';return;}if(s.state==='payment_failed'){message.textContent='Payment was not completed. Return to your AI client and reconnect to try again.';return;}if(r.status===409||r.status===403){message.textContent='This sign-in attempt expired. Return to your AI client and reconnect to restart.';return;}}catch(_){}attempts++;if(attempts>=12){message.textContent='This is taking longer than expected. Use the button to safely retry.';return;}timer=setTimeout(check,Math.min(2000*Math.pow(2,Math.min(attempts-1,4)),30000));}f.addEventListener('submit',function(event){event.preventDefault();attempts=0;check();});timer=setTimeout(check,0);})();`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Activating access</title><body><main><h1 id="message">Payment or access activation is still processing</h1><p>This page checks your access status. You will continue to your AI client when it is ready.</p><form id="resume" method="post" action="${resumeUrl}"><input type="hidden" name="csrf_token" value="${csrf}"><button type="submit">Check and continue</button></form>${logoutForm(config, context)}</main><script nonce="${nonce}">${script}</script></body></html>`;
  return { html, csp: `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
}

function sendFailure(response: Response, error: unknown, telemetry: Telemetry, operation: Operation): void {
  if (error instanceof OnboardingFailure) {
    if (error.retryable) response.set('retry-after', '5');
    response.status(error.status).json({ error: error.code, ...(error.retryable ? { retryable: true } : {}) });
    return;
  }
  if (error instanceof SessionFailure) {
    response.status(error.status).json({ error: error.code });
    return;
  }
  if (error instanceof Error && error.message === 'invalid_request') {
    response.status(400).json({ error: 'invalid_request' });
    return;
  }
  telemetry.markServerError(operation, 503, error);
  response.status(503).set('retry-after', '5').json({ error: 'temporarily_unavailable' });
}

async function verifiedContext(config: AccessConfiguration, sessions: BrowserSessions, request: Request,
  response: Response): Promise<BrowserContext | undefined> {
  const context = await browserContext(sessions, config, request.headers.cookie, response);
  if (!context) return undefined;
  if (context.session.purpose !== 'onboarding') {
    response.status(403).json({ error: 'invalid_continuation' });
    return undefined;
  }
  return context;
}

function renderPlanPage(config: AccessConfiguration, context: BrowserContext,
  plans: Array<Record<string, unknown>>, catalogVersion: string): string {
  const forms: string[] = [];
  for (const rawPlan of plans) {
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) continue;
    const plan = rawPlan as Record<string, unknown>;
    if (typeof plan.plan_id !== 'string' || typeof plan.name !== 'string' || !Array.isArray(plan.duration_options)) continue;
    const options = plan.duration_options.map(rawOption => {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return '';
      const option = rawOption as Record<string, unknown>;
      if (typeof option.duration_option_id !== 'string' || typeof option.label !== 'string' ||
          typeof option.currency !== 'string' || !Number.isSafeInteger(option.amount_minor)) return '';
      const price = `${(option.amount_minor as number / 100).toFixed(2)} ${option.currency.toUpperCase()}`;
      return `<button type="submit" name="duration_option_id" value="${escapeHtml(option.duration_option_id)}">${escapeHtml(option.label)} — ${escapeHtml(price)}</button>`;
    }).filter(Boolean).join(' ');
    if (!options) continue;
    forms.push(`<form method="post" action="${escapeHtml(endpoint(config, '/billing/checkout'))}"><input type="hidden" name="csrf_token" value="${escapeHtml(context.csrf)}"><input type="hidden" name="plan_id" value="${escapeHtml(plan.plan_id)}"><input type="hidden" name="catalog_version" value="${escapeHtml(catalogVersion)}"><h2>${escapeHtml(plan.name)}</h2>${typeof plan.description === 'string' ? `<p>${escapeHtml(plan.description)}</p>` : ''}${options}</form>`);
  }
  if (!forms.length) return `<!doctype html><html lang="en"><meta charset="utf-8"><body><h1>No plans are available</h1><p>Please try again later.</p>${logoutForm(config, context)}</body></html>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Choose a plan</title><body><main><h1>Choose your plan</h1><p>Select a plan and term. Payment is handled by Stripe.</p>${forms.join('')}${logoutForm(config, context)}</main></body></html>`;
}

/** HTTP adapters only: session/CSRF checks, bounded input parsing, and safe response rendering. */
export function createOnboardingHandlers(config: AccessConfiguration, sessions: BrowserSessions, onboarding: Onboarding,
  telemetry: Telemetry): {
    onboarding: (context: BrowserContext, request: Request, response: Response) => Promise<void>;
    plans: RequestHandler;
    status: RequestHandler; checkout: RequestHandler; resume: RequestHandler; orderStatus: RequestHandler;
    billingReturn: RequestHandler;
  } {
  const status: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedContext(config, sessions, request, response);
      if (!context) return;
      const body = stringParameters(request.body, ['csrf_token']);
      if (!Object.hasOwn(body, 'csrf_token')) throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      const value = await onboarding.status(context);
      response.status(value.state === 'activation_ready' ? 200 : 202).json(value);
    } catch (error) { sendFailure(response, error, telemetry, 'http.status'); }
  };

  const checkout: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedContext(config, sessions, request, response);
      if (!context) return;
      const body = stringParameters(request.body, ['csrf_token', 'plan_id', 'duration_option_id', 'catalog_version']);
      if (['csrf_token', 'plan_id', 'duration_option_id', 'catalog_version'].some(key => !Object.hasOwn(body, key))) throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      const result = await onboarding.checkout(context, { planId: body.plan_id!, durationOptionId: body.duration_option_id!, catalogVersion: body.catalog_version! });
      if (result.kind === 'redirect') { response.redirect(303, result.url); return; }
      const document = statusDocument(config, context);
      response.status(202).set('retry-after', '5').set('content-security-policy', document.csp).type('html').send(document.html);
    } catch (error) { sendFailure(response, error, telemetry, 'http.billing'); }
  };

  const resume: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedContext(config, sessions, request, response);
      if (!context) return;
      const body = stringParameters(request.body, ['csrf_token']);
      if (!Object.hasOwn(body, 'csrf_token')) throw new Error('invalid_request');
      sessions.csrf(context, request.get('origin'), body.csrf_token);
      const result = await onboarding.resume(context);
      response.redirect(303, result.location);
    } catch (error) { sendFailure(response, error, telemetry, 'http.resume'); }
  };

  const orderStatus: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedContext(config, sessions, request, response);
      if (!context) return;
      const rawOrderId = request.params.orderId;
      const value = await onboarding.orderStatus(context, typeof rawOrderId === 'string' ? rawOrderId : '');
      if (value.state === 'pending') response.set('retry-after', String(value.retry_after_seconds ?? 5));
      response.status(value.state === 'pending' ? 202 : 200).json(value);
    } catch (error) { sendFailure(response, error, telemetry, 'http.billing'); }
  };

  const billingReturn: RequestHandler = async (request, response) => {
    try {
      const context = await verifiedContext(config, sessions, request, response);
      if (!context) return;
      // Stripe's return URL is presentation only. Payment truth comes from Billing.
      const document = statusDocument(config, context);
      response.set('content-security-policy', document.csp).status(200).type('html').send(document.html);
    } catch (error) { sendFailure(response, error, telemetry, 'http.billing'); }
  };

  return {
    plans: async (request, response) => {
      try {
        const context = await verifiedContext(config, sessions, request, response);
        if (!context) return;
        const page = await onboarding.page(context);
        if (page.kind === 'plans') { response.status(200).json(page.offers); return; }
        if (page.kind === 'eligible') { response.status(200).json({ state: 'eligible' }); return; }
        response.status(409).json({ error: 'checkout_in_progress' });
      } catch (error) { sendFailure(response, error, telemetry, 'http.billing'); }
    },
    onboarding: async (context, _request, response) => {
      try {
        const page = await onboarding.page(context);
        if (page.kind === 'plans') {
          response.type('html').send(renderPlanPage(config, context, page.offers.plans, page.offers.catalog_version));
          return;
        }
        const document = statusDocument(config, context);
        response.set('content-security-policy', document.csp).status(200).type('html').send(document.html);
      } catch (error) { sendFailure(response, error, telemetry, 'http.status'); }
    }, status, checkout, resume, orderStatus, billingReturn,
  };
}
