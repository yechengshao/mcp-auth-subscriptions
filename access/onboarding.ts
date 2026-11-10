import { randomUUID } from 'node:crypto';
import { validateEntitlement } from '../contracts/entitlement.js';
import { identityPartition } from '../contracts/identity.js';
import { identifierPattern } from '../contracts/patterns.js';
import type { Telemetry } from '../observability/telemetry.js';
import type { BillingCall, BillingPort, BillingResult } from './ports.js';
import { validateAccessRecord } from './contracts/storage.js';
import type { BrowserContext } from './sessions.js';
import type { AccessRow, StateKey } from './model.js';
import { authCodeKey, subscriberBindingKey, transactionKey, newOpaqueCredential } from './grants.js';
import { transitionTransaction } from './transitions.js';
import { ProvisioningFailure, type UsageBindingProvisioner } from './usage_bindings.js';

export interface OnboardingStore {
  readonly environment: string;
  get(key: StateKey): Promise<AccessRow | undefined>;
  entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined>;
  commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks?: Array<{
    key: StateKey; expectedRevision?: number; projection?: boolean;
  }>): Promise<void>;
}
export class OnboardingFailure extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 500 | 503, readonly code: string, readonly retryable = false) { super(code); }
}
export interface AvailablePlans { catalog_version: string; plans: Array<Record<string, unknown>> }
export type PlanPage = { kind: 'eligible' } | { kind: 'payment_pending' } | { kind: 'plans'; offers: AvailablePlans };
export type CheckoutResult = { kind: 'redirect'; url: string } | { kind: 'pending'; message: string };
export interface OnboardingStatus { state: 'plan_selection' | 'checkout_pending' | 'checkout_ready' | 'payment_pending' | 'payment_failed' | 'activation_ready' | 'completed'; retry_after_seconds?: number; checkout_url?: string }
export interface BillingOrderStatus { order_id: string; state: 'pending' | 'paid' | 'failed' | 'expired' | 'repair_required'; retry_after_seconds?: number }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Browser continuation and one-use callback issuance. No request can manufacture identity or price authority. */
export class Onboarding {
  constructor(private readonly store: OnboardingStore, private readonly billing: BillingPort,
    private readonly provisioning: UsageBindingProvisioner, private readonly telemetry: Telemetry,
    private readonly now = () => Math.floor(Date.now() / 1000)) {}

  async page(context: BrowserContext): Promise<PlanPage> {
    this.assertOnboarding(context);
    if (this.active(await this.entitlement(context), context.session.identity!, this.clock())) return { kind: 'eligible' };
    if (context.transaction.order_id || context.transaction.phase === 'checkout_pending' || context.transaction.phase === 'payment_pending' || context.transaction.phase === 'failed') {
      return { kind: 'payment_pending' };
    }
    const response = await this.callBilling({ operation: 'listPlans', identity: context.session.identity!,
      idempotencyKey: context.session.tx_id, continuationRef: context.session.tx_id, input: {} });
    if (response.outcome !== 'ok') throw this.billingFailure(response);
    // BillingAliasInvoker validates listPlans against the closed shared result schema.
    const payload = response.payload as unknown as AvailablePlans;
    return { kind: 'plans', offers: payload };
  }

