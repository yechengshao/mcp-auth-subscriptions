import { createHash, createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { JWK } from 'jose';
import { publicKeySet } from '../security/jwks.js';
import { validateServiceClaims, validateTrust, type ServiceClaims, type TokenTrust } from '../security/service-token.js';
import type { Telemetry } from '../observability/telemetry.js';
import { createTtlCache } from '../contracts/ttl-cache.js';

/** Public material derived from the key ARN, plus a signer bound to that same ARN. The private key never leaves KMS. */
export interface PublishedSigningKey {
  keyArn: string;
  kid: string;
  publicJwk: JWK;
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

/** Read-only view for publishing: the JWKS is derived from the same key the signer uses. */
export interface PublicKeySource { jwks(): Promise<{ keys: JWK[] }> }

/** AWS operations used by the coordinator: one SSM read for the ARN, KMS GetPublicKey and Sign. */
export interface SigningBackend {
  keyArn(signal: AbortSignal): Promise<string>;
  publicKeyDer(keyArn: string, signal: AbortSignal): Promise<Uint8Array>;
  signDigest(keyArn: string, digest: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

const KEY_ARN = /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARAMETER_NAME = /^\/mcp\/(development|test|production)\/access\/signing-key-arn$/;
const DEADLINE_MS = 3000;
const MIN_MODULUS_BITS = 2048, MAX_MODULUS_BITS = 8192;

/** Runs one AWS operation with a three-second deadline and aborts it when the deadline passes. */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(abort.signal), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('signing_key_unavailable')); }, DEADLINE_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Stable key id: base64url SHA-256 of the DER SubjectPublicKeyInfo, so one key always has one kid. */
export function signingKidFor(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('base64url');
}

/**
 * Reads the key ARN once per execution environment, asks KMS for its public key, derives the JWK and kid,
 * and caches the result in memory. A successful derivation is cached for the life of the environment; a
 * failed read is never cached, so the next request retries. Concurrent callers share one derivation.
 */
export function createSigningKeys(backend: SigningBackend) {
  // The ARN is read once per execution environment; a successful derivation lives for the environment too.
  const keyArn = createTtlCache(async (): Promise<string> => {
    const arn = await withDeadline(signal => backend.keyArn(signal));
    if (!KEY_ARN.test(arn)) throw new Error('signing_key_unavailable');
    return arn;
  }, { ttlMs: Infinity });
  const derived = createTtlCache(async (): Promise<PublishedSigningKey> => {
    const arn = await keyArn();
    const der = await withDeadline(signal => backend.publicKeyDer(arn, signal));
    const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    const components = key.export({ format: 'jwk' }) as { kty?: string; n?: string; e?: string };
    if (key.asymmetricKeyType !== 'rsa' || !modulusLength || modulusLength < MIN_MODULUS_BITS || modulusLength > MAX_MODULUS_BITS ||
        components.kty !== 'RSA' || !components.n || !components.e) throw new Error('signing_key_unavailable');
    const kid = signingKidFor(der);
    const publicJwk: JWK = { kty: 'RSA', n: components.n, e: components.e, kid, alg: 'RS256', use: 'sig' };
    await publicKeySet({ keys: [publicJwk] });
    return {
      keyArn: arn, kid, publicJwk,
      sign: digest => withDeadline(signal => backend.signDigest(arn, digest, signal)),
    };
  }, { ttlMs: Infinity });

  const keys = {
    /** The derived key, cached for the environment. Failures surface as signing_key_unavailable and are not cached. */
    current(): Promise<PublishedSigningKey> {
      return derived().catch(() => { throw new Error('signing_key_unavailable'); });
    },
    async jwks(): Promise<{ keys: JWK[] }> {
      const key = await keys.current();
      return { keys: [key.publicJwk] };
    },
  };
  return keys;
}

export type SigningKeys = ReturnType<typeof createSigningKeys>;

/**
 * AWS adapter. The parameter name is the exact deploy-provided SSM parameter that infra/access/signing.yaml
 * publishes. KMS is used only for GetPublicKey and Sign with a SHA-256 digest.
 */
export function awsSigningBackend(parameterName: string | undefined, telemetry: Telemetry, clients: { kms?: KMSClient; ssm?: SSMClient } = {}): SigningBackend {
  if (!parameterName || !PARAMETER_NAME.test(parameterName)) throw new Error('invalid_signing_configuration');
  const kms = clients.kms ?? new KMSClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } });
  const ssm = clients.ssm ?? new SSMClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } });
  return {
    async keyArn(signal) {
      const result = await telemetry.dependency('ssm.catalog', () => ssm.send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: false }), { abortSignal: signal }));
      const value = result.Parameter?.Value;
      if (!value) throw new Error('signing_key_unavailable');
      return value;
    },
    async publicKeyDer(keyArn, signal) {
      const result = await telemetry.dependency('kms.signing', () => kms.send(
        new GetPublicKeyCommand({ KeyId: keyArn }), { abortSignal: signal }));
      if (!result.PublicKey) throw new Error('signing_key_unavailable');
      return result.PublicKey;
    },
    async signDigest(keyArn, digest, signal) {
      const result = await telemetry.dependency('kms.signing', () => kms.send(new SignCommand({
        KeyId: keyArn, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
      }), { abortSignal: signal }));
      if (!result.Signature) throw new Error('token_signing_failed');
      return result.Signature;
    },
  };
}

/** Caller validates authority and commits code/refresh consumption with current revision guards before releasing credentials. */
export function createServiceTokenSigner(input: TokenTrust, keys: SigningKeys, now = () => Math.floor(Date.now() / 1000)) {
  const trust = validateTrust(input);
  return async (claims: ServiceClaims) => {
    validateServiceClaims(claims, trust, now());
    const key = await keys.current();
    validateServiceClaims(claims, trust, now()); // Never issue past paid expiry after a slow key derivation.
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: key.kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signingInput = `${header}.${payload}`;
      const digest = createHash('sha256').update(signingInput).digest();
      const signature = await key.sign(digest);
      if (signature.length !== 256) throw new Error('token_signing_failed');
      return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    } catch { throw new Error('token_signing_failed'); }
  };
}
