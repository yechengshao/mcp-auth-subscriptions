import { randomUUID } from 'node:crypto';
import { validateEntitlement } from '../contracts/entitlement.js';
import { identifierPattern } from '../contracts/patterns.js';
import type { Telemetry } from '../observability/telemetry.js';
import type { BillingCall, BillingPort, BillingResult } from './ports.js';
import type { AccessRow, StateKey } from './model.js';
import type { BrowserContext } from './sessions.js';
import type { UsageBindingProvisioner } from './usage_bindings.js';

export interface ManagementStore {
  readonly environment: string;
  get(key: StateKey): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>): Promise<void>;
}
export class ManagementFailure extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 500 | 503, readonly code: string, readonly retryable = false) { super(code); }
}
export type ManagementAction =
  | { action: 'quote_upgrade'; plan_id: string; duration_option_id: string; catalog_version: string }
  | { action: 'confirm_upgrade'; quote_id: string }
  | { action: 'downgrade' | 'cancel' | 'refund' };
export type ManagementResult =
  | { kind: 'quote'; quote: Record<string, unknown> }
  | { kind: 'redirect'; order_id: string; url: string }
  | { kind: 'pending'; order_id: string; retry_after_seconds: number }
  | { kind: 'support'; email: string; code: string };
export interface ManagementStatus {
  state: 'activation_ready' | 'payment_pending' | 'payment_failed';
  plan_id?: string;
  valid_until?: number;
  retry_after_seconds?: number;
}

/** Paid browser management; native billing remains the authority for pricing and mutations. */
export class Management {
  constructor(private readonly store: ManagementStore, private readonly billing: BillingPort,
    private readonly provisioning: UsageBindingProvisioner, private readonly telemetry: Telemetry,
    private readonly now = () => Math.floor(Date.now() / 1000)) {}

  async plans(context: BrowserContext) {
    const current = await this.current(context);
    const result = await this.call({ operation: 'listPlans', identity: current.identity,
      idempotencyKey: context.session.tx_id as string, continuationRef: context.session.tx_id as string, input: {} });
    if (result.outcome !== 'ok') throw this.billingFailure(result);
    return result.payload as { catalog_version: string; plans: Array<Record<string, unknown>> };
  }

  async details(context: BrowserContext) {
    const current = await this.current(context);
    return { plan_id: current.entitlement.plan_id, valid_until: current.entitlement.valid_until,
      subscription_id: current.entitlement.subscription_id };
  }

  async manage(context: BrowserContext, subscriptionId: string, action: ManagementAction): Promise<ManagementResult> {
    const current = await this.current(context);
    if (!identifierPattern.test(subscriptionId) || subscriptionId !== current.entitlement.subscription_id) {
      throw new ManagementFailure(404, 'subscription_not_found');
    }
    const txId = context.session.tx_id as string;
    if (action.action === 'quote_upgrade') {
      if (![action.plan_id, action.duration_option_id, action.catalog_version].every(value => identifierPattern.test(value))) {
        throw new ManagementFailure(400, 'invalid_request');
      }
      const result = await this.call({ operation: 'quoteUpgrade', identity: current.identity,
        idempotencyKey: txId, continuationRef: txId, input: {
          subscription_id: subscriptionId, source_revision: current.entitlement.revision,
          plan_id: action.plan_id, duration_option_id: action.duration_option_id, catalog_version: action.catalog_version,
        } });
      if (result.outcome === 'ok') return { kind: 'quote', quote: result.payload };
      if (result.outcome === 'support_required') return this.support(result);
      throw this.billingFailure(result);
    }
    if (action.action === 'confirm_upgrade') {
      if (!identifierPattern.test(action.quote_id)) throw new ManagementFailure(400, 'invalid_request');
      const result = await this.call({ operation: 'confirmUpgrade', identity: current.identity,
        idempotencyKey: action.quote_id, continuationRef: txId, input: { quote_id: action.quote_id } });
      if (result.outcome === 'support_required') return this.support(result);
      if (result.outcome === 'pending') {
        const orderId = this.orderId(result.payload.order_id);
        await this.saveOrder(current.transaction, orderId);
        return { kind: 'pending', order_id: orderId, retry_after_seconds: 5 };
      }
      if (result.outcome !== 'ok') throw this.billingFailure(result);
      const orderId = this.orderId(result.payload.order_id), url = this.checkoutUrl(result.payload.checkout_url);
      await this.saveOrder(current.transaction, orderId);
      return { kind: 'redirect', order_id: orderId, url };
    }
    const result = await this.call({ operation: 'manageSubscription', identity: current.identity,
      idempotencyKey: txId, continuationRef: txId, input: { subscription_id: subscriptionId, action: action.action } });
    if (result.outcome === 'support_required') return this.support(result);
    throw this.billingFailure(result);
  }