  async checkout(context: BrowserContext, input: { planId: string; durationOptionId: string; catalogVersion: string }): Promise<CheckoutResult> {
    this.assertOnboarding(context);
    const { transaction: initial } = context;
    if (![input.planId, input.durationOptionId, input.catalogVersion].every(value => typeof value === 'string' && identifierPattern.test(value))) {
      throw new OnboardingFailure(400, 'invalid_request');
    }
    const currentEntitlement = await this.entitlement(context);
    if (this.active(currentEntitlement, context.session.identity!, this.clock())) throw new OnboardingFailure(409, 'already_eligible');
    if (['code_issued', 'redeemed', 'cancelled', 'failed'].includes(initial.phase)) throw new OnboardingFailure(409, 'continuation_completed');
    const entitlement = currentEntitlement;
    const intent = entitlement && Number.isSafeInteger(entitlement.valid_until) && entitlement.valid_until <= this.clock() ? 'renewal' : 'purchase';
    const selected = { plan_id: input.planId, duration_option_id: input.durationOptionId,
      catalog_version: input.catalogVersion, intent };
    const txId = context.session.tx_id as string;
    let transaction = await this.currentTransaction(txId, initial.grant_id);
    if (transaction.selected_offer !== undefined && !equal(transaction.selected_offer, selected)) {
      throw new OnboardingFailure(409, 'offer_already_selected');
    }
    if (transaction.phase === 'identity_verified') {
      const updated = transitionTransaction(transaction, 'checkout_pending', { selected_offer: selected });
      try {
        await this.store.commit([{ row: updated, expectedRevision: transaction.revision }],
          this.entitlementChecks(context.session.identity!, entitlement));
        transaction = updated;
      } catch (error) {
        if (!this.isConflict(error)) throw new OnboardingFailure(503, 'temporarily_unavailable', true);
        transaction = await this.currentTransaction(txId, initial.grant_id);
        if (!equal(transaction.selected_offer, selected)) throw new OnboardingFailure(409, 'offer_already_selected');
      }
    } else if (!['checkout_pending', 'payment_pending'].includes(transaction.phase) || !equal(transaction.selected_offer, selected)) {
      throw new OnboardingFailure(409, 'continuation_completed');
    }

    const response = await this.callBilling({ operation: 'createCheckout', identity: context.session.identity!,
      idempotencyKey: txId, continuationRef: txId,
      input: { ...selected } });
    if (response.outcome === 'ok') {
      const orderId = response.payload.order_id;
      await this.saveOrder(transaction, orderId as string, txId);
      return { kind: 'redirect', url: response.payload.checkout_url as string };
    }
    if (response.outcome === 'pending') {
      await this.saveOrder(transaction, response.payload.order_id as string, txId);
      return { kind: 'pending', message: 'Payment is still processing. Check status shortly.' };
    }
    throw this.billingFailure(response);
  }

  async status(context: BrowserContext): Promise<OnboardingStatus> {
    this.assertOnboarding(context);
    const now = this.clock();
    const txId = context.session.tx_id as string;
    const transaction = await this.currentTransaction(txId, context.transaction.grant_id);
    if (transaction.phase === 'code_issued' || transaction.phase === 'redeemed') return { state: 'completed' };
    if (transaction.phase === 'failed') return { state: 'payment_failed' };
    if (transaction.phase === 'cancelled') throw new OnboardingFailure(409, 'continuation_completed');
    const entitlement = await this.entitlement(context);
    if (this.active(entitlement, context.session.identity!, now)) {
      try {
        await this.provisioning.ensure({ identity: context.session.identity!, subscriberId: context.session.subscriber_id!, invocationId: randomUUID() });
        return { state: 'activation_ready' };
      } catch (error) { throw this.provisioningFailure(error); }
    }
    if (!transaction.order_id) {
      if (transaction.phase !== 'checkout_pending' || !transaction.selected_offer) return { state: 'plan_selection' };
      const selected = transaction.selected_offer as { plan_id: string; duration_option_id: string; catalog_version: string; intent: 'purchase' | 'renewal' };
      const created = await this.callBilling({ operation: 'createCheckout', identity: context.session.identity!,
        idempotencyKey: txId, continuationRef: txId, input: selected });
      if (created.outcome === 'ok') {
        await this.saveOrder(transaction, created.payload.order_id as string, txId);
        return { state: 'checkout_ready', checkout_url: created.payload.checkout_url as string };
      }
      if (created.outcome === 'pending') {
        await this.saveOrder(transaction, created.payload.order_id as string, txId);
        return { state: 'payment_pending', retry_after_seconds: 5 };
      }
      throw this.billingFailure(created);
    }
    const result = await this.callBilling({ operation: 'getOrder', identity: context.session.identity!,
      idempotencyKey: txId, continuationRef: txId, input: { order_id: transaction.order_id } });
    if (result.outcome === 'pending') return { state: 'payment_pending', retry_after_seconds: 5 };
    if (result.outcome !== 'ok') throw this.billingFailure(result);
    const state = result.payload.state;
    if (state === 'paid') return { state: 'payment_pending', retry_after_seconds: 5 };
    if (state === 'pending') return { state: 'payment_pending', retry_after_seconds: 5 };
    if (state === 'repair_required') return { state: 'payment_failed' };
    return { state: 'payment_failed' };
  }

