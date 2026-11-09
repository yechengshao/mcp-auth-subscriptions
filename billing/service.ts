import { createHash, randomUUID } from 'node:crypto';
import type { BillingRequest } from './dispatcher.js';
import { BillingStore, BillingQueue, conditionalConflict, type Row, type Write, type DueCursor } from './adapters/aws.js';
import { StripeAdapter } from './adapters/stripe.js';
import { purchaseSnapshot, type Snapshot } from './contracts/validate.js';
import type { CatalogValue } from './contracts/catalog-cache.js';
import { canonicalJson } from './contracts/canonical.js';
import { quoteDigest } from './contracts/storage.js';
import { termExpiry } from './contracts/service-term.js';
export interface RuntimeBudgets {
  initial_delay_seconds: number; recovery_horizon_seconds: number; processing_lease_seconds: number;
  processing_budget_ms: number; reconciliation_max_attempts: number; dispatch_max_attempts: number;
  dispatch_backoff_seconds: number; delivery_replay_grace_seconds: number; visibility_timeout_seconds: number;
  page_size: number; max_pages: number; quote_lifetime_seconds: number; catalog_cache_seconds: number; catalog_fetch_timeout_ms: number;
}
export class BillingService {
  constructor(readonly store: BillingStore, private readonly stripe: StripeAdapter, private readonly queue: BillingQueue,
    private readonly catalog: () => Promise<CatalogValue>, private readonly stripeAccount: string, private readonly supportEmail: string, private readonly budgets: RuntimeBudgets, private readonly now = () => Math.floor(Date.now() / 1000)) {}
  private base(identity: BillingRequest['identity'], SK: string, entity_type: string): Row {
    return { ...this.store.key(identity, SK), entity_type, schema_version: 1, revision: 1, environment: this.store.environment, identity };
  }
  private result(request: BillingRequest, payload: unknown) {
    return { schema_version: 1, correlation_id: request.correlation_id, outcome: 'ok', retryable: false, message: 'Request completed.', payload };
  }
  private status(order: Row) { return { order_id: order.order_id, state: order.state, activation_ref: order.order_id }; }
  private support(request: BillingRequest, code = 'unsupported_credit_case') {
    return { schema_version: 1, correlation_id: request.correlation_id, outcome: 'support_required', error_code: code,
      retryable: false, message: 'Contact support for this financial request.', payload: { support_email: this.supportEmail } };
  }
  private conflict(request: BillingRequest) {
    return { schema_version: 1, correlation_id: request.correlation_id, outcome: 'conflict', error_code: 'revision_conflict',
      retryable: false, message: 'Subscription or quote changed; refresh and try again.', payload: {} };
  }
  async owns(request: BillingRequest) {
    const { order_id, subscription_id, quote_id } = request.input;
    const sk = order_id ? `ORDER#${order_id}` : subscription_id ? `SUB#${subscription_id}` : quote_id ? `UPGRADEQUOTE#${quote_id}` : undefined;
    if (!sk) return false;
    const row = await this.store.get(this.store.key(request.identity, sk));
    return !!row && canonicalJson(row.identity) === canonicalJson(request.identity);
  }
  async getOrder(request: BillingRequest) {
    const order = await this.store.get(this.store.key(request.identity, `ORDER#${request.input.order_id}`));
    if (!order) throw new Error('order_not_found');
    const work = order.state === 'pending' ? await this.store.get(this.store.key(request.identity, `WORK#${order.operation_id}`)) : undefined;
    return this.result(request, this.status(work?.state === 'repair_required' ? { ...order, state: 'repair_required' } : order));
  }
  async checkout(request: BillingRequest) {
    const now = this.now();
    const entKey = this.store.key(request.identity, 'ENTITLEMENT');
    const entitlement = await this.store.get(entKey, true);
    if (entitlement?.allowed && entitlement.valid_until > now) return { schema_version: 1, correlation_id: request.correlation_id,
      outcome: 'conflict', error_code: 'revision_conflict', retryable: false, message: 'Subscription already active; reconnect.', payload: {} };
    const requestedOrderId = createHash('sha256').update(canonicalJson([this.store.environment, request.identity, 'checkout', request.idempotency_key])).digest('hex');
    const original = await this.store.get(this.store.key(request.identity, `ORDER#${requestedOrderId}`));
    if (original) {
      if (original.snapshot.plan_id !== request.input.plan_id || original.snapshot.duration_option_id !== request.input.duration_option_id ||
          original.snapshot.catalog_version !== request.input.catalog_version || original.intent !== request.input.intent) return this.conflict(request);
      if (original.state === 'pending') return this.checkoutFor(original, request);
      return this.conflict(request); // An old request never creates another paid term; a new intent needs a new key.
    }
    const leaseKey = this.store.key(request.identity, 'LEASE');
    const previousLease = await this.store.get(leaseKey);
    const previous = previousLease ? await this.store.get(this.store.key(request.identity, `ORDER#${previousLease.lease.owner}`)) : undefined;
    if (previousLease && !previous) throw new Error('purchase_repair_required');
    if (previous?.state === 'pending' || previous?.state === 'repair_required') {
      if (previous.snapshot.plan_id !== request.input.plan_id || previous.snapshot.duration_option_id !== request.input.duration_option_id ||
          previous.snapshot.catalog_version !== request.input.catalog_version || previous.intent !== request.input.intent) return this.conflict(request);
      return this.checkoutFor(previous, request);
    }
    const release = await this.catalog();
    let snapshot: Snapshot;
    try { snapshot = purchaseSnapshot(release.catalog, release.ssm_version, String(request.input.plan_id), String(request.input.duration_option_id),
      String(request.input.catalog_version), request.input.intent as 'purchase' | 'renewal'); }
    catch (error) {
      if (error instanceof Error && error.message === 'catalog_changed') return { ...this.conflict(request), error_code: 'catalog_changed' };
      throw error;
    }
    let order: Row;
    {
      const orderId = requestedOrderId, operation = randomUUID();
      order = { ...this.base(request.identity, `ORDER#${orderId}`, 'order'), order_id: orderId, operation_id: operation,
        intent: request.input.intent, state: 'pending', snapshot, created_at: now, updated_at: now };
      const due = now + this.budgets.initial_delay_seconds;
      const work = { ...this.base(request.identity, `WORK#${operation}`, 'reconciliation_work'), kind: 'reconcile_payment', order_id: orderId,
        operation_id: operation, correlation_id: request.correlation_id, generation: 1, due_at: due, next_attempt_at: due,
        deadline: now + this.budgets.recovery_horizon_seconds, attempts: 0, state: 'pending', dispatch_status: 'idle', dispatch_attempts: 0,
        dispatch_epoch: 0, due_partition: `ENV#${this.store.environment}#DUE#0`, due_sort: `${due.toString().padStart(12, '0')}#${operation}` };
      const lease = { ...this.base(request.identity, 'LEASE', 'billing_lease'), revision: (previousLease?.revision ?? 0) + 1,
        lease: { owner: orderId, fence: (previousLease?.lease.fence ?? 0) + 1, expires_at: now + this.budgets.recovery_horizon_seconds } };
      await this.store.commit([{ row: order }, { row: work }, { row: lease, ...(previousLease ? { expectedRevision: previousLease.revision } : {}) }],
        undefined, [{ key: entKey, projection: true, ...(entitlement ? { revision: entitlement.revision } : {}) }]);
    }
    return this.checkoutFor(order, request);
  }
  private async checkoutFor(order: Row, request: BillingRequest) {
    const now = this.now();
    const work = await this.store.get(this.store.key(request.identity, `WORK#${order.operation_id}`));
    if (work) await this.publish(work).catch(() => undefined); // durable stream/replay recovers send failure
    let session: Row;
    if (order.checkout_session_id) session = await this.stripe.session(order.checkout_session_id);
    else {
      if (now - order.created_at >= 23 * 3600) return this.support(request, 'financial_support_required');
      const customer = await this.store.get(this.store.key(request.identity, 'CUSTOMER'));
      session = await this.stripe.create(order, customer?.stripe_customer_id);
      if (!/^cs_[A-Za-z0-9_]+$/.test(session.id) || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/c/pay/')) throw new Error('invalid_checkout_response');
      const next = { ...order, checkout_session_id: session.id, revision: order.revision + 1, updated_at: this.now() };
      const lookup = { ...this.base(request.identity, 'OWNER', 'provider_lookup'),
        PK: `ENV#${this.store.environment}#STRIPE#${this.stripeAccount}#checkout_session#${session.id}`,
        stripe_account: this.stripeAccount, object_type: 'checkout_session', object_id: session.id, order_id: order.order_id };
      try { await this.store.commit([{ row: next, expectedRevision: order.revision }, { row: lookup }]); order = next; }
      catch (error) { if (!conditionalConflict(error)) throw error;
        const current = await this.store.get(this.store.key(request.identity, order.SK));
        if (!current || current.checkout_session_id !== session.id) throw error;
        order = current;
      }
    }
    if (session.status === 'expired') { await this.expire(order); return { schema_version: 1, correlation_id: request.correlation_id, outcome: 'invalid_request', error_code: 'invalid_request', retryable: false, message: 'Checkout expired; select a plan again.', payload: {} }; }
    if (session.status !== 'open') return { schema_version: 1, correlation_id: request.correlation_id, outcome: 'pending', retryable: true,
      message: 'Payment is being verified.', payload: { order_id: order.order_id, activation_ref: order.order_id, reason: 'payment_pending',
        retry: { retry_after_seconds: 5, next_attempt_at: this.now() + 5 } } };
    return this.result(request, { order_id: order.order_id, checkout_url: session.url });
  }
  private async expire(order: Row) {
    if (order.state !== 'pending') return;
    const writes: Write[] = [{ row: { ...order, state: 'expired', revision: order.revision + 1, updated_at: this.now() }, expectedRevision: order.revision }];
    if (order.intent === 'upgrade') {
      const quote = await this.store.get(this.store.key(order.identity, `UPGRADEQUOTE#${order.quote_id}`));
      const reservation = quote ? await this.store.get(this.store.key(order.identity, `UPGRADERESERVATION#${quote.subscription_id}`)) : undefined;
      if (!quote || !reservation || reservation.order_id !== order.order_id || reservation.state !== 'held') throw new Error('upgrade_reservation_conflict');
      writes.push({ row: { ...quote, state: 'expired', revision: quote.revision + 1 }, expectedRevision: quote.revision },
        { row: { ...reservation, state: 'released', revision: reservation.revision + 1,
          terminal_evidence: { outcome: 'terminal_unpaid', provider_object_id: order.checkout_session_id, observed_at: this.now() } }, expectedRevision: reservation.revision });
    }
    await this.store.commit(writes);
  }
  async reconcile(request: BillingRequest) {
    await this.reconcileKey(this.store.key(request.identity, `ORDER#${request.input.order_id}`));
    return this.getOrder(request);
  }
  async reconcileKey(key: { PK: string; SK: string }, fence?: { key: { PK: string; SK: string }; revision: number }, event?: Write) {
    const order = await this.store.get(key);
    if (!order) throw new Error('missing_order');
    const work = await this.store.get(this.store.key(order.identity, `WORK#${order.operation_id}`));
    return this.store.telemetry.observe('billing.reconcile', { correlationId: work?.correlation_id }, () => this.reduceOrder(key, fence, event));
  }
  private async reduceOrder(key: { PK: string; SK: string }, fence?: { key: { PK: string; SK: string }; revision: number }, event?: Write) {
    const order = await this.store.get(key);
    if (!order) throw new Error('missing_order');
    if (order.state !== 'pending') {
      if (event) {
        const projection = await this.store.get(this.store.key(order.identity, 'ENTITLEMENT'), true);
        await this.store.commit([{ ...event, row: { ...event.row, state: 'committed', committed_revision: projection?.revision ?? 0 } }]);
      }
      return;
    }
    if (!order.checkout_session_id) return;
    const session = await this.stripe.session(order.checkout_session_id);
    const payment = await this.stripe.verifyPaid(session, order);
    if (!payment) { if (session.status === 'expired') await this.expire(order);
      if (event) await this.store.commit([event]);
      return; }
    const now = this.now(), snapshot = order.snapshot as Snapshot;
    if (payment.paidAt > now) throw new Error('future_payment');
    const entitlementKey = this.store.key(order.identity, 'ENTITLEMENT');
    const previous = await this.store.get(entitlementKey, true);
    let quote: Row | undefined, reservation: Row | undefined, source: Row | undefined;
    if (order.intent === 'upgrade') {
      quote = await this.store.get(this.store.key(order.identity, `UPGRADEQUOTE#${order.quote_id}`));
      reservation = quote ? await this.store.get(this.store.key(order.identity, `UPGRADERESERVATION#${quote.subscription_id}`)) : undefined;
      source = quote ? await this.store.get(this.store.key(order.identity, `SUB#${quote.subscription_id}`)) : undefined;
      if (!quote || !reservation || !source || quote.state !== 'confirmed' || reservation.state !== 'held' || reservation.order_id !== order.order_id ||
          reservation.quote_id !== quote.quote_id || source.revision !== quote.source_revision || source.term_id !== quote.source_term_id || source.revoked ||
          !previous?.allowed || previous.valid_until !== source.paid_through || previous.plan_id !== source.snapshot.plan_id) throw new Error('paid_upgrade_repair_required');
    } else if (previous && previous.valid_until > payment.paidAt) throw new Error('paid_term_conflict');
    const validUntil = termExpiry(payment.paidAt, snapshot.service_term), revision = (previous?.revision ?? 0) + 1;
    const subscriptionId = quote?.subscription_id ?? order.order_id;
    const projection = { ...entitlementKey, entity_type: 'entitlement', schema_version: 1, revision, environment: this.store.environment,
      identity_issuer: order.identity.issuer, identity_subject: order.identity.subject, allowed: true, plan_id: snapshot.plan_id,
      duration_option_id: snapshot.duration_option_id, service_term: snapshot.service_term, catalog_version: snapshot.catalog_version,
      ssm_version: snapshot.ssm_version, usage_mapping: snapshot.usage_mapping, valid_until: validUntil, updated_at: now };
    const subscription = { ...this.base(order.identity, `SUB#${subscriptionId}`, 'subscription'), revision: (source?.revision ?? 0) + 1, subscription_id: subscriptionId,
      customer_id: payment.customerId, order_id: order.order_id, term_id: order.order_id, snapshot, term_start: payment.paidAt,
      paid_through: validUntil, state: 'paid', revoked: false, payment_id: payment.paymentId, updated_at: now };
    const history = { ...this.base(order.identity, `HISTORY#${revision.toString().padStart(16, '0')}`, 'decision_history'), revision,
      notification_id: randomUUID(), order_id: order.order_id, term_id: order.order_id, decision_revision: revision, allowed: true,
      snapshot, valid_until: validUntil, created_at: now };
    const customerKey = this.store.key(order.identity, 'CUSTOMER');
    const customer = await this.store.get(customerKey);
    if (customer && customer.stripe_customer_id !== payment.customerId) throw new Error('customer_conflict');
    const writes: Write[] = [
      { row: { ...order, state: 'paid', payment_id: payment.paymentId, revision: order.revision + 1, updated_at: now }, expectedRevision: order.revision },
      { row: projection, ...(previous ? { expectedRevision: previous.revision } : {}) }, { row: subscription, ...(source ? { expectedRevision: source.revision } : {}) },
      // HISTORY revision is the entitlement revision, but the record is always an immutable insert.
      { row: history },
    ];
    if (quote && reservation && source) {
      writes.push({ row: { ...quote, state: 'applied', revision: quote.revision + 1 }, expectedRevision: quote.revision },
        { row: { ...reservation, state: 'consumed', revision: reservation.revision + 1,
          terminal_evidence: { outcome: 'paid', provider_object_id: payment.paymentId, observed_at: now } }, expectedRevision: reservation.revision },
        { row: { ...this.base(order.identity, `CREDIT#${source.term_id}`, 'consumed_credit'), source_term_id: source.term_id,
          quote_id: quote.quote_id, order_id: order.order_id, payment_id: payment.paymentId, credit_minor: order.credit_minor,
          currency: snapshot.currency, new_term_id: order.order_id, consumed_at: now } });
    }
    for (const [objectType, objectId] of [['customer', payment.customerId], ['payment_intent', payment.paymentId]]) {
      const key = { PK: `ENV#${this.store.environment}#STRIPE#${this.stripeAccount}#${objectType}#${objectId}`, SK: 'OWNER' };
      const owner = await this.store.get(key);
      if (owner && (canonicalJson(owner.identity) !== canonicalJson(order.identity) || (objectType === 'payment_intent' && owner.order_id !== order.order_id))) throw new Error('provider_owner_conflict');
      if (!owner) writes.push({ row: { ...this.base(order.identity, 'OWNER', 'provider_lookup'), ...key,
        stripe_account: this.stripeAccount, object_type: objectType, object_id: objectId, order_id: order.order_id } });
    }
    if (event) writes.push({ ...event, row: { ...event.row, state: 'committed', committed_revision: revision } });
    if (!customer) writes.push({ row: { ...this.base(order.identity, 'CUSTOMER', 'customer'),
      stripe_account: this.stripeAccount, stripe_customer_id: payment.customerId } });
    await this.store.commit(writes, undefined, fence ? [fence] : []);
    this.store.telemetry.log('summary', 'billing.reconcile', 'entitlement_committed');
  }
  private async exhaust(work: Row) {
    const { due_partition: _partition, due_sort: _sort, processing_lease: _processing, dispatch_lease: _dispatch, ...rest } = work;
    await this.store.commit([{ row: { ...rest, revision: work.revision + 1, state: 'repair_required',
      dispatch_status: 'exhausted', terminal_outcome: 'exhausted' }, expectedRevision: work.revision }]);
  }
  async publish(input: Row) {
    let work = await this.store.get({ PK: input.PK, SK: input.SK });
    if (!work || work.state !== 'pending') return;
    const now = this.now();
    if (work.processing_lease?.expires_at > now || work.dispatch_lease?.expires_at > now ||
        (work.dispatch_status === 'sent' && work.expected_message_due_at + this.budgets.delivery_replay_grace_seconds + this.budgets.visibility_timeout_seconds > now)) return;
    if (work.dispatch_attempts >= this.budgets.dispatch_max_attempts || now >= work.deadline) { await this.exhaust(work); throw new Error('dispatch_exhausted'); }
    const lease = { owner: randomUUID(), fence: work.dispatch_epoch + 1, expires_at: now + this.budgets.processing_lease_seconds };
    const claimed: Row = { ...work, revision: work.revision + 1, dispatch_status: 'claimed', dispatch_epoch: lease.fence,
      dispatch_attempts: work.dispatch_attempts + 1, dispatch_lease: lease };
    await this.store.commit([{ row: claimed, expectedRevision: work.revision }]); work = claimed;
    const delay = Math.min(Math.max(work.due_at - now, 0), 900);
    await this.queue.send({ schema_version: 1, kind: 'reconcile_payment', message_type: 'run', generation: work.generation,
      environment: this.store.environment, durable_record_key: { PK: work.PK, SK: work.SK }, operation_id: work.operation_id, correlation_id: work.correlation_id }, delay);
    const { dispatch_lease: _lease, ...rest } = work;
    await this.store.commit([{ row: { ...rest, revision: work.revision + 1, dispatch_status: 'sent', expected_message_due_at: now + delay }, expectedRevision: work.revision }]);
  }
  async consume(message: Row) {
    const work = await this.store.get(message.durable_record_key);
    if (!work) throw new Error('missing_work');
    if (message.generation < work.generation || work.state === 'complete') return;
    if (message.generation !== work.generation || work.operation_id !== message.operation_id) throw new Error('invalid_work_generation');
    if (message.message_type === 'dispatch_hint') return this.publish(work);
    const now = this.now();
    if (work.due_at > now) return; // no early-message fanout
    if (work.processing_lease?.expires_at > now) throw new Error('processing_busy');
    if (work.attempts >= this.budgets.reconciliation_max_attempts || now >= work.deadline) { await this.exhaust(work); throw new Error('reconciliation_exhausted'); }
    const claimed: Row = { ...work, revision: work.revision + 1, attempts: work.attempts + 1,
      processing_lease: { owner: randomUUID(), fence: work.revision + 1, expires_at: now + this.budgets.processing_lease_seconds } };
    await this.store.commit([{ row: claimed, expectedRevision: work.revision }]);
    await this.reconcileKey(this.store.key(work.identity, `ORDER#${work.order_id}`), { key: { PK: claimed.PK, SK: claimed.SK }, revision: claimed.revision });
    const order = await this.store.get(this.store.key(work.identity, `ORDER#${work.order_id}`));
    if (!order) throw new Error('missing_order');
    const { processing_lease: _processing, dispatch_lease: _dispatch, expected_message_due_at: _expected, ...rest } = claimed;
    const due = this.now() + this.budgets.dispatch_backoff_seconds;
    const terminal = order.state !== 'pending';
    const exhausted = !terminal && due >= work.deadline;
    const next: Row = !terminal && !exhausted ? { ...rest, revision: claimed.revision + 1, generation: work.generation + 1,
      dispatch_status: 'idle', dispatch_attempts: 0, due_at: due, next_attempt_at: due,
      due_sort: `${due.toString().padStart(12, '0')}#${work.operation_id}` } : { ...rest, revision: claimed.revision + 1,
      dispatch_status: 'idle', state: exhausted ? 'repair_required' : 'complete', terminal_outcome: exhausted ? 'exhausted' : order.state === 'paid' ? 'paid' : 'terminal_unpaid' };
    if (terminal || exhausted) { delete next.due_partition; delete next.due_sort; }
    await this.store.commit([{ row: next, expectedRevision: claimed.revision }]);
    if (next.state === 'pending') await this.publish(next);
  }
  async quoteUpgrade(request: BillingRequest) {
    const subscription = await this.store.get(this.store.key(request.identity, `SUB#${request.input.subscription_id}`));
    const projection = await this.store.get(this.store.key(request.identity, 'ENTITLEMENT'), true);
    const now = this.now();
    if (!subscription || subscription.revision !== request.input.source_revision || subscription.revoked ||
        !projection?.allowed || projection.valid_until <= now || projection.valid_until !== subscription.paid_through ||
        canonicalJson(projection.usage_mapping) !== canonicalJson(subscription.snapshot.usage_mapping)) return this.conflict(request);
    const reservation = await this.store.get(this.store.key(request.identity, `UPGRADERESERVATION#${subscription.subscription_id}`));
    if (reservation?.state === 'held') return this.conflict(request);
    const release = await this.catalog();
    const source = release.catalog.plans[subscription.snapshot.plan_id];
    const targetPlan = release.catalog.plans[String(request.input.plan_id)];
    // Historical discounted/refunded terms and changed tier ordering require an agent's valuation.
    if (subscription.snapshot.catalog_version !== release.catalog.catalog_version || !source || !targetPlan || targetPlan.tier_order <= source.tier_order)
      return this.support(request, 'financial_support_required');
    const oldOrder = await this.store.get(this.store.key(request.identity, `ORDER#${subscription.order_id}`));
    if (!oldOrder || oldOrder.state !== 'paid' || oldOrder.intent === 'upgrade' || !await this.stripe.creditable(oldOrder)) return this.support(request);
    let target: Snapshot;
    try { target = purchaseSnapshot(release.catalog, release.ssm_version, String(request.input.plan_id), String(request.input.duration_option_id), String(request.input.catalog_version), 'upgrade'); }
    catch (error) { if (error instanceof Error && error.message === 'catalog_changed') return { ...this.conflict(request), error_code: 'catalog_changed' }; throw error; }
    if (target.currency !== subscription.snapshot.currency) return this.support(request);
    const credit = Number(BigInt(subscription.snapshot.amount_minor) * BigInt(subscription.paid_through - now) / BigInt(subscription.paid_through - subscription.term_start));
    if (credit >= target.amount_minor) return this.support(request);
    const quoteId = createHash('sha256').update(canonicalJson([request.identity, request.idempotency_key, request.input])).digest('hex');
    let quote = await this.store.get(this.store.key(request.identity, `UPGRADEQUOTE#${quoteId}`));
    if (!quote) {
      quote = { ...this.base(request.identity, `UPGRADEQUOTE#${quoteId}`, 'upgrade_quote'), quote_id: quoteId,
        subscription_id: subscription.subscription_id, source_term_id: subscription.term_id, source_revision: subscription.revision,
        source_start: subscription.term_start, source_end: subscription.paid_through, eligible_old_value_minor: subscription.snapshot.amount_minor,
        quote_at: now, expires_at: Math.min(now + this.budgets.quote_lifetime_seconds, subscription.paid_through),
        source_tier_order: source.tier_order, target_tier_order: targetPlan.tier_order, target, full_amount_minor: target.amount_minor,
        credit_minor: credit, payable_minor: target.amount_minor - credit, currency: target.currency, state: 'offered' };
      quote.quote_digest = quoteDigest(quote);
      await this.store.commit([{ row: quote }], undefined, [{ key: { PK: subscription.PK, SK: subscription.SK }, revision: subscription.revision },
        { key: { PK: projection.PK, SK: projection.SK }, projection: true, revision: projection.revision }]);
    }
    if (quote.expires_at <= now || quote.state !== 'offered') return this.conflict(request);
    return this.result(request, { quote_id: quote.quote_id, subscription_id: quote.subscription_id, source_revision: quote.source_revision,
      plan_id: quote.target.plan_id, duration_option_id: quote.target.duration_option_id, service_term: quote.target.service_term,
      full_amount_minor: quote.full_amount_minor, credit_minor: quote.credit_minor, payable_minor: quote.payable_minor,
      currency: quote.currency, expires_at: quote.expires_at, starts_new_term: true });
  }
  async confirmUpgrade(request: BillingRequest) {
    const quote = await this.store.get(this.store.key(request.identity, `UPGRADEQUOTE#${request.input.quote_id}`));
    if (!quote) return this.conflict(request);
    const reservationKey = this.store.key(request.identity, `UPGRADERESERVATION#${quote.subscription_id}`);
    const reservation = await this.store.get(reservationKey);
    if (reservation && reservation.quote_id === quote.quote_id && reservation.state === 'held') {
      const order = await this.store.get(this.store.key(request.identity, `ORDER#${reservation.order_id}`));
      if (!order) throw new Error('missing_upgrade_order');
      return this.checkoutFor(order, request);
    }
    const source = await this.store.get(this.store.key(request.identity, `SUB#${quote.subscription_id}`));
    const entitlement = await this.store.get(this.store.key(request.identity, 'ENTITLEMENT'), true);
    const now = this.now();
    if (quote.state !== 'offered' || quote.expires_at <= now || !source || source.revision !== quote.source_revision || source.term_id !== quote.source_term_id ||
        source.revoked || !entitlement?.allowed || entitlement.valid_until <= now || entitlement.valid_until !== source.paid_through || reservation?.state === 'held') return this.conflict(request);
    const leaseKey = this.store.key(request.identity, 'LEASE');
    const lease = await this.store.get(leaseKey);
    if (lease && lease.lease.owner !== source.order_id) {
      const competing = await this.store.get(this.store.key(request.identity, `ORDER#${lease.lease.owner}`));
      if (!competing || competing.state === 'pending' || competing.state === 'repair_required') return this.conflict(request);
    }
    const orderId = randomUUID(), operation = randomUUID(), due = now + this.budgets.initial_delay_seconds;
    const order = { ...this.base(request.identity, `ORDER#${orderId}`, 'order'), order_id: orderId, operation_id: operation,
      intent: 'upgrade', state: 'pending', snapshot: quote.target, created_at: now, updated_at: now,
      quote_id: quote.quote_id, payable_minor: quote.payable_minor, credit_minor: quote.credit_minor };
    const held = { ...this.base(request.identity, reservationKey.SK, 'credit_reservation'), revision: (reservation?.revision ?? 0) + 1,
      subscription_id: quote.subscription_id, source_term_id: source.term_id, source_revision: source.revision, quote_id: quote.quote_id,
      order_id: orderId, operation_id: operation, generation: (reservation?.generation ?? 0) + 1, state: 'held' };
    const work = { ...this.base(request.identity, `WORK#${operation}`, 'reconciliation_work'), kind: 'reconcile_payment', order_id: orderId,
      operation_id: operation, correlation_id: request.correlation_id, generation: 1, due_at: due, next_attempt_at: due,
      deadline: now + this.budgets.recovery_horizon_seconds, attempts: 0, state: 'pending', dispatch_status: 'idle', dispatch_attempts: 0,
      dispatch_epoch: 0, due_partition: `ENV#${this.store.environment}#DUE#0`, due_sort: `${due.toString().padStart(12, '0')}#${operation}` };
    const nextLease = { ...this.base(request.identity, 'LEASE', 'billing_lease'), revision: (lease?.revision ?? 0) + 1,
      lease: { owner: orderId, fence: (lease?.lease.fence ?? 0) + 1, expires_at: now + this.budgets.recovery_horizon_seconds } };
    await this.store.commit([{ row: order }, { row: work }, { row: nextLease, ...(lease ? { expectedRevision: lease.revision } : {}) }, { row: { ...quote, revision: quote.revision + 1, state: 'confirmed' }, expectedRevision: quote.revision },
      { row: held, ...(reservation ? { expectedRevision: reservation.revision } : {}) }], undefined,
      [{ key: { PK: source.PK, SK: source.SK }, revision: source.revision }, { key: { PK: entitlement.PK, SK: entitlement.SK }, revision: entitlement.revision, projection: true }]);
    return this.checkoutFor(order, request);
  }
  async replay() {
    const key = { PK: `ENV#${this.store.environment}#REPLAY#0`, SK: 'CHECKPOINT' };
    const previous = await this.store.get(key);
    const now = this.now();
    if (previous?.lease?.expires_at > now) return;
    const claimed = { ...key, schema_version: 1, entity_type: 'replay_checkpoint', environment: this.store.environment,
      replay_shard: 0, revision: (previous?.revision ?? 0) + 1, ...(previous?.cursor ? { cursor: previous.cursor } : {}),
      lease: { owner: randomUUID(), fence: (previous?.revision ?? 0) + 1, expires_at: now + this.budgets.processing_lease_seconds } };
    await this.store.commit([{ row: claimed, ...(previous ? { expectedRevision: previous.revision } : {}) }]);
    const started = Date.now(); let age = 0, failures = false; let next: DueCursor | undefined = previous?.cursor;
    try {
      for (let page = 0; page < this.budgets.max_pages && Date.now() - started < this.budgets.processing_budget_ms; page++) {
        const results = await this.store.due(0, this.now(), this.budgets.page_size, next);
        for (const item of results.keys) {
          if (Date.now() - started >= this.budgets.processing_budget_ms) return;
          try {
            const row = await this.store.get(item);
            if (row?.state === 'pending') {
              age = Math.max(age, this.now() - row.due_at);
              await this.store.telemetry.observe('billing.reconcile', { correlationId: row.correlation_id }, () => this.publish(row));
            }
          } catch { failures = true; } // Preserve cursor progress past one repairable item; dependency errors are logged.
        }
        next = results.next;
        if (!next) break;
      }
      if (failures) throw new Error('billing_replay_item_failed');
    } finally {
      const checkpoint: Row = { ...key, schema_version: 1, entity_type: 'replay_checkpoint', environment: this.store.environment,
        replay_shard: 0, revision: claimed.revision + 1, ...(next ? { cursor: next } : {}) };
      await this.store.commit([{ row: checkpoint, expectedRevision: claimed.revision }]);
      this.store.telemetry.metric('BillingReconcileDueAgeSeconds', Math.max(age, 0));
    }
  }
}
