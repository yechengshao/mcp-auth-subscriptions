import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateEncrypt } from 'node:crypto';
import { jwtVerify } from 'jose';
import { awsSigningBackend, createSigningKeys, createServiceTokenSigner, signingKidFor, type SigningBackend } from '../../access/signing.js';
import { publicKeySet, TrustedJwks, remoteJwks } from '../../security/jwks.js';
import { Telemetry } from '../../observability/telemetry.js';
import { claims, identityFixture, now, trust } from './support/identity_fixture.js';

const fixture = await identityFixture();
const ARN = 'arn:aws:kms:ca-central-1:503098479806:key/11111111-2222-3333-4444-555555555555';
const PARAMETER = '/mcp/test/access/signing-key-arn';
const DIGEST_INFO_SHA256 = Buffer.from('3031300d060960864801650304020105000420', 'hex');
const spki = (pem: string) => createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }) as Buffer;

/** Stands in for SSM and KMS: returns the ARN, the public key for it, and signs digests with the fixture key. */
function fakeAws(pem: string, changes: Partial<SigningBackend> = {}): SigningBackend {
  return {
    keyArn: async () => ARN,
    publicKeyDer: async () => spki(pem),
    signDigest: async (_arn, digest) => privateEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([DIGEST_INFO_SHA256, Buffer.from(digest)])),
    ...changes,
  };
}

test('the public JWK is derived from the ARN once; cold, warm and concurrent requests share that one derivation', async () => {
  let arnReads = 0, keyReads = 0;
  const keys = createSigningKeys(fakeAws(fixture.pem, {
    keyArn: async () => { arnReads++; return ARN; },
    publicKeyDer: async () => { keyReads++; return spki(fixture.pem); },
  }));
  const sign = createServiceTokenSigner(trust, keys, () => now);
  const tokens = await Promise.all(Array.from({ length: 10 }, () => sign(claims)));
  await sign(claims);
  assert.equal(arnReads, 1); assert.equal(keyReads, 1);
  const kid = signingKidFor(spki(fixture.pem));
  for (const token of tokens) {
    const result = await jwtVerify(token, fixture.publicKey, { issuer: trust.issuer, audience: trust.resource, currentDate: new Date(now * 1000) });
    assert.equal(result.payload.usageIdentifierKey, claims.usageIdentifierKey);
    assert.equal(result.protectedHeader.typ, 'at+jwt');
    assert.equal(result.protectedHeader.kid, kid);
  }
});

test('the JWKS and the signer come from the same ARN, so a token verifies against the published key', async () => {
  const keys = createSigningKeys(fakeAws(fixture.pem));
  const token = await createServiceTokenSigner(trust, keys, () => now)(claims);
  const published = await keys.jwks();
  assert.equal(published.keys.length, 1);
  assert.equal(Object.keys(published.keys[0]!).some(key => ['d', 'p', 'q'].includes(key)), false);
  const verifier = await publicKeySet(published);
  const kid = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid;
  assert.equal(kid, published.keys[0]!.kid);
  assert.equal((await jwtVerify(token, verifier.get(kid as string)!, { currentDate: new Date(now * 1000) })).payload.sub, claims.sub);
});

test('the signer sends only a SHA-256 digest of the JWS signing input to KMS', async () => {
  const digests: Buffer[] = [];
  const keys = createSigningKeys(fakeAws(fixture.pem, {
    signDigest: async (arn, digest) => { digests.push(Buffer.from(digest)); return fakeAws(fixture.pem).signDigest(arn, digest, new AbortController().signal); },
  }));
  const token = await createServiceTokenSigner(trust, keys, () => now)(claims);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(digests, [createHash('sha256').update(`${header}.${payload}`).digest()]);
  assert.equal(Buffer.from(signature!, 'base64url').length, 256);
});

test('a failed ARN or key read is never cached: the outage fails closed and the next request re-reads', async () => {
  let online = false, reads = 0;
  const keys = createSigningKeys(fakeAws(fixture.pem, {
    publicKeyDer: async () => { reads++; if (!online) throw new Error('KMS_PROVIDER_SENTINEL'); return spki(fixture.pem); },
  }));
  const sign = createServiceTokenSigner(trust, keys, () => now);
  await assert.rejects(sign(claims), /^Error: signing_key_unavailable$/);
  await assert.rejects(keys.jwks());
  online = true;
  await sign(claims); await keys.jwks();
  assert.equal(reads, 3);
});

