import express from 'express';
import { endpoint, stringParameters, type AccessConfiguration } from '../config.js';
import { BrowserSessions, SessionFailure } from '../sessions.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';

export function identityRoutes(config: AccessConfiguration, sessions: BrowserSessions) {
  const router = express.Router();
  router.get('/authorize', async (request, response) => {
    const started = await sessions.start('onboarding', request.query);
    setSessionCookies(config, sessions, response, started);
    response.redirect(302, started.location);
  });
  router.get('/login', async (request, response) => {
    const started = await sessions.start('management', request.query);
    setSessionCookies(config, sessions, response, started);
    response.redirect(302, started.location);
  });
  router.get('/oauth/cognito/callback', async (request, response) => {
    const parameters = stringParameters(request.query, ['state', 'code', 'error', 'error_description', 'iss']);
    try {
      const result = await sessions.callback(request.headers.cookie, parameters);
      setSessionCookies(config, sessions, response, result);
      response.redirect(303, endpoint(config, result.destination));
    } catch (error) {
      if (error instanceof SessionFailure && error.code === 'login_cancelled') clearSessionCookies(config, response);
      throw error;
    }
  });
  const form = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 });
  router.post('/logout', form, async (request, response) => {
    const parameters = stringParameters(request.body, ['csrf_token']);
    const context = await sessions.context(request.headers.cookie, false);
    sessions.csrf(context, request.get('origin'), parameters.csrf_token);
    await sessions.logout(context);
    clearSessionCookies(config, response);
    response.status(200).json({ signed_out: true });
  });
  return router;
}
