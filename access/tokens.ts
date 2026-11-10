import { randomUUID } from 'node:crypto';
import { validateEntitlement } from '../contracts/entitlement.js';
import { identityPartition } from '../contracts/identity.js';
import { identifierPattern, usageIdentifierKeyPattern } from '../contracts/patterns.js';
import type { ServiceClaims, TokenTrust } from '../security/service-token.js';
import { parseScopes, validateTrust } from '../security/service-token.js';
import type { AccessRow, StateKey } from './model.js';
import { authCodeKey, credentialDigest, grantFamilyKey, matchesS256, newOpaqueCredential, refreshCredentialKey,
  subscriberBindingKey, transactionKey } from './grants.js';
import { transitionTransaction } from './transitions.js';
import type { Telemetry } from '../observability/telemetry.js';

export interface TokenStore {
  readonly environment: string;
  get(key: StateKey): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }>): Promise<void>;
}
export type ServiceTokenSigner = (claims: ServiceClaims) => Promise<string>;
export interface TokenResponse {
  access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string;
}
export type OAuthErrorCode = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type' | 'temporarily_unavailable';
export class OAuthTokenFailure extends Error {
  constructor(readonly status: 400 | 401 | 503, readonly oauthError: OAuthErrorCode) { super(oauthError); }
}
export interface TokenConfiguration extends TokenTrust { accessTtlSeconds: number; restApiId: string; stage: string }
const opaque = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** OAuth code redemption, refresh rotation and family revocation, independent of Express/AWS. */
export class AccessTokens {
  readonly config: TokenConfiguration;
  constructor(private readonly store: TokenStore, private readonly signer: ServiceTokenSigner, config: TokenConfiguration,
    private readonly telemetry: Telemetry, private readonly now = () => Math.floor(Date.now() / 1000)) {
    const trust = validateTrust(config);
    if (!Number.isInteger(config.accessTtlSeconds) || config.accessTtlSeconds < 60 || config.accessTtlSeconds > 3600 ||
        !identifierPattern.test(config.restApiId) || !identifierPattern.test(config.stage)) throw new Error('invalid_token_configuration');
    this.config = { ...trust, accessTtlSeconds: config.accessTtlSeconds, restApiId: config.restApiId, stage: config.stage };
  }

