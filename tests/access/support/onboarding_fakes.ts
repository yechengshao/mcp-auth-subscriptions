/** Shared onboarding fakes for the onboarding and journey test suites. */
import type { AccessRow, StateKey } from '../../../access/model.js';
import { Onboarding, OnboardingFailure, type OnboardingStore } from '../../../access/onboarding.js';
import { BillingAliasInvoker, type BillingCall, type BillingResult } from '../../../access/adapters/billing.js';
import type { UsageBindingProvisioner } from '../../../access/usage_bindings.js';
import type { BrowserContext } from '../../../access/sessions.js';
import { credentialDigest, transactionKey, subscriberBindingKey } from '../../../access/grants.js';
import { validateAccessRecord } from '../../../access/contracts/storage.js';
import { identityPartition } from '../../../contracts/identity.js';
import { Telemetry } from '../../../observability/telemetry.js';
import { accessRecords } from '../../fixtures/storage.js';
import { entitlement, environment, identity, now, usage_mapping } from '../../fixtures/contracts.js';


export const keyOf = (key: StateKey) => `${key.PK}\0${key.SK}`;
export const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'onboarding_fixture' }, { sink: () => undefined });

export class MemoryOnboardingStore implements OnboardingStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  paid: AccessRow | undefined;

  async get(key: StateKey) { const row = this.rows.get(keyOf(key)); return row && structuredClone(row); }
  async entitlement(owner: { issuer: string; subject: string }) {
    if (this.paid?.identity_issuer !== owner.issuer || this.paid?.identity_subject !== owner.subject) return undefined;
    return structuredClone(this.paid);
  }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }> = []) {
    for (const check of checks) {
      const value = check.projection ? this.paid : this.rows.get(keyOf(check.key));
      if (check.expectedRevision === undefined ? value !== undefined : value?.revision !== check.expectedRevision) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
    }
    for (const { row, expectedRevision } of writes) {
      const current = this.rows.get(keyOf(row as StateKey));
      if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
      validateAccessRecord(row, this.environment);
    }
    for (const { row } of writes) this.rows.set(keyOf(row as StateKey), structuredClone(row));
  }
}

export class BillingFake {
  readonly calls: BillingCall[] = [];
  readonly replies: BillingResult[] = [];
  async invoke(call: BillingCall): Promise<BillingResult> {
    this.calls.push(structuredClone(call));
    const reply = this.replies.shift();
    if (!reply) throw new Error('unexpected_billing_call');
    return reply;
  }
}

export const result = (outcome: BillingResult['outcome'], payload: Record<string, unknown>, correlation = 'onboarding_corr_fixture'): BillingResult => ({
  schema_version: 1, correlation_id: correlation, outcome, retryable: outcome === 'pending' || outcome === 'retryable_unavailable',
  message: 'fixture', payload,
});

export function transaction(phase: string = 'identity_verified'): AccessRow {
  const txId = 'tx_onboarding_fixture';
  return { PK: `ENV#test#TX#${txId}`, SK: 'STATE', entity_type: 'transaction', revision: 1,
    environment, purpose: 'onboarding', phase, grant_id: 'grant_onboarding_fixture',
    identity, subscriber_id: 'subscriber_fixture', correlation_id: 'onboarding_corr_fixture',
    downstream: { client_id: 'chatgpt_fixture', redirect_uri: 'https://chatgpt.example.invalid/callback',
      resource: 'https://api.example.invalid/test/mcp', scopes: ['openid', 'mcp:invoke'],
      code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 'state_from_client_fixture',
      issuer: 'https://access.example.invalid', client_config_version: 'clients_fixture_v1' },
    created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400 };
}
export function context(tx = transaction()): BrowserContext {
  return { sessionDigest: 'a'.repeat(64), csrf: 'csrf_fixture', session: {
    PK: `ENV#test#SESSION#${'a'.repeat(64)}`, SK: 'SESSION', entity_type: 'session', revision: 1,
    environment, purpose: 'onboarding', tx_id: tx.tx_id ?? tx.PK.split('#').at(-1), grant_id: tx.grant_id,
    authentication_stage: 'identity_verified', identity, subscriber_id: 'subscriber_fixture',
    csrf_digest: 'b'.repeat(64), created_at: now, expires_at: now + 1800, delete_after: now + 1800 + 86400,
  }, transaction: tx };
}
export function seedTransaction(store: MemoryOnboardingStore, tx: AccessRow) {
  store.rows.set(keyOf({ PK: tx.PK as string, SK: tx.SK as string }), structuredClone(tx));
}
export function service(store: MemoryOnboardingStore, billing: BillingFake, provisioning?: Partial<UsageBindingProvisioner>) {
  const bindingProvisioner = { async ensure() {
    if (provisioning?.ensure) return provisioning.ensure({ identity, subscriberId: 'subscriber_fixture', invocationId: 'test_invocation' });
    return { state: 'configured', subscriberId: 'subscriber_fixture', entitlementRevision: store.paid?.revision ?? 1,
      apiKeyId: 'key_fixture', apiKeyValue: 'K'.repeat(40), usageMapping: usage_mapping };
  } } as unknown as UsageBindingProvisioner;
  return new Onboarding(store, billing as unknown as BillingAliasInvoker, bindingProvisioner, telemetry, () => now);
}

