import { createPublicKey } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SignJWT, importPKCS8, type JWK } from 'jose';
import { publicKeySet } from '../security/jwks.js';
import { validateServiceClaims, validateTrust, type ServiceClaims, type TokenTrust } from '../security/service-token.js';
import type { Telemetry } from '../observability/telemetry.js';
export interface SigningConfiguration { parameterArn: string; version: number; kid: string; publicJwk: JWK }
export type PrivateKeyLoader = (signal: AbortSignal) => Promise<{ value: string; version: number }>;
/** No private material is stored on disk, in DynamoDB, in JWKS or in logs. */
export function createSigningKeyCache(loader: PrivateKeyLoader, config: SigningConfiguration,
  options: { now?: () => number; maxAgeMs?: number } = {}) {
  const now = options.now ?? Date.now, maxAge = options.maxAgeMs ?? 300000;
  if (!/^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter\/[A-Za-z0-9_.\/-]+$/.test(config.parameterArn) ||
      !Number.isSafeInteger(config.version) || config.version < 1 || config.publicJwk.kid !== config.kid ||
      !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 300000) throw new Error('invalid_signing_configuration');
  const fixed = structuredClone(config);
  let cached: CryptoKey | undefined, loadedAt = 0, pending: Promise<CryptoKey> | undefined;
  async function load(): Promise<CryptoKey> {
    const started = now(), abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await publicKeySet({ keys: [fixed.publicJwk] });
      const result = await Promise.race([loader(abort.signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('signing_key_unavailable')); }, 3000);
      })]);
      if (result.version !== fixed.version || typeof result.value !== 'string' || result.value.length > 8192) throw new Error('signing_key_unavailable');
      const actual = createPublicKey(result.value).export({ format: 'jwk' });
      if (actual.kty !== 'RSA' || actual.n !== fixed.publicJwk.n || actual.e !== fixed.publicJwk.e) throw new Error('signing_key_unavailable');
      const key = await importPKCS8(result.value, 'RS256');
      const finished = now();
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started >= maxAge) throw new Error('signing_key_unavailable');
      cached = key; loadedAt = started; return key;
    } catch { cached = undefined; throw new Error('signing_key_unavailable'); }
    finally { if (timer) clearTimeout(timer); }
  }
  return {
    kid: fixed.kid,
    async get() {
      const time = now(); if (!Number.isFinite(time) || time < 0) throw new Error('signing_key_unavailable');
      if (cached && time >= loadedAt && time < loadedAt + maxAge) return cached;
      if (!pending) pending = load().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
export function ssmSigningLoader(config: SigningConfiguration, telemetry: Telemetry, ssm = new SSMClient({
  maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
})): PrivateKeyLoader {
  const fixed = structuredClone(config);
  return async signal => {
    try {
      const result = await telemetry.dependency('ssm.signing_key', () => ssm.send(new GetParameterCommand({ Name: `${fixed.parameterArn}:${fixed.version}`, WithDecryption: true }), { abortSignal: signal }));
      if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value || result.Parameter.Version !== fixed.version) throw new Error('signing_key_unavailable');
      return { value: result.Parameter.Value, version: result.Parameter.Version };
    } catch { throw new Error('signing_key_unavailable'); }
  };
}
/** Caller validates authority and commits code/refresh consumption with current revision guards before releasing credentials. */
export function createServiceTokenSigner(input: TokenTrust, keys: ReturnType<typeof createSigningKeyCache>, now = () => Math.floor(Date.now() / 1000)) {
  const trust = validateTrust(input);
  return async (claims: ServiceClaims) => {
    validateServiceClaims(claims, trust, now());
    const key = await keys.get();
    validateServiceClaims(claims, trust, now()); // Never issue past paid expiry after a slow key retrieval.
    try { return await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: keys.kid }).sign(key); }
    catch { throw new Error('token_signing_failed'); }
  };
}
