import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import { createSigningKeyCache, createServiceTokenSigner, ssmSigningLoader } from '../../access/signing.js';
import { publicKeySet, TrustedJwks, remoteJwks } from '../../security/jwks.js';
import { Telemetry } from '../../observability/telemetry.js';
import { claims, identityFixture, now, trust } from './support/identity_fixture.js';
const fixture = await identityFixture();
const configuration = { parameterArn: 'arn:aws:ssm:us-east-1:000000000000:parameter/test/signing', version: 1, kid: 'fixture_key', publicJwk: fixture.publicJwk };
test('local RS256 signer and trusted public verifier agree; cold/warm/concurrent requests share one key fetch', async () => {
  let reads = 0;
  const cache = createSigningKeyCache(async () => { reads++; return { value: fixture.pem, version: 1 }; }, configuration);
  const sign = createServiceTokenSigner(trust, cache, () => now);
  const tokens = await Promise.all(Array.from({ length: 10 }, () => sign(claims)));
  assert.equal(reads, 1); assert.equal((await cache.get()).extractable, false);
  for (const token of tokens) {
    const result = await jwtVerify(token, fixture.publicKey, { issuer: trust.issuer, audience: trust.resource, currentDate: new Date(now * 1000) });
    assert.equal(result.payload.usageIdentifierKey, claims.usageIdentifierKey);
    assert.equal(result.protectedHeader.typ, 'at+jwt');
  }
});
test('expired signing cache fails closed on outage and recovers without using stale private keys', async () => {
  let time = 0, online = true, reads = 0;
  const cache = createSigningKeyCache(async () => { reads++; if (!online) throw new Error('PRIVATE_PROVIDER_SENTINEL'); return { value: fixture.pem, version: 1 }; }, configuration,
    { now: () => time, maxAgeMs: 100 });
  await cache.get(); online = false; time = 100;
  await assert.rejects(cache.get(), /^Error: signing_key_unavailable$/);
  online = true; time = 101; await cache.get(); assert.equal(reads, 3);
});
test('private/public mismatch, wrong version, malformed key and private JWKS material fail closed', async () => {
  const other = await identityFixture();
  for (const value of [{ value: other.pem, version: 1 }, { value: fixture.pem, version: 2 }, { value: 'PRIVATE_BAD_PEM_SENTINEL', version: 1 }]) {
    const cache = createSigningKeyCache(async () => value, configuration);
    await assert.rejects(cache.get(), /^Error: signing_key_unavailable$/);
  }
  await assert.rejects(publicKeySet({ keys: [{ ...fixture.publicJwk, d: 'PRIVATE_JWK_SENTINEL' }] }));
  await assert.rejects(publicKeySet({ keys: [fixture.publicJwk, fixture.publicJwk] }));
});
test('key rotation retains old public keys while each configured private key matches its pinned kid/version', async () => {
  const next = await identityFixture('next_key');
  const verifier = await publicKeySet({ keys: [fixture.publicJwk, next.publicJwk] });
  for (const [source, kid] of [[fixture, 'fixture_key'], [next, 'next_key']] as const) {
    const cache = createSigningKeyCache(async () => ({ value: source.pem, version: 1 }), { ...configuration, kid, publicJwk: source.publicJwk });
    const token = await createServiceTokenSigner(trust, cache, () => now)(claims);
    assert.equal((await jwtVerify(token, verifier.get(kid)!, { currentDate: new Date(now * 1000) })).payload.sub, claims.sub);
  }
});
test('signing-loader sends only exact parameter ARN/version with decryption and never logs key material', async () => {
  const logs: string[] = []; const commands: unknown[] = [];
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) });
  const ssm = { send: async (command: any) => { commands.push(command.input); return { Parameter: { Type: 'SecureString', Value: fixture.pem, Version: 1 } }; } };
  await createSigningKeyCache(ssmSigningLoader(configuration, telemetry, ssm as any), configuration).get();
  assert.deepEqual(commands, [{ Name: configuration.parameterArn + ':1', WithDecryption: true }]);
  assert.equal(logs.join('').includes(fixture.pem), false);
});
test('a key retrieval crossing paid expiry cannot produce a service token', async () => {
  let clock = now;
  const cache = createSigningKeyCache(async () => { clock = now + 1; return { value: fixture.pem, version: 1 }; }, configuration);
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
test('hung private-key retrieval aborts after three seconds rather than leaving an invocation open', async () => {
  let aborted = false, reads = 0;
  const cache = createSigningKeyCache(signal => {
    reads++; signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => undefined);
  }, configuration);
  const results = await Promise.allSettled([cache.get(), cache.get()]);
  assert.equal(reads, 1); assert.equal(aborted, true);
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.message === 'signing_key_unavailable'), true);
});
test('invalid cache clocks never extend signing-key or public-key trust', async () => {
  let time = 0;
  const privateCache = createSigningKeyCache(async () => ({ value: fixture.pem, version: 1 }), configuration, { now: () => time });
  const publicCache = new TrustedJwks(async () => fixture.jwks, () => time);
  await privateCache.get(); await publicCache.get('fixture_key'); time = NaN;
  await assert.rejects(privateCache.get(), /signing_key_unavailable/);
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