  async portal(context: BrowserContext): Promise<ManagementResult> {
    const current = await this.current(context);
    const txId = context.session.tx_id as string;
    const result = await this.call({ operation: 'openPortal', identity: current.identity,
      idempotencyKey: txId, continuationRef: txId, input: { subscription_id: current.entitlement.subscription_id } });
    if (result.outcome === 'support_required') return this.support(result);
    throw this.billingFailure(result);
  }

  /** Bounded request-driven activation. A closed browser is recovered on the next management login/status request. */
  async status(context: BrowserContext): Promise<ManagementStatus> {
    const current = await this.current(context);
    if (current.transaction.order_id) {
      const result = await this.call({ operation: 'getOrder', identity: current.identity,
        idempotencyKey: context.session.tx_id as string, continuationRef: context.session.tx_id as string,
        input: { order_id: current.transaction.order_id } });
      if (result.outcome === 'pending') return { state: 'payment_pending', retry_after_seconds: 5 };
      if (result.outcome !== 'ok') throw this.billingFailure(result);
      if (result.payload.order_id !== current.transaction.order_id) throw new ManagementFailure(503, 'invalid_billing_response', true);
      if (result.payload.state === 'pending') return { state: 'payment_pending', retry_after_seconds: 5 };
      if (result.payload.state !== 'paid') return { state: 'payment_failed' };
    }
    try {
      await this.provisioning.ensure({ identity: current.identity, subscriberId: current.subscriberId, invocationId: randomUUID() });
      return { state: 'activation_ready', plan_id: current.entitlement.plan_id, valid_until: current.entitlement.valid_until };
    } catch (error) {
      if (error instanceof Error && 'retryable' in error && (error as { retryable?: unknown }).retryable === false) {
        throw new ManagementFailure(500, error.message || 'activation_failed');
      }
      throw new ManagementFailure(503, 'activation_retry', true);
    }
  }

  async orderStatus(context: BrowserContext, orderId: string) {
    const current = await this.current(context);
    if (!identifierPattern.test(orderId) || current.transaction.order_id !== orderId) throw new ManagementFailure(404, 'order_not_found');
    const result = await this.call({ operation: 'getOrder', identity: current.identity,
      idempotencyKey: context.session.tx_id as string, continuationRef: context.session.tx_id as string,
      input: { order_id: orderId } });
    if (result.outcome === 'pending') return { order_id: orderId, state: 'pending' as const, retry_after_seconds: 5 };
    if (result.outcome !== 'ok') throw this.billingFailure(result);
    if (result.payload.order_id !== orderId) throw new ManagementFailure(503, 'invalid_billing_response', true);
    return { order_id: orderId, state: result.payload.state as 'pending' | 'paid' | 'failed' | 'expired' | 'repair_required' };
  }