test('malformed DER, a key outside the RSA size range and an invalid ARN fail closed', async () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const smallDer = small.publicKey.export({ type: 'spki', format: 'der' });
  for (const der of [Buffer.from([1, 2, 3]), smallDer]) {
    const keys = createSigningKeys(fakeAws(fixture.pem, { publicKeyDer: async () => der }));
    await assert.rejects(keys.current(), /^Error: signing_key_unavailable$/);
  }
  const badArn = createSigningKeys(fakeAws(fixture.pem, { keyArn: async () => 'arn:aws:kms:ca-central-1:503098479806:alias/mcp-access-signing' }));
  await assert.rejects(badArn.current(), /^Error: signing_key_unavailable$/);
  assert.throws(() => awsSigningBackend('/mcp/test/access/other', new Telemetry({ service: 'access', environment: 'test', release: 'fixture' })),
    /invalid_signing_configuration/);
});

test('a changed ARN in a new environment publishes its own kid, and tokens from each key verify against both', async () => {
  const next = await identityFixture('next_key');
  const first = createSigningKeys(fakeAws(fixture.pem));
  const second = createSigningKeys(fakeAws(next.pem, { keyArn: async () => 'arn:aws:kms:ca-central-1:503098479806:key/66666666-7777-8888-9999-000000000000' }));
  const verifier = await publicKeySet({ keys: [...(await first.jwks()).keys, ...(await second.jwks()).keys] });
  for (const keys of [first, second]) {
    const token = await createServiceTokenSigner(trust, keys, () => now)(claims);
    const kid = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid;
    assert.equal((await jwtVerify(token, verifier.get(kid as string)!, { currentDate: new Date(now * 1000) })).payload.sub, claims.sub);
  }
});

test('KMS and SSM adapters call only GetParameter, GetPublicKey and Sign on the exact parameter and key, and never log key material', async () => {
  const logs: string[] = []; const commands: { name: string; input: Record<string, unknown> }[] = [];
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) });
  const kms = { send: async (command: any) => {
    commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetPublicKeyCommand') return { PublicKey: spki(fixture.pem) };
    return { Signature: fakeAws(fixture.pem).signDigest(ARN, command.input.Message, new AbortController().signal) };
  } };
  const ssm = { send: async (command: any) => {
    commands.push({ name: command.constructor.name, input: command.input });
    return { Parameter: { Value: ARN } };
  } };
  const keys = createSigningKeys(awsSigningBackend(PARAMETER, telemetry, { kms: kms as any, ssm: ssm as any }));
  await createServiceTokenSigner(trust, keys, () => now)(claims);
  assert.deepEqual(commands.map(command => command.name), ['GetParameterCommand', 'GetPublicKeyCommand', 'SignCommand']);
  assert.deepEqual(commands[0]!.input, { Name: PARAMETER, WithDecryption: false });
  assert.deepEqual(commands[1]!.input, { KeyId: ARN });
  assert.equal(commands[2]!.input.KeyId, ARN);
  assert.equal(commands[2]!.input.MessageType, 'DIGEST');
  assert.equal(commands[2]!.input.SigningAlgorithm, 'RSASSA_PKCS1_V1_5_SHA_256');
  assert.equal((commands[2]!.input.Message as Uint8Array).length, 32);
  const output = logs.join('');
  assert.equal(output.includes(fixture.pem), false);
  assert.equal(output.includes(claims.usageIdentifierKey), false);
});

test('a key derivation crossing paid expiry cannot produce a service token', async () => {
  let clock = now;
  const keys = createSigningKeys(fakeAws(fixture.pem, {
    publicKeyDer: async () => { clock = now + 1; return spki(fixture.pem); },
  }));
  const signer = createServiceTokenSigner(trust, keys, () => clock);
  await assert.rejects(signer({ ...claims, exp: now + 1, subscription_valid_until: now + 1 }), /invalid_access_token/);
});

test('a hung KMS call aborts after three seconds rather than leaving an invocation open', async () => {
  let aborted = false, reads = 0;
  const keys = createSigningKeys(fakeAws(fixture.pem, {
    signDigest: (_arn, _digest, signal) => { reads++; signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => undefined); },
  }));
  const sign = createServiceTokenSigner(trust, keys, () => now);
  const results = await Promise.allSettled([sign(claims), sign(claims)]);
  assert.equal(reads, 2); assert.equal(aborted, true);
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.message === 'token_signing_failed'), true);
});

test('trusted JWKS unknown-kid refresh is bounded and repeated attacker kids cannot trigger unbounded fetches', async () => {
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

test('trusted JWKS HTTP reader cancels oversized responses without buffering the whole body', async () => {
  let cancelled = false;
  const transport = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; },
  }));
  const cache = remoteJwks('https://keys.example.invalid/jwks', transport as typeof fetch);
  await assert.rejects(cache.get('fixture_key'), /invalid_trusted_jwks/); assert.equal(cancelled, true);
});
