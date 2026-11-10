import type { Response } from 'express';
import { endpoint, type AccessConfiguration } from '../config.js';
import { SessionFailure, type BrowserContext, type BrowserSessions } from '../sessions.js';

export function setSessionCookies(config: AccessConfiguration, sessions: BrowserSessions, response: Response,
  value: { token: string; csrf: string; expires_at: number }) {
  const maxAge = sessions.remaining(value.expires_at) * 1000;
  response.cookie(config.cookieName, value.token, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge });
  response.cookie(config.cookieName + '-csrf', value.csrf, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge });
}

export function clearSessionCookies(config: AccessConfiguration, response: Response) {
  for (const name of [config.cookieName, config.cookieName + '-csrf']) {
    response.clearCookie(name, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
  }
}

export async function browserContext(sessions: BrowserSessions, config: AccessConfiguration, cookie: unknown,
  response: Response): Promise<BrowserContext | undefined> {
  try { return await sessions.context(cookie); }
  catch (error) {
    if (!(error instanceof SessionFailure && error.status === 401)) throw error;
    clearSessionCookies(config, response);
    response.redirect(302, endpoint(config, '/login'));
    return undefined;
  }
}

export function escapeHtml(value: unknown) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, char => entities[char]!);
}

export function logoutForm(config: AccessConfiguration, context: BrowserContext) {
  const action = escapeHtml(endpoint(config, '/logout'));
  return `<form method="post" action="${action}"><input type="hidden" name="csrf_token" value="${escapeHtml(context.csrf)}"><button>Sign out</button></form>`;
}
