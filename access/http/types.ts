import type { Request, RequestHandler, Response } from 'express';
import type { BrowserContext } from '../sessions.js';

export interface OAuthExtension {
  token: RequestHandler;
  revoke: RequestHandler;
  resume: RequestHandler;
  onboarding: (context: BrowserContext, request: Request, response: Response) => Promise<void>;
}
