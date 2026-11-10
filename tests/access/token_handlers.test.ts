import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { createTokenHandlers } from '../../access/http/token-handlers.js';
import { OAuthTokenFailure, type AccessTokens } from '../../access/tokens.js';
import { Telemetry } from '../../observability/telemetry.js';

function fixture() {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const service = {
    async exchangeCode(input: Record<string, unknown>) {
      calls.push({ operation: 'exchangeCode', input });
      return { access_token: 'access_fixture', token_type: 'Bearer' as const, expires_in: 3600,
        refresh_token: 'refresh_fixture', scope: 'mcp:invoke' };
    },
    async refresh(input: Record<string, unknown>) {
      calls.push({ operation: 'refresh', input });
      return { access_token: 'access_rotated_fixture', token_type: 'Bearer' as const, expires_in: 3600,
        refresh_token: 'refresh_rotated_fixture', scope: 'mcp:invoke' };
    },
    async revoke(input: Record<string, unknown>) { calls.push({ operation: 'revoke', input }); },
  } as unknown as AccessTokens;
  const logs: string[] = [];
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'token_http_fixture' }, { sink: line => logs.push(line) });
  const handlers = createTokenHandlers(service, telemetry);
  return { ...handlers, calls, logs };
}

async function invoke(handler: (request: Request, response: Response, next: (error?: unknown) => void) => unknown,
  body: unknown) {
  const result: { status: number; headers: Record<string, string>; body?: unknown; ended?: boolean } = { status: 0, headers: {} };
  const response = {
    status(value: number) { result.status = value; return this; },
    set(name: string, value: string) { result.headers[name.toLowerCase()] = value; return this; },
    json(value: unknown) { result.body = value; return this; },
    end() { result.ended = true; return this; },
  } as unknown as Response;
  await handler({ body } as Request, response, error => { if (error) throw error; });
  return result;
}

test('OAuth token adapter strictly dispatches form grants and keeps credential work in the application service', async () => {
  const value = fixture();
  const code = await invoke(value.token, { grant_type: 'authorization_code', client_id: 'host_fixture', code: 'c'.repeat(43),
    redirect_uri: 'https://client.example.invalid/callback', code_verifier: 'v'.repeat(43), resource: 'https://api.example.invalid/mcp' });
  assert.equal(code.status, 200);
  assert.deepEqual(code.body, { access_token: 'access_fixture', token_type: 'Bearer', expires_in: 3600,
    refresh_token: 'refresh_fixture', scope: 'mcp:invoke' });
  assert.deepEqual(value.calls[0], { operation: 'exchangeCode', input: { code: 'c'.repeat(43), clientId: 'host_fixture',
    redirectUri: 'https://client.example.invalid/callback', codeVerifier: 'v'.repeat(43), resource: 'https://api.example.invalid/mcp' } });
  const refreshed = await invoke(value.token, { grant_type: 'refresh_token', client_id: 'host_fixture',
    refresh_token: 'r'.repeat(43), scope: 'mcp:invoke' });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(value.calls[1], { operation: 'refresh', input: { refreshToken: 'r'.repeat(43), clientId: 'host_fixture', scope: 'mcp:invoke' } });
  const revoked = await invoke(value.revoke, { client_id: 'host_fixture', token: 'opaque_fixture', token_type_hint: 'refresh_token' });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.ended, true);
  assert.deepEqual(value.calls[2], { operation: 'revoke', input: { token: 'opaque_fixture', clientId: 'host_fixture', tokenTypeHint: 'refresh_token' } });
});

test('OAuth token adapter rejects unknown fields and grant types without exposing internal failures', async () => {
  const value = fixture();
  const extra = await invoke(value.token, { grant_type: 'refresh_token', client_id: 'host_fixture', refresh_token: 'r'.repeat(43), secret: 'not-allowed' });
  assert.equal(extra.status, 400);
  assert.deepEqual(extra.body, { error: 'invalid_request' });
  const unsupported = await invoke(value.token, { grant_type: 'client_credentials', client_id: 'host_fixture' });
  assert.equal(unsupported.status, 400);
  assert.deepEqual(unsupported.body, { error: 'unsupported_grant_type' });
  assert.equal(value.calls.length, 0);
  const failing = { async revoke() { throw new OAuthTokenFailure(503, 'temporarily_unavailable'); } } as unknown as AccessTokens;
  const handlers = createTokenHandlers(failing, new Telemetry({ service: 'access', environment: 'test', release: 'failure_fixture' }, { sink: () => undefined }));
  const temporary = await invoke(handlers.revoke, { client_id: 'host_fixture', token: 'token_fixture' });
  assert.equal(temporary.status, 503);
  assert.equal(temporary.headers['retry-after'], '5');
  assert.deepEqual(temporary.body, { error: 'temporarily_unavailable' });
});
