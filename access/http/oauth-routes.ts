import express from 'express';
import type { OAuthExtension } from './types.js';

export function oauthRoutes(extension?: OAuthExtension) {
  const router = express.Router();
  if (!extension) return router;
  const form = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 });
  router.post('/token', form, extension.token);
  router.post('/revoke', form, extension.revoke);
  router.post('/onboarding/resume', form, extension.resume);
  return router;
}
