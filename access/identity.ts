import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { validateCognitoConfiguration, type CognitoConfiguration } from './config.js';
import type { Telemetry } from '../observability/telemetry.js';
export class CognitoFailure extends Error {
  constructor(readonly status: 400 | 503) { super(status === 400 ? 'identity_verification_failed' : 'identity_provider_unavailable'); }
}
export interface VerifiedIdentity { issuer: string; subject: string }
/** Cognito is identity-only. Neither provider token is persisted, exposed, or exchanged for MCP directly. */
export class CognitoIdentity {
  readonly config: CognitoConfiguration;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(config: CognitoConfiguration, private readonly telemetry: Telemetry,
    private readonly transport: typeof fetch = fetch, private readonly now = () => Math.floor(Date.now() / 1000)) {
    this.config = validateCognitoConfiguration(config);
    this.keys = createRemoteJWKSet(new URL(this.config.issuer + '/.well-known/jwks.json'), {
      timeoutDuration: 3000, cacheMaxAge: 300000, cooldownDuration: 30000,
      [customFetch]: (url, init) => this.telemetry.dependency('cognito.request', async () => {
        try { return await this.transport(url, { ...init, redirect: 'error' }); } catch { throw new CognitoFailure(503); }
      }),
    });
  }
  authorize(state: string, nonce: string, challenge: string) {
    const url = new URL(this.config.domain.replace(/\/$/, '') + '/oauth2/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.callbackUri,
      scope: this.config.scopes.join(' '), state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.toString();
  }
  async exchange(code: string, verifier: string, nonceDigest: string): Promise<VerifiedIdentity> {
    if (typeof code !== 'string' || !code.length || code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[a-f0-9]{64}$/.test(nonceDigest)) throw new CognitoFailure(400);
    let tokens: Record<string, unknown>;
    try {
      tokens = await this.telemetry.dependency('cognito.request', async () => {
        const response = await this.transport(this.config.domain.replace(/\/$/, '') + '/oauth2/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, redirect_uri: this.config.callbackUri, code, code_verifier: verifier }).toString(),
        });
        if (!response.ok) throw new CognitoFailure(response.status === 400 ? 400 : 503);
        const text = await response.text(); if (Buffer.byteLength(text) > 65536) throw new CognitoFailure(503);
        return JSON.parse(text) as Record<string, unknown>;
      });
    } catch (error) { if (error instanceof CognitoFailure) throw error; throw new CognitoFailure(503); }
    try {
      if (!tokens || typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string' ||
          tokens.id_token.length > 32768 || tokens.access_token.length > 32768 || tokens.token_type !== 'Bearer') throw new CognitoFailure(400);
      for (const token of [tokens.id_token, tokens.access_token]) {
        const header = decodeProtectedHeader(token);
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || ['jku','jwk','x5u','x5c'].some(field => header[field] !== undefined)) throw new CognitoFailure(400);
      }
      const options = { algorithms: ['RS256'], issuer: this.config.issuer, currentDate: new Date(this.now() * 1000), clockTolerance: 0 };
      const id = (await jwtVerify(tokens.id_token, this.keys, { ...options, audience: this.config.clientId })).payload;
      const access = (await jwtVerify(tokens.access_token, this.keys, options)).payload;
      this.time(id); this.time(access);
      if (id.aud !== this.config.clientId || id.token_use !== 'id' || access.token_use !== 'access' || access.client_id !== this.config.clientId || typeof id.sub !== 'string' ||
          !id.sub.length || id.sub.length > 2048 || access.sub !== id.sub || typeof id.nonce !== 'string' ||
          createHash('sha256').update(id.nonce).digest('hex') !== nonceDigest || typeof access.scope !== 'string' || !access.scope.split(' ').includes('openid')) throw new CognitoFailure(400);
      return { issuer: this.config.issuer, subject: id.sub };
    } catch (error) {
      if (error instanceof CognitoFailure) throw error;
      const code = (error as { code?: string })?.code;
      if (code && ['ERR_JWT_EXPIRED','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_INVALID','ERR_JWT_INVALID','ERR_JWS_SIGNATURE_VERIFICATION_FAILED','ERR_JOSE_ALG_NOT_ALLOWED','ERR_JWKS_NO_MATCHING_KEY'].includes(code)) throw new CognitoFailure(400);
      throw new CognitoFailure(503);
    }
  }
  private time(value: JWTPayload) {
    const now = this.now();
    if (!Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.iat! > now || value.exp! <= now || value.exp! <= value.iat!) throw new CognitoFailure(400);
  }
}