  private async current(context: BrowserContext) {
    const identity = context.session.identity;
    const txId = context.session.tx_id;
    if (context.session.purpose !== 'management' || context.transaction.purpose !== 'management' ||
        context.session.authentication_stage !== 'identity_verified' || !identity || !txId ||
        context.transaction.identity?.issuer !== identity.issuer || context.transaction.identity?.subject !== identity.subject ||
        context.transaction.subscriber_id !== context.session.subscriber_id || context.transaction.local_destination !== '/billing') {
      throw new ManagementFailure(403, 'invalid_management_session');
    }
    let transaction: AccessRow | undefined, entitlement: AccessRow | undefined;
    try {
      transaction = await this.store.get({ PK: `ENV#${this.store.environment}#TX#${txId}`, SK: 'STATE' });
      entitlement = await this.store.entitlement(identity);
    } catch { throw new ManagementFailure(503, 'management_state_unavailable', true); }
    const now = this.clock();
    if (!transaction || transaction.purpose !== 'management' || transaction.phase !== 'identity_verified' || transaction.identity?.issuer !== identity.issuer ||
        transaction.identity?.subject !== identity.subject || transaction.subscriber_id !== context.session.subscriber_id ||
        transaction.expires_at <= now) throw new ManagementFailure(409, 'management_session_expired');
    if (!entitlement) throw new ManagementFailure(403, 'subscription_required');
    try { validateEntitlement(entitlement, this.store.environment, identity.issuer, identity.subject, now); }
    catch (error) {
      if (error instanceof Error && error.message === 'not_eligible') throw new ManagementFailure(403, 'subscription_required');
      throw new ManagementFailure(503, 'entitlement_unavailable', true);
    }
    if (typeof entitlement.subscription_id !== 'string' || !identifierPattern.test(entitlement.subscription_id)) {
      throw new ManagementFailure(503, 'entitlement_unavailable', true);
    }
    return { identity, subscriberId: context.session.subscriber_id as string, transaction, entitlement };
  }

  private async saveOrder(transaction: AccessRow, orderId: string) {
    const current = await this.store.get({ PK: transaction.PK as string, SK: 'STATE' });
    if (!current || current.purpose !== 'management' || current.revision !== transaction.revision) {
      const latest = current;
      if (latest?.purpose === 'management' && latest.order_id === orderId) return;
      throw new ManagementFailure(409, 'management_session_changed');
    }
    if (current.order_id && current.order_id !== orderId) throw new ManagementFailure(409, 'order_already_attached');
    if (current.order_id === orderId) return;
    try {
      await this.store.commit([{ row: { ...current, order_id: orderId, revision: current.revision + 1 }, expectedRevision: current.revision }]);
    } catch (error) {
      if (error instanceof Error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)) {
        const latest = await this.store.get({ PK: current.PK as string, SK: 'STATE' });
        if (latest?.purpose === 'management' && latest.order_id === orderId) return;
        throw new ManagementFailure(409, 'management_session_changed');
      }
      throw new ManagementFailure(503, 'management_state_unavailable', true);
    }
  }
  private async call(call: BillingCall): Promise<BillingResult> {
    try { return await this.billing.invoke(call); }
    catch (error) {
      this.telemetry.markServerError('http.billing', 503, error);
      throw new ManagementFailure(503, 'billing_unavailable', true);
    }
  }
  private support(result: BillingResult): ManagementResult {
    const email = result.payload.support_email;
    if (typeof email !== 'string') throw new ManagementFailure(503, 'invalid_billing_response', true);
    return { kind: 'support', email, code: result.error_code ?? 'financial_support_required' };
  }
  private billingFailure(result: BillingResult): ManagementFailure {
    if (result.outcome === 'denied') return new ManagementFailure(403, 'subscription_required');
    if (result.outcome === 'invalid_request') return new ManagementFailure(400, 'billing_request_rejected');
    if (result.outcome === 'conflict') return new ManagementFailure(409, 'subscription_changed');
    if (result.outcome === 'support_required') return new ManagementFailure(409, 'support_required');
    return new ManagementFailure(503, 'billing_unavailable', true);
  }
  private orderId(value: unknown): string {
    if (typeof value !== 'string' || !identifierPattern.test(value)) throw new ManagementFailure(503, 'invalid_billing_response', true);
    return value;
  }
  private checkoutUrl(value: unknown): string {
    if (typeof value !== 'string') throw new ManagementFailure(503, 'invalid_billing_response', true);
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ManagementFailure(503, 'invalid_billing_response', true); }
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || !url.pathname.startsWith('/c/pay/')) {
      throw new ManagementFailure(503, 'invalid_billing_response', true);
    }
    return url.toString();
  }
  private clock() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new ManagementFailure(503, 'clock_unavailable', true);
    return value;
  }
}
