import Stripe from 'stripe';
import type { Snapshot } from '../contracts/validate.js';
import type { Telemetry } from '../../observability/telemetry.js';
import type { BillingPayments } from '../ports.js';
export const STRIPE_API_VERSION = '2025-02-24.acacia';
type Json = Record<string, any>;
export interface StripeSettings { account: string; live: boolean; successUrl: string; cancelUrl: string; maxPages: number }
export class StripeAdapter implements BillingPayments {
  private accountKey: string | undefined;
  private clientKey: string | undefined;
  private client: Stripe | undefined;
  constructor(private readonly secret: () => Promise<string>, private readonly settings: StripeSettings,
    private readonly telemetry: Telemetry, private readonly transport: typeof fetch = fetch) {
    for (const url of [settings.successUrl, settings.cancelUrl]) if (new URL(url).protocol !== 'https:') throw new Error('invalid_billing_return_url');
    if (!/^acct_[A-Za-z0-9_]+$/.test(settings.account) || !Number.isInteger(settings.maxPages) || settings.maxPages < 1 || settings.maxPages > 10) throw new Error('invalid_stripe_config');
  }
  private async request(path: string, method = 'GET', body?: URLSearchParams, idempotency?: string): Promise<Json> {
    const key = await this.secret();
    if (!new RegExp(this.settings.live ? '^sk_live_' : '^sk_test_').test(key)) throw new Error('stripe_mode_mismatch');
    if (!this.client || this.clientKey !== key) {
      this.client = new Stripe(key, { httpClient: Stripe.createFetchHttpClient(this.transport), maxNetworkRetries: 0, timeout: 5000, telemetry: false });
      this.clientKey = key;
    }
    const client = this.client;
    const send = async (route: string, verb: string, data?: URLSearchParams, token?: string) => this.telemetry.dependency('stripe.request', async () => {
      try {
        const result: unknown = await client.rawRequest(verb, `/v1/${route}`, data ? Object.fromEntries(data) : undefined, {
          apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 5000, ...(token ? { idempotencyKey: token } : {}),
        });
        if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error('invalid_stripe_response');
        return result as Json;
      } catch { throw new Error('stripe_request_failed'); }
    });
    if (this.accountKey !== key) {
      const account = await send('account', 'GET');
      if (account.id !== this.settings.account) throw new Error('stripe_account_mismatch');
      this.accountKey = key;
    }
    return send(path, method, body, idempotency);
  }
  async create(order: Json, customer?: string): Promise<Json> {
    const snapshot = order.snapshot as Snapshot;
    const price = await this.request(`prices/${encodeURIComponent(snapshot.price_id)}`);
    if (price.type !== 'one_time' || price.recurring || price.active !== true || price.product !== snapshot.product_id ||
        price.unit_amount !== snapshot.amount_minor || price.currency !== snapshot.currency || price.livemode !== this.settings.live) throw new Error('stripe_price_mismatch');
    const body = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': snapshot.price_id, 'line_items[0][quantity]': '1',
      client_reference_id: order.order_id, success_url: this.settings.successUrl, cancel_url: this.settings.cancelUrl,
      'metadata[order_id]': order.order_id, 'payment_intent_data[metadata][order_id]': order.order_id });
    if (order.intent === 'upgrade') {
      if (!Number.isSafeInteger(order.payable_minor) || order.payable_minor <= 0 || order.payable_minor + order.credit_minor !== snapshot.amount_minor) throw new Error('invalid_upgrade_amount');
      body.delete('line_items[0][price]');
      body.set('line_items[0][price_data][currency]', snapshot.currency);
      body.set('line_items[0][price_data][product]', snapshot.product_id);
      body.set('line_items[0][price_data][unit_amount]', String(order.payable_minor));
    }
    if (customer) body.set('customer', customer); else body.set('customer_creation', 'always');
    // Never retry this POST after the provider's idempotency retention window.
    return this.request('checkout/sessions', 'POST', body, `checkout_${order.operation_id}`);
  }
  async session(id: string): Promise<Json> {
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error('invalid_session_reference');
    return this.request(`checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items&expand[]=payment_intent.latest_charge`);
  }
  async creditable(order: Json): Promise<boolean> {
    if (!order.checkout_session_id) return false;
    const session = await this.session(order.checkout_session_id);
    const charge = session.payment_intent?.latest_charge;
    return session.client_reference_id === order.order_id && session.mode === 'payment' && session.livemode === this.settings.live &&
      session.payment_status === 'paid' && session.amount_total === order.snapshot.amount_minor &&
      session.currency === order.snapshot.currency && session.total_details?.amount_discount === 0 && session.total_details?.amount_tax === 0 &&
      session.total_details?.amount_shipping === 0 && charge && typeof charge === 'object' && charge.paid === true &&
      charge.refunded === false && charge.disputed === false && charge.amount_refunded === 0;
  }
  async verifyPaid(session: Json, order: Json): Promise<{ paymentId: string; customerId: string; paidAt: number } | undefined> {
    const snapshot = order.snapshot as Snapshot;
    const expectedAmount = order.intent === 'upgrade' ? order.payable_minor : snapshot.amount_minor;
    if (session.client_reference_id !== order.order_id || session.mode !== 'payment' || session.livemode !== this.settings.live ||
        session.amount_total !== expectedAmount || session.currency !== snapshot.currency) throw new Error('stripe_order_mismatch');
    const lines = session.line_items?.data;
    if (!Array.isArray(lines) || lines.length !== 1 || session.line_items.has_more || lines[0].quantity !== 1 ||
        (order.intent === 'upgrade' ? (lines[0].price?.product !== snapshot.product_id || lines[0].price?.unit_amount !== expectedAmount) : lines[0].price?.id !== snapshot.price_id) || lines[0].price?.type !== 'one_time') throw new Error('stripe_line_mismatch');
    if (session.payment_status !== 'paid') return undefined;
    const pi = session.payment_intent;
    if (!pi || typeof pi !== 'object' || pi.status !== 'succeeded' || pi.amount_received !== expectedAmount ||
        pi.currency !== snapshot.currency || pi.metadata?.order_id !== order.order_id || !/^pi_[A-Za-z0-9_]+$/.test(pi.id) ||
        !/^cus_[A-Za-z0-9_]+$/.test(session.customer)) throw new Error('stripe_payment_mismatch');
    // Authoritative success-event timestamp; never extend a term using receipt/reconciliation time.
    let after: string | undefined;
    for (let page = 0; page < this.settings.maxPages; page++) {
      const query = new URLSearchParams({ type: 'payment_intent.succeeded', limit: '100', 'created[gte]': String(order.created_at) });
      if (after) query.set('starting_after', after);
      const events = await this.request(`events?${query}`);
      if (!Array.isArray(events.data)) throw new Error('invalid_stripe_events');
      const event = events.data.find((item: Json) => item.type === 'payment_intent.succeeded' && item.data?.object?.id === pi.id);
      if (event && Number.isSafeInteger(event.created) && event.created >= order.created_at) return { paymentId: pi.id, customerId: session.customer, paidAt: event.created };
      if (!events.has_more || !events.data.length) break;
      after = events.data.at(-1).id;
    }
    throw new Error('payment_timestamp_unavailable');
  }
}
export function verifyWebhook(raw: Buffer, signature: string, secret: string, live: boolean, account: string, now: number): Json {
  if (raw.length > 1048576 || signature.length > 4096) throw new Error('invalid_webhook');
  const fields = signature.split(',').map(field => field.split('='));
  const timestamps = fields.filter(([key]) => key === 't').map(([, value]) => value!);
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value!);
  if (timestamps.length !== 1 || !/^\d{1,12}$/.test(timestamps[0]!) || !signatures.length || signatures.length > 10 ||
      Math.abs(now - Number(timestamps[0])) > 300) throw new Error('invalid_webhook');
  let event: Json;
  try { event = Stripe.webhooks.constructEvent(raw, signature, secret, 300, undefined, now * 1000) as unknown as Json; }
  catch { throw new Error('invalid_webhook'); }
  if (event.api_version !== undefined && event.api_version !== STRIPE_API_VERSION) throw new Error('invalid_webhook_version');
  if (!event || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || event.livemode !== live || (event.account !== undefined && event.account !== account)) throw new Error('invalid_webhook');
  return event;
}
