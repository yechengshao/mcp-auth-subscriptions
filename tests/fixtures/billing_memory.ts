/* Shared billing fakes for access/billing integration and billing delivery evidence.
 * Billing state is one in-memory repository with DynamoDB-equivalent revision guards; Stripe is a fake payment
 * provider; the queue records sends with their delays. Nothing here contacts AWS or Stripe. */
import { createHash } from 'node:crypto';
import type { BillingPayments, BillingQueuePort, BillingRepository, DueCursor, Key, Row, Write } from '../../billing/ports.js';
import { BillingConflict } from '../../billing/ports.js';
import { identityPartition } from '../../billing/contracts/validate.js';
import type { HandlerConfig } from '../../billing/handler.js';
import type { RuntimeBudgets } from '../../billing/service.js';
import { environment, now } from './contracts.js';

export const stripeAccount = 'acct_fixture';
export const webhookSecret = 'whsec_fixture_integration';
const offer = { planId: 'basic', durationOptionId: 'short', catalogVersion: 'fixture_v1' };
const verifier = 'integration_pkce_verifier_0123456789abcdefghijklmnop';
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
export const keyOf = (key: { PK: string; SK: string }) => `${key.PK}\0${key.SK}`;
const txId = 'tx_integration_fixture';
const ssmVersion = 1;

export function conflict() { return new BillingConflict(); }

export class MemoryBillingRepository implements BillingRepository {
  readonly rows = new Map<string, Row>();
  constructor(readonly environment: string) {}
  key(who: { issuer: string; subject: string }, SK: string): Key {
    return { PK: identityPartition(this.environment, who.issuer, who.subject), SK };
  }
  async get(key: Key): Promise<Row | undefined> {
    const row = this.rows.get(keyOf(key));
    return row && structuredClone(row);
  }
  async commit(writes: Write[], _token?: string, guards: Array<{ key: Key; revision?: number }> = []): Promise<void> {
    for (const guard of guards) {
      const current = this.rows.get(keyOf(guard.key));
      if (guard.revision === undefined ? current !== undefined : current?.revision !== guard.revision) throw conflict();
    }
    for (const { row, expectedRevision } of writes) {
      const current = this.rows.get(keyOf(row as Key));
      if (expectedRevision === undefined) {
        if (current !== undefined) throw conflict();
        if (row.revision !== 1 && row.entity_type !== 'decision_history') throw new Error('invalid_initial_revision');
      } else {
        if (current?.revision !== expectedRevision) throw conflict();
        if (row.revision !== expectedRevision + 1) throw new Error('invalid_revision');
      }
    }
    for (const { row } of writes) this.rows.set(keyOf(row as Key), structuredClone(row));
  }
  async due(_shard: number, nowSeconds: number, limit: number, _start?: DueCursor) {
    const keys = [...this.rows.values()]
      .filter(row => row.due_partition !== undefined && row.due_sort <= `${nowSeconds.toString().padStart(12, '0')}#￿`)
      .slice(0, limit).map(row => ({ PK: row.PK as string, SK: row.SK as string }));
    return { keys, next: undefined };
  }
}

export class FakeStripe implements BillingPayments {
  readonly sessions = new Map<string, { id: string; url: string; status: 'open' | 'complete'; paid: boolean }>();
  creates = 0;
  async create(): Promise<Row> {
    this.creates++;
    const id = `cs_fixture_${this.creates}`;
    const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open' as const, paid: false };
    this.sessions.set(id, session);
    return { ...session };
  }
  async session(id: string): Promise<Row> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('unknown_session');
    return { ...session };
  }
  async creditable(): Promise<boolean> { return false; }
  async verifyPaid(session: Row) {
    if (!session.paid) return undefined;
    return { paymentId: 'pi_fixture_1', customerId: 'cus_fixture_1', paidAt: now - 60 };
  }
  markPaid(id: string) {
    const session = this.sessions.get(id)!;
    session.paid = true; session.status = 'complete';
  }
}

export class FakeQueue implements BillingQueuePort {
  readonly messages: unknown[] = [];
  readonly delays: number[] = [];
  async send(message: unknown, delay = 0) { this.messages.push(message); this.delays.push(delay); return {}; }
}

export const budgets: RuntimeBudgets = {
  initial_delay_seconds: 60, recovery_horizon_seconds: 3600, processing_lease_seconds: 30, processing_budget_ms: 5000,
  reconciliation_max_attempts: 5, dispatch_max_attempts: 5, dispatch_backoff_seconds: 30, delivery_replay_grace_seconds: 60,
  visibility_timeout_seconds: 30, page_size: 10, max_pages: 2, quote_lifetime_seconds: 600, catalog_cache_seconds: 300,
  catalog_fetch_timeout_ms: 1000,
};

export const handlerConfig = {
  environment, scope: { environment, aws_account_id: '000000000000', region: 'us-east-1', stripe_account: stripeAccount },
  stateTable: 'fixture-state', entitlementTable: 'fixture-entitlements', restApiParameter: '/mcp/test/access-api/rest-api-id', stageParameter: '/mcp/test/access-api/stage',
  stripeKeyParameter: 'fixture-stripe-key', webhookSecretParameter: 'fixture-webhook-secret',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/fixture-queue', queueArn: 'arn:aws:sqs:us-east-1:000000000000:fixture-queue',
  replayRuleArn: 'arn:aws:events:us-east-1:000000000000:rule/fixture-replay', successUrl: 'https://access.example.invalid/success',
  cancelUrl: 'https://access.example.invalid/cancel', supportEmail: 'support@example.invalid', live: false, budgets,
} as HandlerConfig;

