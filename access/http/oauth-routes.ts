import express from 'express';
import type { OAuthExtension } from './types.js';

export function oauthRoutes(extension?: OAuthExtension) {
  const router = express.Router();
  if (!extension) return router;
  const form = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 });
  router.post('/token', form, extension.token);
  router.post('/revoke', form, extension.revoke);
  router.post('/billing/checkout', form, extension.checkout);
  router.post('/onboarding/status', form, extension.status);
  router.post('/onboarding/resume', form, extension.resume);
  return router;
}
