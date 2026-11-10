import type { Request, RequestHandler, Response } from 'express';
import type { BrowserContext } from '../sessions.js';

export interface OAuthExtension {
  token: RequestHandler;
  revoke: RequestHandler;
  resume: RequestHandler;
  checkout: RequestHandler;
  status: RequestHandler;
  orderStatus: RequestHandler;
  billingReturn: RequestHandler;
  plans: RequestHandler;
  managementPage: RequestHandler;
  manageSubscription: RequestHandler;
  managementStatus: RequestHandler;
  billingPortal: RequestHandler;
  onboarding: (context: BrowserContext, request: Request, response: Response) => Promise<void>;
}
