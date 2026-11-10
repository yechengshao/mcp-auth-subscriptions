import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { validateCognitoConfiguration, type CognitoConfiguration } from './config.js';
import { IdentityProviderFailure, type IdentityProvider } from './ports.js';
import type { Telemetry } from '../observability/telemetry.js';
import { parseScopes } from '../security/service-token.js';
export class CognitoFailure extends IdentityProviderFailure {}
export interface VerifiedIdentity { issuer: string; subject: string }
async function readBoundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  const body = response.body;
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !body) {
    await body?.cancel().catch(() => undefined);
    throw new CognitoFailure(503);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await body.cancel().catch(() => undefined);
    throw new CognitoFailure(503);
  }
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new CognitoFailure(503);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CognitoFailure(503);
  return parsed as Record<string, unknown>;
}
/** Cognito is identity-only. Neither provider token is persisted, exposed, or exchanged for MCP directly. */
export class CognitoIdentity implements IdentityProvider {
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
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new CognitoFailure(response.status === 400 ? 400 : 503);
        }
        return readBoundedJson(response, 65536);
      }, { expectedError: error => error instanceof CognitoFailure && error.status === 400 });
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
      let accessScopes: string[];
      try { accessScopes = parseScopes(access.scope); } catch { throw new CognitoFailure(400); }
      const nonceDigestValue = typeof id.nonce === 'string' ? createHash('sha256').update(id.nonce).digest() : Buffer.alloc(0);
      if (id.aud !== this.config.clientId || id.token_use !== 'id' || access.token_use !== 'access' || access.client_id !== this.config.clientId || typeof id.sub !== 'string' ||
          !id.sub.length || id.sub.length > 2048 || access.sub !== id.sub || typeof id.nonce !== 'string' ||
          nonceDigestValue.length !== 32 || !timingSafeEqual(nonceDigestValue, Buffer.from(nonceDigest, 'hex')) ||
          !accessScopes.includes('openid') || this.config.scopes.some(scope => !accessScopes.includes(scope))) throw new CognitoFailure(400);
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
