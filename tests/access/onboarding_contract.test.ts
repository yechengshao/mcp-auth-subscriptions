import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessStore } from '../../access/store.js';
import { Telemetry } from '../../observability/telemetry.js';
import { environment, now } from '../fixtures/contracts.js';

const telemetry = new Telemetry({ service: 'access', environment, release: 'onboarding_contract_fixture' }, { sink: () => undefined });

test('Cognito cancellation atomically revokes the browser session, consumes PKCE state and persists a valid cancelled phase', async () => {
  const commands: any[] = [];
  const store = new AccessStore(environment, 'access_state', 'billing_entitlements', telemetry,
    { send: async (command: any) => { commands.push(command.input); return {}; } } as any);
  const txId = 'tx_cancel_contract';
  const sessionDigest = 'a'.repeat(64);
  const transaction = {
    PK: `ENV#${environment}#TX#${txId}`, SK: 'STATE', entity_type: 'transaction', schema_version: 1,
    revision: 1, environment, purpose: 'onboarding', phase: 'pending_identity', grant_id: 'grant_cancel_contract',
    downstream: { client_id: 'client_fixture', redirect_uri: 'https://client.example.invalid/callback',
      resource: 'https://access.example.invalid/mcp', scopes: ['mcp:invoke'], code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256', state: 'original_state', issuer: 'https://access.example.invalid',
      client_config_version: 'clients_fixture_v1' },
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  };
  const session = {
    PK: `ENV#${environment}#SESSION#${sessionDigest}`, SK: 'SESSION', entity_type: 'session', schema_version: 1,
    revision: 1, environment, purpose: 'onboarding', tx_id: txId, authentication_stage: 'pending_identity',
    csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  };
  const attempt = {
    PK: `ENV#${environment}#UPSTREAM#${'c'.repeat(64)}`, SK: 'ATTEMPT', entity_type: 'upstream_attempt',
    schema_version: 1, revision: 1, environment, tx_id: txId, session_digest: sessionDigest,
    nonce_digest: 'd'.repeat(64), pkce_verifier: 'E'.repeat(43), cognito_client_id: 'cognito_fixture',
    cognito_issuer: 'https://cognito.example.invalid/pool', callback_uri: 'https://access.example.invalid/oauth/cognito/callback',
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400, consumed: false,
  };

  await store.cancelLogin({ attempt, session, transaction });
  assert.equal(commands.length, 1);
  const writes = commands[0].TransactItems;
  assert.equal(writes.length, 3);
  assert.ok(writes.every((item: any) => item.Put.TableName === 'access_state'));
  const savedAttempt = writes[0].Put.Item;
  const savedSession = writes[1].Put.Item;
  const savedTransaction = writes[2].Put.Item;
  assert.equal(savedAttempt.consumed, true);
  assert.equal(savedAttempt.pkce_verifier, undefined);
  assert.equal(savedSession.revoked, true);
  assert.equal(savedTransaction.phase, 'cancelled');
  assert.equal(savedTransaction.revision, 2);
});