  async exchangeCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource: string }): Promise<TokenResponse> {
    if (!this.config.clientIds.includes(input.clientId)) throw new OAuthTokenFailure(401, 'invalid_client');
    if (typeof input.code !== 'string' || !opaque.test(input.code) || typeof input.codeVerifier !== 'string' ||
        !verifierPattern.test(input.codeVerifier) || typeof input.redirectUri !== 'string' || input.redirectUri.length > 2048 ||
        input.resource !== this.config.resource) throw new OAuthTokenFailure(400, 'invalid_request');
    const now = this.clock();
    const code = await this.read(authCodeKey(this.store.environment, input.code));
    if (!code || code.entity_type !== 'authorization_code' || code.consumed || code.expires_at <= now ||
        code.client_id !== input.clientId || code.redirect_uri !== input.redirectUri || code.resource !== input.resource ||
        code.code_challenge_method !== 'S256' || !matchesS256(input.codeVerifier, code.code_challenge)) this.invalidGrant();
    const transaction = await this.read(transactionKey(this.store.environment, code.tx_id));
    if (!transaction || transaction.purpose !== 'onboarding' || transaction.phase !== 'code_issued' ||
        transaction.expires_at <= now || transaction.subscriber_id !== code.subscriber_id ||
        transaction.grant_id !== code.grant_id || transaction.identity?.issuer === undefined ||
        transaction.identity?.subject === undefined) this.invalidGrant();
    const downstream = transaction.downstream as Record<string, unknown> | undefined;
    if (!downstream || downstream.client_id !== code.client_id || downstream.redirect_uri !== code.redirect_uri ||
        downstream.resource !== code.resource || downstream.code_challenge !== code.code_challenge ||
        downstream.code_challenge_method !== code.code_challenge_method ||
        !equal(downstream.scopes, code.scopes)) this.invalidGrant();
    const identity = transaction.identity as { issuer: string; subject: string };
    const authority = await this.authority(identity, code.subscriber_id, now, undefined);
    const scopes = this.scopes(code.scopes);
    const tokens = await this.prepareTokens({ identity, subscriberId: code.subscriber_id, clientId: code.client_id,
      resource: code.resource, grantId: code.grant_id, scopes, entitlement: authority.entitlement,
      binding: authority.binding, now });
    const family = this.familyRow({ identity, subscriberId: code.subscriber_id, clientId: code.client_id,
      resource: code.resource, grantId: code.grant_id, scopes, entitlement: authority.entitlement,
      accessExpiry: tokens.exp, now });
    const refresh = this.refreshRow(tokens.refreshToken, { grantId: code.grant_id, subscriberId: code.subscriber_id,
      clientId: code.client_id, resource: code.resource, sequence: 0, familyExpiry: authority.entitlement.valid_until,
      accessExpiry: tokens.exp, now });
    const consumedCode = { ...code, consumed: true, revision: code.revision + 1 };
    const redeemedTransaction = transitionTransaction(transaction, 'redeemed');
    await this.commit([
      { row: consumedCode, expectedRevision: code.revision },
      { row: redeemedTransaction, expectedRevision: transaction.revision },
      { row: family }, { row: refresh },
    ], this.authorityChecks(identity, authority.entitlement.revision, authority.binding));
    this.telemetry.log('transition', 'http.token', 'completed');
    return tokens.response;
  }

  async refresh(input: { refreshToken: string; clientId: string; resource?: string; scope?: string }): Promise<TokenResponse> {
    if (!this.config.clientIds.includes(input.clientId)) throw new OAuthTokenFailure(401, 'invalid_client');
    if (typeof input.refreshToken !== 'string' || !opaque.test(input.refreshToken) ||
        (input.resource !== undefined && input.resource !== this.config.resource) ||
        (input.scope !== undefined && typeof input.scope !== 'string')) throw new OAuthTokenFailure(400, 'invalid_request');
    const now = this.clock();
    const oldKey = refreshCredentialKey(this.store.environment, input.refreshToken);
    const old = await this.read(oldKey);
    if (!old || old.entity_type !== 'refresh_credential') this.invalidGrant();
    const family = await this.read(grantFamilyKey(this.store.environment, old.grant_id));
    if (!family || family.entity_type !== 'grant_family' || family.client_id !== input.clientId ||
        family.resource !== this.config.resource || old.client_id !== family.client_id || old.resource !== family.resource ||
        old.subscriber_id !== family.subscriber_id || old.grant_id !== family.grant_id) this.invalidGrant();
    if (old.status === 'consumed') {
      await this.revokeFamily(family, 'replay', now);
      this.invalidGrant();
    }
    if (old.status !== 'active' || old.expires_at <= now || old.family_expires_at !== family.refresh_expires_at ||
        family.status !== 'active' || family.refresh_expires_at <= now) this.invalidGrant();
    const scopes = this.narrowScopes(input.scope, family.scopes);
    const identity = family.identity as { issuer: string; subject: string };
    const authority = await this.authority(identity, family.subscriber_id, now, family);
    const tokens = await this.prepareTokens({ identity, subscriberId: family.subscriber_id, clientId: family.client_id,
      resource: family.resource, grantId: family.grant_id, scopes, entitlement: authority.entitlement,
      binding: authority.binding, now, paidBound: Math.min(family.refresh_expires_at, authority.entitlement.valid_until) });
    const nextFamily = { ...family, scopes, rotation_counter: family.rotation_counter + 1,
      latest_access_expires_at: tokens.exp, delete_after: Math.max(family.refresh_expires_at, tokens.exp) + 86400,
      revision: family.revision + 1 };
    const consumed = { ...old, status: 'consumed', latest_access_expires_at: tokens.exp,
      delete_after: Math.max(old.family_expires_at, tokens.exp) + 86400, revision: old.revision + 1 };
    const replacement = this.refreshRow(tokens.refreshToken, { grantId: family.grant_id, subscriberId: family.subscriber_id,
      clientId: family.client_id, resource: family.resource, sequence: old.sequence + 1,
      familyExpiry: family.refresh_expires_at, accessExpiry: tokens.exp, now });
    try {
      await this.commit([{ row: consumed, expectedRevision: old.revision }, { row: nextFamily, expectedRevision: family.revision },
        { row: replacement }], this.authorityChecks(identity, authority.entitlement.revision, authority.binding));
    } catch (error) {
      if (this.isConflict(error) || (error instanceof OAuthTokenFailure && error.oauthError === 'invalid_grant')) {
        const latest = await this.read(oldKey);
        if (latest?.status === 'consumed') {
          const latestFamily = await this.read(grantFamilyKey(this.store.environment, family.grant_id));
          if (latestFamily?.status === 'active') await this.revokeFamily(latestFamily, 'replay', now);
          this.invalidGrant();
        }
      }
      throw error;
    }
    this.telemetry.log('transition', 'http.token', 'completed');
    return tokens.response;
  }

  /** RFC 7009: unknown tokens and other clients' tokens have the same empty success. */
  async revoke(input: { token: string; clientId: string; tokenTypeHint?: string }): Promise<void> {
    if (!this.config.clientIds.includes(input.clientId)) throw new OAuthTokenFailure(401, 'invalid_client');
    if (typeof input.token !== 'string' || input.token.length > 2048 ||
        (input.tokenTypeHint !== undefined && (typeof input.tokenTypeHint !== 'string' || input.tokenTypeHint.length > 64))) {
      throw new OAuthTokenFailure(400, 'invalid_request');
    }
    if (!opaque.test(input.token)) return;
    const credential = await this.read(refreshCredentialKey(this.store.environment, input.token));
    if (!credential || credential.entity_type !== 'refresh_credential') return;
    const family = await this.read(grantFamilyKey(this.store.environment, credential.grant_id));
    if (!family || family.entity_type !== 'grant_family' || family.client_id !== input.clientId || family.status === 'revoked') return;
    await this.revokeFamily(family, 'client_revoke', this.clock());
    this.telemetry.log('transition', 'http.token', 'grant_revoked');
  }

  private async authority(identity: { issuer: string; subject: string }, subscriberId: string, now: number,
    family: AccessRow | undefined) {
    let entitlement: AccessRow | undefined;
    try { entitlement = await this.store.entitlement(identity); }
    catch { throw new OAuthTokenFailure(503, 'temporarily_unavailable'); }
    if (!entitlement) {
      if (family?.status === 'active') await this.revokeFamily(family, 'subscription_revoked', now);
      this.invalidGrant();
    }
    try { validateEntitlement(entitlement, this.store.environment, identity.issuer, identity.subject, now); }
    catch (error) {
      if (error instanceof Error && error.message === 'not_eligible') {
        if (family?.status === 'active') await this.revokeFamily(family, 'subscription_revoked', now);
        this.invalidGrant();
      }
      throw new OAuthTokenFailure(503, 'temporarily_unavailable');
    }
    const map = entitlement.usage_mapping as { rest_api_id: string; stage: string };
    if (map.rest_api_id !== this.config.restApiId || map.stage !== this.config.stage) throw new OAuthTokenFailure(503, 'temporarily_unavailable');
    const binding = await this.read(subscriberBindingKey(this.store.environment, subscriberId, map.rest_api_id, map.stage));
    if (!binding || binding.entity_type !== 'subscriber_binding' || binding.subscriber_id !== subscriberId ||
        binding.state !== 'configured' || binding.entitlement_revision !== entitlement.revision ||
        binding.plan_id !== entitlement.plan_id || !equal(binding.usage_mapping, entitlement.usage_mapping) ||
        typeof binding.api_key_id !== 'string' || typeof binding.api_key_value !== 'string' ||
        !usageIdentifierKeyPattern.test(binding.api_key_value)) throw new OAuthTokenFailure(503, 'temporarily_unavailable');
    return { entitlement, binding };
  }

  private async prepareTokens(input: { identity: { issuer: string; subject: string }; subscriberId: string; clientId: string;
    resource: string; grantId: string; scopes: string[]; entitlement: AccessRow; binding: AccessRow; now: number; paidBound?: number }) {
    const paidBound = Math.min(input.entitlement.valid_until, input.paidBound ?? input.entitlement.valid_until);
    const expires = Math.min(input.now + this.config.accessTtlSeconds, paidBound);
    if (expires <= input.now) this.invalidGrant();
    const claims: ServiceClaims = {
      iss: this.config.issuer, sub: input.subscriberId, aud: input.resource, client_id: input.clientId,
      grant_id: input.grantId, scope: input.scopes.join(' '), iat: input.now, nbf: input.now, exp: expires,
      jti: randomUUID(), token_use: 'access', plan_id: input.entitlement.plan_id,
      subscription_valid_until: paidBound, entitlement_revision: input.entitlement.revision,
      usageIdentifierKey: input.binding.api_key_value,
    };
    let accessToken: string;
    try { accessToken = await this.signer(claims); }
    catch { throw new OAuthTokenFailure(503, 'temporarily_unavailable'); }
    const refreshToken = newOpaqueCredential();
    return { exp: expires, refreshToken, response: { access_token: accessToken, token_type: 'Bearer' as const,
      expires_in: expires - input.now, refresh_token: refreshToken, scope: claims.scope } };
  }

  private familyRow(input: { identity: { issuer: string; subject: string }; subscriberId: string; clientId: string;
    resource: string; grantId: string; scopes: string[]; entitlement: AccessRow; accessExpiry: number; now: number }) {
    const expiry = input.entitlement.valid_until;
    return { PK: `ENV#${this.store.environment}#GRANT#${input.grantId}`, SK: 'FAMILY', schema_version: 1,
      entity_type: 'grant_family', revision: 1, environment: this.store.environment, grant_id: input.grantId,
      identity: input.identity, subscriber_id: input.subscriberId, client_id: input.clientId, resource: input.resource,
      scopes: input.scopes, status: 'active', refresh_expires_at: expiry, rotation_counter: 0,
      latest_access_expires_at: input.accessExpiry, created_at: input.now,
      delete_after: Math.max(expiry, input.accessExpiry) + 86400 };
  }

  private refreshRow(token: string, input: { grantId: string; subscriberId: string; clientId: string; resource: string;
    sequence: number; familyExpiry: number; accessExpiry: number; now: number }) {
    const expiry = input.familyExpiry;
    return { PK: `ENV#${this.store.environment}#REFRESH#${credentialDigest(token)}`, SK: 'TOKEN', schema_version: 1,
      entity_type: 'refresh_credential', revision: 1, environment: this.store.environment, grant_id: input.grantId,
      subscriber_id: input.subscriberId, client_id: input.clientId, resource: input.resource, sequence: input.sequence,
      status: 'active', issued_at: input.now, expires_at: expiry, family_expires_at: expiry,
      latest_access_expires_at: input.accessExpiry, delete_after: Math.max(expiry, input.accessExpiry) + 86400 };
  }

  private authorityChecks(identity: { issuer: string; subject: string }, entitlementRevision: number, binding: AccessRow) {
    return [
      { key: { PK: identityPartition(this.store.environment, identity.issuer, identity.subject), SK: 'ENTITLEMENT' },
        expectedRevision: entitlementRevision, projection: true },
      { key: { PK: binding.PK, SK: binding.SK }, expectedRevision: binding.revision },
    ];
  }

  private async revokeFamily(family: AccessRow, reason: 'client_revoke' | 'replay' | 'subscription_revoked', now: number) {
    if (family.status !== 'active') return;
    const revoked = { ...family, status: 'revoked', revoked_at: now, revocation_reason: reason, revision: family.revision + 1 };
    try { await this.commit([{ row: revoked, expectedRevision: family.revision }]); }
    catch (error) {
      if (this.isConflict(error)) {
        const latest = await this.read(grantFamilyKey(this.store.environment, family.grant_id));
        if (latest?.status === 'revoked') return;
      }
      throw error;
    }
  }

  private scopes(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(scope => typeof scope !== 'string')) this.invalidGrant();
    try { return parseScopes((value as string[]).join(' ')); } catch { this.invalidGrant(); }
  }
  private narrowScopes(value: string | undefined, original: unknown): string[] {
    const scopes = this.scopes(original);
    if (value === undefined) return scopes;
    let requested: string[];
    try { requested = parseScopes(value); } catch { throw new OAuthTokenFailure(400, 'invalid_request'); }
    if (requested.some(scope => !scopes.includes(scope))) this.invalidGrant();
    return requested;
  }
  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new OAuthTokenFailure(503, 'temporarily_unavailable');
    return now;
  }
  private async read(key: StateKey): Promise<AccessRow | undefined> {
    try { return await this.store.get(key); }
    catch { throw new OAuthTokenFailure(503, 'temporarily_unavailable'); }
  }
  private async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }>): Promise<void> {
    try { await this.store.commit(writes, checks); }
    catch (error) {
      if (this.isConflict(error)) throw new OAuthTokenFailure(400, 'invalid_grant');
      throw new OAuthTokenFailure(503, 'temporarily_unavailable');
    }
  }
  private isConflict(error: unknown) {
    return error instanceof Error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name);
  }
  private invalidGrant(): never { throw new OAuthTokenFailure(400, 'invalid_grant'); }
}
