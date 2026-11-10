import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccessRow } from './model.js';
import { IdentityProviderFailure, type BrowserSessionStore, type IdentityProvider } from './ports.js';
import type { Telemetry } from '../observability/telemetry.js';
import { authorizeParameters, validateAccessConfiguration, type AccessConfiguration } from './config.js';
import { validateSessionContext } from './contracts/validate.js';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
export class SessionFailure extends Error {
  constructor(readonly status: 400 | 401 | 403, readonly code: 'invalid_request' | 'session_expired' | 'forbidden' | 'login_cancelled') { super(code); }
}
export interface BrowserContext { sessionDigest: string; session: AccessRow; transaction: AccessRow; csrf: string }
export class BrowserSessions {
  readonly config: AccessConfiguration;
  constructor(config: AccessConfiguration, readonly store: BrowserSessionStore, private readonly cognito: IdentityProvider,
    readonly telemetry: Telemetry,
    private readonly now = () => Math.floor(Date.now() / 1000)) {
    this.config = validateAccessConfiguration(config);
    if (store.environment !== config.environment) throw new Error('invalid_access_configuration');
  }
  remaining(expires: number) { return Math.max(Math.min(expires - this.now(), 1800), 0); }
  eligible(entitlement: AccessRow | undefined) { return entitlement?.allowed === true && entitlement.valid_until > this.now(); }
  async currentPaidEntitlement(context: BrowserContext): Promise<AccessRow | undefined> {
    const identity = context.session.identity;
    if (context.session.authentication_stage !== 'identity_verified' || !identity) throw new SessionFailure(401, 'session_expired');
    const entitlement = await this.store.entitlement(identity);
    return this.eligible(entitlement) ? entitlement : undefined;
  }
  private cookieValues(header: unknown) {
    if (typeof header !== 'string' || header.length > 8192) throw new SessionFailure(401, 'session_expired');
    const names = [this.config.cookieName, this.config.cookieName + '-csrf']; const values: Record<string, string> = {};
    for (const part of header.split(';')) {
      const at = part.indexOf('='); if (at < 0) continue;
      const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
      if (!names.includes(name)) continue;
      if (values[name] !== undefined || !opaque(value)) throw new SessionFailure(401, 'session_expired');
      values[name] = value;
    }
    if (names.some(name => !values[name])) throw new SessionFailure(401, 'session_expired');
    return { token: values[this.config.cookieName]!, csrf: values[this.config.cookieName + '-csrf']! };
  }
  private currentTransaction(tx: AccessRow) {
    if (tx.purpose === 'management') {
      if (tx.local_destination !== '/billing' || tx.downstream !== undefined) throw new SessionFailure(400, 'invalid_request');
      return;
    }
    const down = tx.downstream;
    if (!down || down.client_config_version !== this.config.clientConfigVersion || down.issuer !== this.config.issuer) throw new SessionFailure(400, 'invalid_request');
    const current = authorizeParameters(this.config, { response_type: 'code', client_id: down.client_id, redirect_uri: down.redirect_uri,
      resource: down.resource, scope: down.scopes.join(' '), state: down.state, code_challenge: down.code_challenge, code_challenge_method: down.code_challenge_method });
    // DynamoDB object ordering is not authority; compare validated fields explicitly.
    for (const field of ['client_id','redirect_uri','resource','state','code_challenge','code_challenge_method','issuer','client_config_version'] as const)
      if (current[field] !== down[field]) throw new SessionFailure(400, 'invalid_request');
    if (current.scopes.length !== down.scopes.length || current.scopes.some((scope: string, index: number) => scope !== down.scopes[index])) {
      throw new SessionFailure(400, 'invalid_request');
    }
  }
  async context(cookie: unknown, verified = true): Promise<BrowserContext> {
    const raw = this.cookieValues(cookie);
    const sessionDigest = digest(raw.token);
    const loaded = await this.store.loadContext(sessionDigest);
    if (!loaded) throw new SessionFailure(401, 'session_expired');
    const { session, transaction: tx } = loaded;
    try { validateSessionContext(session, tx, this.config.environment, this.now()); }
    catch { throw new SessionFailure(401, 'session_expired'); }
    if (session.authentication_stage === 'identity_verified' && session.identity?.issuer !== this.config.cognito.issuer) {
      throw new SessionFailure(401, 'session_expired');
    }
    if (digest(raw.csrf) !== session.csrf_digest) throw new SessionFailure(401, 'session_expired');
    this.currentTransaction(tx);
    if (verified && session.authentication_stage !== 'identity_verified') throw new SessionFailure(401, 'session_expired');
    return { sessionDigest, session, transaction: tx, csrf: raw.csrf };
  }
  csrf(context: BrowserContext, origin: unknown, token: unknown) {
    if (origin !== new URL(this.config.issuer).origin || !opaque(token) ||
        !timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(context.session.csrf_digest, 'hex'))) throw new SessionFailure(403, 'forbidden');
  }
  async start(purpose: 'onboarding' | 'management', parameters: unknown = {}) {
    const downstream = purpose === 'onboarding' ? authorizeParameters(this.config, parameters) : undefined;
    if (purpose === 'management' && (!parameters || typeof parameters !== 'object' || Object.keys(parameters).length)) throw new SessionFailure(400, 'invalid_request');
    const now = this.now(), txId = randomUUID(), grantId = purpose === 'onboarding' ? randomUUID() : undefined;
    const token = random(), csrf = random(), state = random(), nonce = random(), verifier = random();
    const expires = now + 1800, cleanup = expires + 86400;
    await this.store.createLogin({
      purpose,
      ...(grantId ? { grantId } : {}),
      sessionDigest: digest(token),
      csrfDigest: digest(csrf),
      transactionId: txId,
      correlationId: this.telemetry.currentCorrelationId() ?? randomUUID(),
      stateDigest: digest(state),
      nonceDigest: digest(nonce),
      pkceVerifier: verifier,
      createdAt: now,
      expiresAt: expires,
      deleteAfter: cleanup,
      ...(downstream ? { downstream } : {}),
      cognitoClientId: this.config.cognito.clientId,
      cognitoIssuer: this.config.cognito.issuer,
      callbackUri: this.config.cognito.callbackUri,
    });
    return { token, csrf, expires_at: expires, location: this.cognito.authorize(state, nonce, createHash('sha256').update(verifier).digest('base64url')) };
  }
  async callback(cookie: unknown, parameters: Record<string, string>) {
    if (!opaque(parameters.state) || (parameters.code ? 1 : 0) + (parameters.error ? 1 : 0) !== 1 ||
        (parameters.iss !== undefined && parameters.iss !== this.config.cognito.issuer)) throw new SessionFailure(400, 'invalid_request');
    const context = await this.context(cookie, false);
    if (context.session.authentication_stage !== 'pending_identity' || context.transaction.phase !== 'pending_identity') throw new SessionFailure(400, 'invalid_request');
    const attempt = await this.store.loadUpstreamAttempt(digest(parameters.state));
    if (!attempt || attempt.consumed || attempt.expires_at <= this.now() || attempt.tx_id !== context.session.tx_id ||
        attempt.session_digest !== context.sessionDigest || attempt.cognito_client_id !== this.config.cognito.clientId ||
        attempt.cognito_issuer !== this.config.cognito.issuer || attempt.callback_uri !== this.config.cognito.callbackUri) throw new SessionFailure(400, 'invalid_request');
    return this.telemetry.observe('http.callback', { correlationId: context.transaction.correlation_id }, async () => {
      if (parameters.error) {
        await this.store.cancelLogin({ attempt, session: context.session, transaction: context.transaction });
        throw new SessionFailure(400, 'login_cancelled');
      }
      const identity = await this.cognito.exchange(parameters.code!, attempt.pkce_verifier, attempt.nonce_digest);
      if (identity.issuer !== this.config.cognito.issuer || typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 2048) throw new SessionFailure(400, 'invalid_request');
      const subscriberId = await this.store.ensureSubscriber(identity);
      if (context.transaction.expires_at <= this.now()) throw new SessionFailure(401, 'session_expired');
      const token = random(), csrf = random();
      await this.store.completeLogin({
        attempt,
        session: context.session,
        transaction: context.transaction,
        verified: { newSessionDigest: digest(token), csrfDigest: digest(csrf), identity, subscriberId,
          ...(context.transaction.grant_id ? { grantId: context.transaction.grant_id } : {}) },
      });
      this.telemetry.log('summary', 'http.callback', 'identity_verified');
      return { token, csrf, expires_at: context.session.expires_at, destination: context.session.purpose === 'onboarding' ? '/onboarding' : '/billing' };
    }, { expectedError: error => error instanceof SessionFailure || (error instanceof IdentityProviderFailure && error.status === 400) });
  }
  async logout(context: BrowserContext) {
    let family: AccessRow | undefined;
    if (context.session.grant_id) {
      family = await this.store.grantFamily(context.session.grant_id);
      if (family) {
        if (family.subscriber_id !== context.session.subscriber_id || family.identity.issuer !== context.session.identity?.issuer || family.identity.subject !== context.session.identity?.subject ||
            (context.transaction.grant_id && context.transaction.grant_id !== family.grant_id) ||
            (context.transaction.downstream && (family.client_id !== context.transaction.downstream.client_id || family.resource !== context.transaction.downstream.resource))) throw new SessionFailure(403, 'forbidden');
      }
    }
    await this.store.logout(context.session, family, this.now());
    this.telemetry.log('summary', 'http.login', 'browser_session_revoked');
  }
}
