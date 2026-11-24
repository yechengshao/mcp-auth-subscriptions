import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, createPrivateKey, createPublicKey, privateEncrypt } from 'node:crypto';
import { jwtVerify } from 'jose';
import { createSigningKeyCache, createServiceTokenSigner, kmsSigningBackend, type SigningBackend } from '../../access/signing.js';
import { publicKeySet, TrustedJwks, remoteJwks } from '../../security/jwks.js';
import { Telemetry } from '../../observability/telemetry.js';
import { claims, identityFixture, now, trust } from './support/identity_fixture.js';
const fixture = await identityFixture();
const configuration = { keyArn: 'arn:aws:kms:us-east-1:000000000000:key/11111111-2222-3333-4444-555555555555', kid: 'fixture_key', publicJwk: fixture.publicJwk };
const DIGEST_INFO_SHA256 = Buffer.from('3031300d060960864801650304020105000420', 'hex');
const spki = (pem: string) => createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }) as Buffer;
/** Stands in for KMS: signs a SHA-256 digest with RSASSA-PKCS1-v1_5 using the fixture key. */
function fakeKms(pem: string, changes: Partial<SigningBackend> = {}): SigningBackend {
  return {
    publicKeyDer: async () => spki(pem),
    signDigest: async digest => privateEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO_SHA256, Buffer.from(digest)])),
    ...changes,
  };
}
test('KMS-backed RS256 signer and trusted public verifier agree; cold/warm/concurrent requests share one public-key check', async () => {
  let checks = 0, digests = 0;
  const backend = fakeKms(fixture.pem, {
    publicKeyDer: async () => { checks++; return spki(fixture.pem); },
    signDigest: async digest => { digests++; return fakeKms(fixture.pem).signDigest(digest, new AbortController().signal); },
  });
  const cache = createSigningKeyCache(backend, configuration);
  const sign = createServiceTokenSigner(trust, cache, () => now);
  const tokens = await Promise.all(Array.from({ length: 10 }, () => sign(claims)));
  assert.equal(checks, 1); assert.equal(digests, 10);
  for (const token of tokens) {
    const result = await jwtVerify(token, fixture.publicKey, { issuer: trust.issuer, audience: trust.resource, currentDate: new Date(now * 1000) });
    assert.equal(result.payload.usageIdentifierKey, claims.usageIdentifierKey);
    assert.equal(result.protectedHeader.typ, 'at+jwt');
    assert.equal(result.protectedHeader.kid, 'fixture_key');
  }
});
test('the signer sends only a SHA-256 digest of the JWS signing input to KMS', async () => {
  const digests: Buffer[] = [];
  const cache = createSigningKeyCache(fakeKms(fixture.pem, {
    signDigest: async digest => { digests.push(Buffer.from(digest)); return fakeKms(fixture.pem).signDigest(digest, new AbortController().signal); },
  }), configuration);
  const token = await createServiceTokenSigner(trust, cache, () => now)(claims);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(digests, [createHash('sha256').update(`${header}.${payload}`).digest()]);
  assert.equal(Buffer.from(signature!, 'base64url').length, 256);
});
test('expired public-key verification fails closed on outage and recovers without trusting stale results', async () => {
  let time = 0, online = true, reads = 0;
  const cache = createSigningKeyCache(fakeKms(fixture.pem, {
    publicKeyDer: async () => { reads++; if (!online) throw new Error('KMS_PROVIDER_SENTINEL'); return spki(fixture.pem); },
  }), configuration, { now: () => time, maxAgeMs: 100 });
  await cache.verified(); online = false; time = 100;
  await assert.rejects(cache.verified(), /^Error: signing_key_unavailable$/);
  online = true; time = 101; await cache.verified(); assert.equal(reads, 3);
});
test('a KMS key that differs from the configured public key, malformed DER and private JWKS material fail closed', async () => {
  const other = await identityFixture();
  for (const der of [spki(other.pem), Buffer.from([1, 2, 3])]) {
    const cache = createSigningKeyCache(fakeKms(fixture.pem, { publicKeyDer: async () => der }), configuration);
    await assert.rejects(cache.verified(), /^Error: signing_key_unavailable$/);
  }
  await assert.rejects(publicKeySet({ keys: [{ ...fixture.publicJwk, d: 'PRIVATE_JWK_SENTINEL' }] }));
  await assert.rejects(publicKeySet({ keys: [fixture.publicJwk, fixture.publicJwk] }));
});
test('a configuration whose KMS key ARN or kid is malformed is refused before any call', async () => {
  for (const bad of [{ ...configuration, keyArn: 'arn:aws:kms:us-east-1:000000000000:alias/mcp-access-signing' },
    { ...configuration, keyArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test/signing-AbCdEf' },
    { ...configuration, kid: 'other_key' }]) {
    assert.throws(() => createSigningKeyCache(fakeKms(fixture.pem), bad), /invalid_signing_configuration/);
  }
});
test('key rotation retains old public keys while each configured KMS key matches its pinned kid', async () => {
  const next = await identityFixture('next_key');
  const verifier = await publicKeySet({ keys: [fixture.publicJwk, next.publicJwk] });
  for (const [source, kid] of [[fixture, 'fixture_key'], [next, 'next_key']] as const) {
    const cache = createSigningKeyCache(fakeKms(source.pem), { ...configuration, kid, publicJwk: source.publicJwk });
    const token = await createServiceTokenSigner(trust, cache, () => now)(claims);
    assert.equal((await jwtVerify(token, verifier.get(kid)!, { currentDate: new Date(now * 1000) })).payload.sub, claims.sub);
  }
});
test('KMS adapter calls only GetPublicKey and Sign on the pinned key and never logs key material', async () => {
  const logs: string[] = []; const commands: { name: string; input: Record<string, unknown> }[] = [];
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) });
  const kms = { send: async (command: any) => {
    commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetPublicKeyCommand') return { PublicKey: spki(fixture.pem) };
    return { Signature: fakeKms(fixture.pem).signDigest(command.input.Message, new AbortController().signal) };
  } };
  const cache = createSigningKeyCache(kmsSigningBackend(configuration, telemetry, kms as any), configuration);
  await createServiceTokenSigner(trust, cache, () => now)(claims);
  assert.deepEqual(commands.map(command => command.name), ['GetPublicKeyCommand', 'SignCommand']);
  assert.deepEqual(commands[0]!.input, { KeyId: configuration.keyArn });
  assert.equal(commands[1]!.input.KeyId, configuration.keyArn);
  assert.equal(commands[1]!.input.MessageType, 'DIGEST');
  assert.equal(commands[1]!.input.SigningAlgorithm, 'RSASSA_PKCS1_V1_5_SHA_256');
  assert.equal((commands[1]!.input.Message as Uint8Array).length, 32);
  const output = logs.join('');
  assert.equal(output.includes(fixture.pem), false);
  assert.equal(output.includes(claims.usageIdentifierKey), false);
});
test('a key check crossing paid expiry cannot produce a service token', async () => {
  let clock = now;
  const cache = createSigningKeyCache(fakeKms(fixture.pem, {
    publicKeyDer: async () => { clock = now + 1; return spki(fixture.pem); },
  }), configuration);
  const signer = createServiceTokenSigner(trust, cache, () => clock);
  await assert.rejects(signer({ ...claims, exp: now + 1, subscription_valid_until: now + 1 }), /invalid_access_token/);
});
test('JWKS unknown-kid refresh is bounded and repeated attacker kids cannot trigger unbounded fetches', async () => {
  let reads = 0, time = 1000;
  const rotated = await identityFixture('next_key'); let value = fixture.jwks;
  const cache = new TrustedJwks(async () => { reads++; return value; }, () => time);
  await cache.get('fixture_key'); value = { keys: [fixture.publicJwk, rotated.publicJwk] };
  await cache.get('next_key'); assert.equal(reads, 2);
  for (let index = 0; index < 100; index++) await assert.rejects(cache.get(`unknown_${index}`), /unknown_signing_key/);
  assert.equal(reads, 2);
  time += 300001;
  await cache.get('fixture_key'); assert.equal(reads, 3);
});
test('expired JWKS cache cannot verify with stale keys while its source is unavailable', async () => {
  let time = 0, online = true;
  const cache = new TrustedJwks(async () => { if (!online) throw new Error('unavailable'); return fixture.jwks; }, () => time, 100);
  await cache.get('fixture_key'); online = false; time = 100;
  await assert.rejects(cache.get('fixture_key'));
});
test('hung KMS call aborts after three seconds rather than leaving an invocation open', async () => {
  let aborted = false, reads = 0;
  const cache = createSigningKeyCache(fakeKms(fixture.pem, {
    signDigest: (_digest, signal) => { reads++; signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => undefined); },
  }), configuration);
  const sign = createServiceTokenSigner(trust, cache, () => now);
  const results = await Promise.allSettled([sign(claims), sign(claims)]);
  assert.equal(reads, 2); assert.equal(aborted, true);
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.message === 'token_signing_failed'), true);
});
test('invalid cache clocks never extend signing-key or public-key trust', async () => {
  let time = 0;
  const keyCache = createSigningKeyCache(fakeKms(fixture.pem), configuration, { now: () => time });
  const publicCache = new TrustedJwks(async () => fixture.jwks, () => time);
  await keyCache.verified(); await publicCache.get('fixture_key'); time = NaN;
  await assert.rejects(keyCache.verified(), /signing_key_unavailable/);
  await assert.rejects(publicCache.get('fixture_key'), /trusted_jwks_unavailable/);
});
test('trusted JWKS HTTP reader cancels oversized responses without buffering the whole body', async () => {
  let cancelled = false;
  const transport = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; },
  }));
  const cache = remoteJwks('https://keys.example.invalid/jwks', transport as typeof fetch);
  await assert.rejects(cache.get('fixture_key'), /invalid_trusted_jwks/); assert.equal(cancelled, true);
});
