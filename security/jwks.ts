import { importJWK, type JWK } from 'jose';
import { opaqueId, validateHttps } from './service-token.js';
export async function publicKeySet(input: unknown): Promise<Map<string, CryptoKey>> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'keys')) throw new Error('invalid_trusted_jwks');
  const keys = (input as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > 10) throw new Error('invalid_trusted_jwks');
  const result = new Map<string, CryptoKey>();
  for (const row of keys) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['kty','kid','alg','use','n','e','key_ops'].includes(key)) ||
        row.kty !== 'RSA' || row.alg !== 'RS256' || row.use !== 'sig' || typeof row.kid !== 'string' || !opaqueId.test(row.kid) || result.has(row.kid) ||
        typeof row.n !== 'string' || !/^[A-Za-z0-9_-]{342,1366}$/.test(row.n) || row.e !== 'AQAB' ||
        (row.key_ops !== undefined && (row.key_ops.length !== 1 || row.key_ops[0] !== 'verify'))) throw new Error('invalid_trusted_jwks');
    const key = await importJWK(row as JWK, 'RS256');
    if (key instanceof Uint8Array || !['public'].includes(key.type) ||
        (key.algorithm as RsaKeyAlgorithm).modulusLength < 2048 || (key.algorithm as RsaKeyAlgorithm).modulusLength > 8192) throw new Error('invalid_trusted_jwks');
    result.set(row.kid, key);
  }
  return result;
}
/** Fixed trusted source; a token cannot supply a URL, key, issuer or cache policy. */
export class TrustedJwks {
  private keys: Map<string, CryptoKey> | undefined;
  private loadedAt = 0;
  private pending: Promise<void> | undefined;
  private readonly negative = new Map<string, number>();
  private nextUnknownRefresh = 0;
  constructor(private readonly loader: (signal: AbortSignal) => Promise<unknown>,
    private readonly now = Date.now, private readonly maxAgeMs = 300000) {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300000) throw new Error('invalid_jwks_cache_configuration');
  }
  private async load() {
    if (!this.pending) this.pending = (async () => {
      const started = this.now(), controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([this.loader(controller.signal), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('trusted_jwks_unavailable')); }, 3000);
        })]);
        const keys = await publicKeySet(value);
        const finished = this.now();
        if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started >= this.maxAgeMs) throw new Error('trusted_jwks_unavailable');
        this.keys = keys; this.loadedAt = started;
      } finally { if (timer) clearTimeout(timer); }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async get(kid: string): Promise<CryptoKey> {
    if (!opaqueId.test(kid)) throw new Error('invalid_access_token');
    const now = this.now(); if (!Number.isFinite(now) || now < 0) throw new Error('trusted_jwks_unavailable');
    let loaded = false;
    if (!this.keys || now < this.loadedAt || now >= this.loadedAt + this.maxAgeMs) { await this.load(); loaded = true; }
    const known = this.keys!.get(kid); if (known) return known;
    if ((this.negative.get(kid) ?? 0) > now) throw new Error('unknown_signing_key');
    if (!loaded && now >= this.nextUnknownRefresh) { this.nextUnknownRefresh = now + 30000; await this.load(); }
    else if (loaded) this.nextUnknownRefresh = now + 30000;
    const refreshed = this.keys!.get(kid); if (refreshed) return refreshed;
    if (this.negative.size >= 32) this.negative.delete(this.negative.keys().next().value!);
    this.negative.set(kid, now + 30000);
    throw new Error('unknown_signing_key');
  }
}
export function remoteJwks(url: string, transport: typeof fetch = fetch, observe: (work: () => Promise<unknown>) => Promise<unknown> = work => work()) {
  validateHttps(url);
  return new TrustedJwks(async signal => observe(async () => {
    const response = await transport(url, { method: 'GET', signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('trusted_jwks_unavailable');
    const reader = response.body?.getReader(); if (!reader) throw new Error('invalid_trusted_jwks');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 32768) { await reader.cancel(); throw new Error('invalid_trusted_jwks'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }));
}
