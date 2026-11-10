import type { AccessRow } from './model.js';

export class IdentityProviderFailure extends Error {
  constructor(readonly status: 400 | 503) {
    super(status === 400 ? 'identity_verification_failed' : 'identity_provider_unavailable');
  }
}

export interface PendingLogin {
  purpose: 'onboarding' | 'management';
  sessionDigest: string;
  csrfDigest: string;
  transactionId: string;
  correlationId: string;
  stateDigest: string;
  nonceDigest: string;
  pkceVerifier: string;
  createdAt: number;
  expiresAt: number;
  deleteAfter: number;
  downstream?: AccessRow;
  cognitoClientId: string;
  cognitoIssuer: string;
  callbackUri: string;
}

export interface VerifiedLogin {
  newSessionDigest: string;
  csrfDigest: string;
  identity: { issuer: string; subject: string };
  subscriberId: string;
}

/** Browser-session persistence port. Adapters own physical keys and atomic writes. */
export interface BrowserSessionStore {
  readonly environment: string;
  createLogin(input: PendingLogin): Promise<void>;
  loadContext(sessionDigest: string): Promise<{ session: AccessRow; transaction: AccessRow } | undefined>;
  loadUpstreamAttempt(stateDigest: string): Promise<AccessRow | undefined>;
  cancelLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow }): Promise<void>;
  completeLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow; verified: VerifiedLogin }): Promise<void>;
  ensureSubscriber(identity: { issuer: string; subject: string }): Promise<string>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  grantFamily(grantId: string): Promise<AccessRow | undefined>;
  logout(session: AccessRow, family: AccessRow | undefined, revokedAt: number): Promise<void>;
}

export interface IdentityProvider {
  authorize(state: string, nonce: string, challenge: string): string;
  exchange(code: string, verifier: string, nonceDigest: string): Promise<{ issuer: string; subject: string }>;
}