  /** Read-only status for the order already bound to this verified continuation. */
  async orderStatus(context: BrowserContext, orderId: string): Promise<BillingOrderStatus> {
    this.assertOnboarding(context);
    if (typeof orderId !== 'string' || !identifierPattern.test(orderId)) throw new OnboardingFailure(400, 'invalid_request');
    const txId = context.session.tx_id as string;
    const transaction = await this.currentTransaction(txId, context.transaction.grant_id);
    if (transaction.order_id !== orderId) throw new OnboardingFailure(404, 'order_not_found');
    const result = await this.callBilling({ operation: 'getOrder', identity: context.session.identity!,
      idempotencyKey: txId, continuationRef: txId, input: { order_id: orderId } });
    if (result.outcome === 'pending') {
      if (result.payload.order_id !== orderId) throw new OnboardingFailure(503, 'invalid_billing_response', true);
      return { order_id: orderId, state: 'pending', retry_after_seconds: 5 };
    }
    if (result.outcome !== 'ok') throw this.billingFailure(result);
    if (result.payload.order_id !== orderId ||
        !['pending', 'paid', 'failed', 'expired', 'repair_required'].includes(String(result.payload.state))) {
      throw new OnboardingFailure(503, 'invalid_billing_response', true);
    }
    return { order_id: orderId, state: result.payload.state as BillingOrderStatus['state'] };
  }

