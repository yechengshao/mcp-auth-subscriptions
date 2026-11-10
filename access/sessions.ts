import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessStore, type AccessRow } from './store.js';
import { authorizeParameters, validateAccessConfiguration, type AccessConfiguration } from './config.js';
import { validateSessionContext } from './contracts/validate.js';
import { CognitoFailure, type CognitoIdentity } from './identity.js';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
export class SessionFailure extends Error {
  constructor(readonly status: 400 | 401 | 403, readonly code: 'invalid_request' | 'session_expired' | 'forbidden' | 'login_cancelled') { super(code); }
}
export interface BrowserContext { session: AccessRow; transaction: AccessRow; csrf: string }
export class BrowserSessions {
  readonly config: AccessConfiguration;
  constructor(config: AccessConfiguration, readonly store: AccessStore, private readonly cognito: Pick<CognitoIdentity, 'authorize' | 'exchange'>,
    private readonly now = () => Math.floor(Date.now() / 1000)) {
    this.config = validateAccessConfiguration(config);
    if (store.environment !== config.environment) throw new Error('invalid_access_configuration');
  }
  remaining(expires: number) { return Math.max(Math.min(expires - this.now(), 1800), 0); }
  eligible(entitlement: AccessRow | undefined) { return entitlement?.allowed === true && entitlement.valid_until > this.now(); }
  private row(PK: string, SK: string, entity_type: string): AccessRow { return { PK, SK, entity_type, schema_version: 1, revision: 1, environment: this.config.environment }; }
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
    if (tx.purpose !== 'onboarding') return;
    const down = tx.downstream;
    if (!down || down.client_config_version !== this.config.clientConfigVersion || down.issuer !== this.config.issuer) throw new SessionFailure(400, 'invalid_request');
    const current = authorizeParameters(this.config, { response_type: 'code', client_id: down.client_id, redirect_uri: down.redirect_uri,
      resource: down.resource, scope: down.scopes.join(' '), state: down.state, code_challenge: down.code_challenge, code_challenge_method: down.code_challenge_method });
    if (JSON.stringify(current) !== JSON.stringify(down)) {
      // DynamoDB object ordering is not authority: compare the validated individual fields.
      for (const field of ['client_id','redirect_uri','resource','state','code_challenge','code_challenge_method','issuer','client_config_version'] as const)
        if (current[field] !== down[field]) throw new SessionFailure(400, 'invalid_request');
      if (current.scopes.join(' ') !== down.scopes.join(' ')) throw new SessionFailure(400, 'invalid_request');
    }
  }
  async context(cookie: unknown, verified = true): Promise<BrowserContext> {
    const raw = this.cookieValues(cookie);
    const session = await this.store.get({ PK: `ENV#${this.config.environment}#SESSION#${digest(raw.token)}`, SK: 'SESSION' });
    if (!session) throw new SessionFailure(401, 'session_expired');
    const tx = await this.store.get({ PK: `ENV#${this.config.environment}#TX#${session.tx_id}`, SK: 'STATE' });
    if (!tx) throw new SessionFailure(401, 'session_expired');
    try { validateSessionContext(session, tx, this.config.environment, this.now()); }
    catch { throw new SessionFailure(401, 'session_expired'); }
    if (digest(raw.csrf) !== session.csrf_digest) throw new SessionFailure(401, 'session_expired');
    this.currentTransaction(tx);
    if (verified && session.authentication_stage !== 'identity_verified') throw new SessionFailure(401, 'session_expired');
    return { session, transaction: tx, csrf: raw.csrf };
  }
  csrf(context: BrowserContext, origin: unknown, token: unknown) {
    if (origin !== new URL(this.config.issuer).origin || !opaque(token) ||
        !timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(context.session.csrf_digest, 'hex'))) throw new SessionFailure(403, 'forbidden');
  }
  async start(purpose: 'onboarding' | 'management', parameters: unknown = {}) {
    const downstream = purpose === 'onboarding' ? authorizeParameters(this.config, parameters) : undefined;
    if (purpose === 'management' && (!parameters || typeof parameters !== 'object' || Object.keys(parameters).length)) throw new SessionFailure(400, 'invalid_request');
    const now = this.now(), txId = randomUUID(), token = random(), csrf = random(), state = random(), nonce = random(), verifier = random();
    const expires = now + 1800, cleanup = expires + 86400;
    const session = { ...this.row(`ENV#${this.config.environment}#SESSION#${digest(token)}`, 'SESSION', 'session'),
      purpose, tx_id: txId, authentication_stage: 'pending_identity', csrf_digest: digest(csrf), created_at: now, expires_at: expires, delete_after: cleanup };
    const tx = { ...this.row(`ENV#${this.config.environment}#TX#${txId}`, 'STATE', 'transaction'), purpose, phase: 'pending_identity',
      correlation_id: this.store.telemetry.currentCorrelationId() ?? randomUUID(), created_at: now, expires_at: expires, delete_after: cleanup,
      ...(downstream ? { downstream } : { local_destination: '/billing' }) };
    const attempt = { ...this.row(`ENV#${this.config.environment}#UPSTREAM#${digest(state)}`, 'ATTEMPT', 'upstream_attempt'),
      tx_id: txId, session_digest: digest(token), nonce_digest: digest(nonce), pkce_verifier: verifier,
      cognito_client_id: this.config.cognito.clientId, cognito_issuer: this.config.cognito.issuer, callback_uri: this.config.cognito.callbackUri,
      created_at: now, expires_at: expires, delete_after: cleanup, consumed: false };
    await this.store.commit([{ row: session }, { row: tx }, { row: attempt }]);
    return { token, csrf, expires_at: expires, location: this.cognito.authorize(state, nonce, createHash('sha256').update(verifier).digest('base64url')) };
  }
  async callback(cookie: unknown, parameters: Record<string, string>) {
    if (!opaque(parameters.state) || (parameters.code ? 1 : 0) + (parameters.error ? 1 : 0) !== 1 ||
        (parameters.iss !== undefined && parameters.iss !== this.config.cognito.issuer)) throw new SessionFailure(400, 'invalid_request');
    const context = await this.context(cookie, false);
    if (context.session.authentication_stage !== 'pending_identity' || context.transaction.phase !== 'pending_identity') throw new SessionFailure(400, 'invalid_request');
    const attempt = await this.store.get({ PK: `ENV#${this.config.environment}#UPSTREAM#${digest(parameters.state)}`, SK: 'ATTEMPT' });
    if (!attempt || attempt.consumed || attempt.expires_at <= this.now() || attempt.tx_id !== context.session.tx_id ||
        attempt.session_digest !== context.session.PK.split('#').at(-1) || attempt.cognito_client_id !== this.config.cognito.clientId ||
        attempt.cognito_issuer !== this.config.cognito.issuer || attempt.callback_uri !== this.config.cognito.callbackUri) throw new SessionFailure(400, 'invalid_request');
    return this.store.telemetry.observe('http.callback', { correlationId: context.transaction.correlation_id }, async () => {
      const { pkce_verifier, ...withoutVerifier } = attempt;
      const consumed = { ...withoutVerifier, consumed: true, revision: attempt.revision + 1 };
      if (parameters.error) {
        await this.store.commit([{ row: consumed, expectedRevision: attempt.revision },
          { row: { ...context.session, revoked: true, revision: context.session.revision + 1 }, expectedRevision: context.session.revision },
          { row: { ...context.transaction, phase: 'failed', revision: context.transaction.revision + 1 }, expectedRevision: context.transaction.revision }]);
        throw new SessionFailure(400, 'login_cancelled');
      }
      const identity = await this.cognito.exchange(parameters.code!, pkce_verifier, attempt.nonce_digest);
      if (identity.issuer !== this.config.cognito.issuer || typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 2048) throw new SessionFailure(400, 'invalid_request');
      const profile = await this.store.ensureProfile(identity);
      if (context.transaction.expires_at <= this.now()) throw new SessionFailure(401, 'session_expired');
      const token = random(), csrf = random();
      const verified = { ...this.row(`ENV#${this.config.environment}#SESSION#${digest(token)}`, 'SESSION', 'session'),
        purpose: context.session.purpose, tx_id: context.session.tx_id, authentication_stage: 'identity_verified',
        identity, subscriber_id: profile.subscriber_id, csrf_digest: digest(csrf), created_at: context.session.created_at,
        expires_at: context.session.expires_at, delete_after: context.session.delete_after };
      await this.store.commit([{ row: consumed, expectedRevision: attempt.revision },
        { row: { ...context.session, revoked: true, revision: context.session.revision + 1 }, expectedRevision: context.session.revision },
        { row: verified }, { row: { ...context.transaction, phase: 'identity_verified', identity, subscriber_id: profile.subscriber_id,
          revision: context.transaction.revision + 1 }, expectedRevision: context.transaction.revision }]);
      this.store.telemetry.log('summary', 'http.callback', 'identity_verified');
      return { token, csrf, expires_at: verified.expires_at, destination: context.session.purpose === 'onboarding' ? '/onboarding' : '/billing' };
    }, { expectedError: error => error instanceof SessionFailure || (error instanceof CognitoFailure && error.status === 400) });
  }
  async logout(context: BrowserContext) {
    const writes: Array<{ row: AccessRow; expectedRevision: number }> = [{ row: { ...context.session, revoked: true, revision: context.session.revision + 1 }, expectedRevision: context.session.revision }];
    if (context.session.grant_id) {
      const family = await this.store.get({ PK: `ENV#${this.config.environment}#GRANT#${context.session.grant_id}`, SK: 'FAMILY' });
      if (family) {
        if (family.subscriber_id !== context.session.subscriber_id || family.identity.issuer !== context.session.identity?.issuer || family.identity.subject !== context.session.identity?.subject ||
            (context.transaction.grant_id && context.transaction.grant_id !== family.grant_id) ||
            (context.transaction.downstream && (family.client_id !== context.transaction.downstream.client_id || family.resource !== context.transaction.downstream.resource))) throw new SessionFailure(403, 'forbidden');
        if (family.status === 'active') writes.push({ row: { ...family, status: 'revoked', revoked_at: this.now(), revocation_reason: 'logout', revision: family.revision + 1 }, expectedRevision: family.revision });
      }
    }
    await this.store.commit(writes);
    this.store.telemetry.log('summary', 'http.login', 'browser_session_revoked');
  }
}
