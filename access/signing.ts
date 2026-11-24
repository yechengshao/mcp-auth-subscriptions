import { createHash, createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { JWK } from 'jose';
import { publicKeySet } from '../security/jwks.js';
import { validateServiceClaims, validateTrust, type ServiceClaims, type TokenTrust } from '../security/service-token.js';
import type { Telemetry } from '../observability/telemetry.js';
export interface SigningConfiguration { keyArn: string; kid: string; publicJwk: JWK }
/** KMS operations used by the coordinator. The private key never leaves KMS. */
export interface SigningBackend {
  publicKeyDer(signal: AbortSignal): Promise<Uint8Array>;
  signDigest(digest: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}
const KEY_ARN = /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEADLINE_MS = 3000;
/** Runs one KMS operation with a three-second deadline and aborts it when the deadline passes. */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(abort.signal), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('signing_key_unavailable')); }, DEADLINE_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
/**
 * Verifies that KMS holds the configured public key (cached for at most maxAge), and signs digests through KMS.
 * No private material is held in memory, on disk, in DynamoDB, in JWKS or in logs.
 */
export function createSigningKeyCache(backend: SigningBackend, config: SigningConfiguration,
  options: { now?: () => number; maxAgeMs?: number } = {}) {
  const now = options.now ?? Date.now, maxAge = options.maxAgeMs ?? 300000;
  if (!KEY_ARN.test(config.keyArn) || config.publicJwk.kid !== config.kid ||
      !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 300000) throw new Error('invalid_signing_configuration');
  const fixed = structuredClone(config);
  let verifiedAt: number | undefined, pending: Promise<void> | undefined;
  async function verify(): Promise<void> {
    const started = now();
    try {
      await publicKeySet({ keys: [fixed.publicJwk] });
      const der = await withDeadline(signal => backend.publicKeyDer(signal));
      const actual = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' }).export({ format: 'jwk' });
      if (actual.kty !== 'RSA' || actual.n !== fixed.publicJwk.n || actual.e !== fixed.publicJwk.e) throw new Error('signing_key_unavailable');
      const finished = now();
      if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started >= maxAge) throw new Error('signing_key_unavailable');
      verifiedAt = started;
    } catch { verifiedAt = undefined; throw new Error('signing_key_unavailable'); }
  }
  return {
    kid: fixed.kid,
    async verified(): Promise<void> {
      const time = now(); if (!Number.isFinite(time) || time < 0) throw new Error('signing_key_unavailable');
      if (verifiedAt !== undefined && time >= verifiedAt && time < verifiedAt + maxAge) return;
      if (!pending) pending = verify().finally(() => { pending = undefined; });
      return pending;
    },
    signDigest(digest: Uint8Array): Promise<Uint8Array> {
      return withDeadline(signal => backend.signDigest(digest, signal));
    },
  };
}
/** KMS adapter. Key material never leaves KMS; the only operations are GetPublicKey and Sign with a SHA-256 digest. */
export function kmsSigningBackend(config: SigningConfiguration, telemetry: Telemetry, kms = new KMSClient({
  maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
})): SigningBackend {
  const keyArn = config.keyArn;
  return {
    async publicKeyDer(signal) {
      const result = await telemetry.dependency('kms.signing', () => kms.send(
        new GetPublicKeyCommand({ KeyId: keyArn }), { abortSignal: signal }));
      if (!result.PublicKey) throw new Error('signing_key_unavailable');
      return result.PublicKey;
    },
    async signDigest(digest, signal) {
      const result = await telemetry.dependency('kms.signing', () => kms.send(new SignCommand({
        KeyId: keyArn, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
      }), { abortSignal: signal }));
      if (!result.Signature) throw new Error('token_signing_failed');
      return result.Signature;
    },
  };
}
export type SigningKey = ReturnType<typeof createSigningKeyCache>;
/** Caller validates authority and commits code/refresh consumption with current revision guards before releasing credentials. */
export function createServiceTokenSigner(input: TokenTrust, keys: SigningKey, now = () => Math.floor(Date.now() / 1000)) {
  const trust = validateTrust(input);
  return async (claims: ServiceClaims) => {
    validateServiceClaims(claims, trust, now());
    await keys.verified();
    validateServiceClaims(claims, trust, now()); // Never issue past paid expiry after a slow key check.
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: keys.kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const digest = createHash('sha256').update(signingInput).digest();
      const signature = await keys.signDigest(digest);
      if (signature.length !== 256) throw new Error('token_signing_failed');
      return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    } catch { throw new Error('token_signing_failed'); }
  };
}