  async resume(context: BrowserContext): Promise<{ location: string }> {
    this.assertOnboarding(context);
    const now = this.clock(), identity = context.session.identity!, subscriberId = context.session.subscriber_id!;
    const txId = context.session.tx_id as string;
    let transaction = await this.currentTransaction(txId, context.transaction.grant_id);
    if (transaction.phase === 'code_issued' || transaction.phase === 'redeemed') throw new OnboardingFailure(409, 'continuation_completed');
    if (transaction.phase === 'failed' || transaction.phase === 'cancelled') throw new OnboardingFailure(409, 'continuation_completed');
    const entitlement = await this.entitlement(context);
    if (!this.active(entitlement, identity, now)) throw new OnboardingFailure(409, 'subscription_required');
    try { await this.provisioning.ensure({ identity, subscriberId, invocationId: randomUUID() }); }
    catch (error) { throw this.provisioningFailure(error); }
    const mapping = entitlement!.usage_mapping as { rest_api_id: string; stage: string };
    const bindingKey = subscriberBindingKey(this.store.environment, subscriberId, mapping.rest_api_id, mapping.stage);
    const binding = await this.read(bindingKey);
    if (!binding || binding.state !== 'configured' || binding.entitlement_revision !== entitlement!.revision) {
      throw new OnboardingFailure(503, 'activation_retry', true);
    }
    if (transaction.phase !== 'code_ready') {
      const ready = transitionTransaction(transaction, 'code_ready');
      try {
        await this.store.commit([{ row: ready, expectedRevision: transaction.revision }],
          this.authorityChecks(identity, entitlement!, binding));
        transaction = ready;
      } catch (error) {
        if (!this.isConflict(error)) throw new OnboardingFailure(503, 'temporarily_unavailable', true);
        transaction = await this.currentTransaction(txId, transaction.grant_id);
        if (transaction.phase === 'code_issued' || transaction.phase === 'redeemed') throw new OnboardingFailure(409, 'continuation_completed');
        if (transaction.phase !== 'code_ready') throw new OnboardingFailure(409, 'continuation_changed');
      }
    }
    const downstream = transaction.downstream as Record<string, unknown> | undefined;
    if (!downstream || typeof downstream.redirect_uri !== 'string' || typeof downstream.state !== 'string' ||
        typeof downstream.client_id !== 'string' || typeof downstream.resource !== 'string' ||
        typeof downstream.code_challenge !== 'string' || downstream.code_challenge_method !== 'S256' ||
        !Array.isArray(downstream.scopes)) throw new OnboardingFailure(500, 'invalid_continuation');
    const code = newOpaqueCredential(), codeKey = authCodeKey(this.store.environment, code);
    const callback = new URL(downstream.redirect_uri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', downstream.state as string);
    callback.searchParams.set('iss', this.configIssuer(transaction));
    if (callback.toString().length > 4096) throw new OnboardingFailure(500, 'callback_too_large');
    const expires = Math.min(now + 60, transaction.expires_at);
    if (expires <= now) throw new OnboardingFailure(409, 'continuation_expired');
    const codeRow: AccessRow = {
      ...codeKey, schema_version: 1, entity_type: 'authorization_code', revision: 1, environment: this.store.environment,
      tx_id: txId, subscriber_id: subscriberId, client_id: downstream.client_id,
      resource: downstream.resource, redirect_uri: downstream.redirect_uri, scopes: downstream.scopes,
      code_challenge: downstream.code_challenge, code_challenge_method: 'S256', grant_id: transaction.grant_id,
      issued_at: now, transaction_expires_at: transaction.expires_at, expires_at: expires,
      delete_after: transaction.expires_at + 86400, consumed: false,
    };
    const issued = transitionTransaction(transaction, 'code_issued');
    try {
      validateAccessRecord(codeRow, this.store.environment);
      await this.store.commit([{ row: codeRow }, { row: issued, expectedRevision: transaction.revision }],
        this.authorityChecks(identity, entitlement!, binding));
    } catch (error) {
      if (this.isConflict(error)) {
        const latest = await this.currentTransaction(txId, transaction.grant_id);
        if (latest.phase === 'code_issued' || latest.phase === 'redeemed') throw new OnboardingFailure(409, 'continuation_completed');
        throw new OnboardingFailure(409, 'continuation_changed');
      }
      if (error instanceof OnboardingFailure) throw error;
      throw new OnboardingFailure(503, 'temporarily_unavailable', true);
    }
    this.telemetry.log('transition', 'http.resume', 'completed');
    return { location: callback.toString() };
  }

  private configIssuer(transaction: AccessRow): string {
    const issuer = (transaction.downstream as Record<string, unknown> | undefined)?.issuer;
    if (typeof issuer !== 'string' || !issuer.startsWith('https://')) throw new OnboardingFailure(500, 'invalid_continuation');
    return issuer;
  }
  private assertOnboarding(context: BrowserContext) {
    const identity = context.session.identity, transactionIdentity = context.transaction.identity;
    if (context.session.purpose !== 'onboarding' || context.transaction.purpose !== 'onboarding' ||
        context.transaction.grant_id !== context.session.grant_id ||
        context.session.authentication_stage !== 'identity_verified' ||
        typeof identity?.issuer !== 'string' || typeof identity.subject !== 'string' ||
        transactionIdentity?.issuer !== identity.issuer || transactionIdentity?.subject !== identity.subject ||
        context.transaction.subscriber_id !== context.session.subscriber_id ||
        typeof context.session.subscriber_id !== 'string' || typeof context.transaction.grant_id !== 'string') {
      throw new OnboardingFailure(403, 'invalid_continuation');
    }
  }
  private async currentTransaction(txId: string, grantId: string): Promise<AccessRow> {
    const transaction = await this.read(transactionKey(this.store.environment, txId));
    if (!transaction || transaction.purpose !== 'onboarding' || transaction.grant_id !== grantId || transaction.expires_at <= this.clock()) {
      throw new OnboardingFailure(409, 'continuation_expired');
    }
    return transaction;
  }
  private async entitlement(context: BrowserContext): Promise<AccessRow | undefined> {
    try { return await this.store.entitlement(context.session.identity!); }
    catch { throw new OnboardingFailure(503, 'entitlement_unavailable', true); }
  }
  private active(entitlement: AccessRow | undefined, identity: { issuer: string; subject: string }, now: number): boolean {
    if (!entitlement) return false;
    try { validateEntitlement(entitlement, this.store.environment, identity.issuer, identity.subject, now); return true; }
    catch (error) {
      if (error instanceof Error && error.message === 'not_eligible') return false;
      throw new OnboardingFailure(503, 'entitlement_unavailable', true);
    }
  }
  private async saveOrder(transaction: AccessRow, orderId: string, txId: string): Promise<void> {
    if (typeof orderId !== 'string' || !identifierPattern.test(orderId)) throw new OnboardingFailure(503, 'invalid_billing_response', true);
    if (transaction.phase === 'payment_pending') {
      if (transaction.order_id !== orderId) throw new OnboardingFailure(409, 'order_mismatch');
      return;
    }
    const updated = transitionTransaction(transaction, 'payment_pending', { order_id: orderId });
    try { await this.store.commit([{ row: updated, expectedRevision: transaction.revision }]); }
    catch (error) {
      if (this.isConflict(error)) {
        const latest = await this.currentTransaction(txId, transaction.grant_id);
        if (latest.order_id === orderId && latest.phase === 'payment_pending') return;
        throw new OnboardingFailure(409, 'continuation_changed');
      }
      throw new OnboardingFailure(503, 'temporarily_unavailable', true);
    }
  }
  private async callBilling(call: BillingCall): Promise<BillingResult> {
    try { return await this.billing.invoke(call); }
    catch {
      throw new OnboardingFailure(503, 'billing_unavailable', true);
    }
  }
  private billingFailure(result: BillingResult): OnboardingFailure {
    if (result.outcome === 'denied') return new OnboardingFailure(403, 'subscription_required');
    if (result.outcome === 'invalid_request') return new OnboardingFailure(400, 'billing_request_rejected');
    if (result.outcome === 'conflict') return new OnboardingFailure(409, 'catalog_changed');
    if (result.outcome === 'support_required') return new OnboardingFailure(409, 'support_required');
    return new OnboardingFailure(503, 'billing_unavailable', true);
  }
  private provisioningFailure(error: unknown): OnboardingFailure {
    if (error instanceof ProvisioningFailure) {
      return error.retryable ? new OnboardingFailure(503, error.code, true) : new OnboardingFailure(500, error.code);
    }
    return new OnboardingFailure(503, 'activation_retry', true);
  }
  private async read(key: StateKey): Promise<AccessRow | undefined> {
    try { return await this.store.get(key); }
    catch { throw new OnboardingFailure(503, 'access_state_unavailable', true); }
  }
  private authorityChecks(identity: { issuer: string; subject: string }, entitlement: AccessRow, binding: AccessRow) {
    return [
      { key: { PK: identityPartition(this.store.environment, identity.issuer, identity.subject), SK: 'ENTITLEMENT' },
        expectedRevision: entitlement.revision as number, projection: true },
      { key: { PK: binding.PK as string, SK: binding.SK as string }, expectedRevision: binding.revision as number },
    ];
  }
  private entitlementChecks(identity: { issuer: string; subject: string }, entitlement: AccessRow | undefined) {
    return [{ key: { PK: identityPartition(this.store.environment, identity.issuer, identity.subject), SK: 'ENTITLEMENT' },
      ...(entitlement ? { expectedRevision: entitlement.revision as number } : {}), projection: true }];
  }
  private isConflict(error: unknown) { return error instanceof Error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name); }
  private clock() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new OnboardingFailure(503, 'clock_unavailable', true);
    return value;
  }
}
