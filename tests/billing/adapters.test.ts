import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BillingStore, BillingQueue, parameterCatalog, parameterSecret } from '../../billing/adapters/aws.js';
import { StripeAdapter, verifyWebhook, STRIPE_API_VERSION } from '../../billing/adapters/stripe.js';
import { BillingService } from '../../billing/service.js';
import { composeBillingHandler, type HandlerConfig } from '../../billing/handler.js';
import { Telemetry } from '../../billing/observability.js';
import { validateCatalog, type Catalog } from '../../billing/contracts/validate.js';
import { catalog, scope, now, identity, operation, message } from '../fixtures/contracts.js';
import { budgets } from '../fixtures/storage.js';
import type { BillingRequest } from '../../billing/dispatcher.js';

function harness() {
  let clock = now, paid = false, posts = 0, sends = 0, failPaymentCommit = false, losePostResponse = false, failSend = false;
  const offers = structuredClone(catalog) as any; const sessionOrders = new Map<string, string>();
  const rows = new Map<string, Record<string, any>>(); const commands: any[] = []; const logs: string[] = [];
  const key = (table: string, row: Record<string, any>) => `${table}|${row.PK}|${row.SK}`;
  const db = { send: async (command: any) => {
    const input = command.input; commands.push(command);
    if (command.constructor.name === 'GetCommand') return { Item: structuredClone(rows.get(key(input.TableName, input.Key))) };
    if (command.constructor.name === 'QueryCommand') {
      const selected = [...rows.values()].filter(row => row.due_partition && row.due_sort <= input.ExpressionAttributeValues[':due'] &&
        (!input.ExclusiveStartKey || row.due_sort > input.ExclusiveStartKey.due_sort)).sort((a, b) => a.due_sort.localeCompare(b.due_sort));
      const page = selected.slice(0, input.Limit).map(row => ({ PK: row.PK, SK: row.SK, due_partition: row.due_partition, due_sort: row.due_sort }));
      return { Items: page, ...(selected.length > page.length ? { LastEvaluatedKey: page.at(-1) } : {}) };
    }
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    if (failPaymentCommit && input.TransactItems.some((item: any) => item.Put?.TableName === 'entitlements')) { failPaymentCommit = false; throw new Error('simulated_outage'); }
    for (const item of input.TransactItems) {
      const spec = item.Put ?? item.ConditionCheck; const old = rows.get(key(spec.TableName, spec.Item ?? spec.Key));
      const valid = spec.ConditionExpression === 'attribute_not_exists(PK)' ? !old : old?.revision === spec.ExpressionAttributeValues[':revision'];
      if (!valid) { const error = new Error('conflict'); error.name = 'TransactionCanceledException'; throw error; }
    }
    for (const item of input.TransactItems) if (item.Put) rows.set(key(item.Put.TableName, item.Put.Item), structuredClone(item.Put.Item));
    return {};
  } };
  const telemetry = new Telemetry({ service: 'billing', environment: 'test', release: 'fixture' }, { sink: line => logs.push(line) });
  const store = new BillingStore('test', 'state', 'entitlements', telemetry, db as any);
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init!.headers).entries());
    assert.equal(headers['stripe-version'], STRIPE_API_VERSION);
    const path = String(url);
    let result: any;
    if (path.endsWith('/account')) result = { id: scope.stripe_account };
    else if (path.includes('/prices/')) {
      const option = Object.values(offers.plans).flatMap((plan: any) => Object.values(plan.duration_options)).find((value: any) => path.endsWith('/' + value.price_id)) as any;
      result = { id: option.price_id, type: 'one_time', active: true, product: option.product_id, unit_amount: option.amount_minor, currency: option.currency, livemode: false };
    }
    else if (init!.method === 'POST') {
      posts++; const body = new URLSearchParams(String(init!.body));
      assert.equal(body.get('mode'), 'payment');
      const order = [...rows.values()].find(row => row.order_id === body.get('client_reference_id') && row.entity_type === 'order')!;
      if (order.intent === 'upgrade') assert.equal(body.get('line_items[0][price_data][unit_amount]'), String(order.payable_minor));
      else assert.equal(body.get('line_items[0][price]'), 'price_fixture');
      assert.equal(body.has('subscription_data'), false); assert.ok(headers['idempotency-key']);
      const id = [...sessionOrders].find(([, value]) => value === order.order_id)?.[0] ?? (sessionOrders.size ? `cs_upgrade${sessionOrders.size}` : 'cs_fixture');
      sessionOrders.set(id, order.order_id);
      if (losePostResponse) { losePostResponse = false; throw new Error('PROVIDER_SECRET_SENTINEL'); }
      result = { id, status: 'open', url: 'https://checkout.stripe.com/c/pay/fixture' };
    } else if (path.includes('/events?')) {
      result = { data: [...sessionOrders].map(([id]) => ({ id: `evt_${id}`, type: 'payment_intent.succeeded', created: id === 'cs_fixture' ? now + 1 : clock - 1, data: { object: { id: id === 'cs_fixture' ? 'pi_fixture' : `pi_${id}` } } })), has_more: false };
    } else {
      const sessionId = new URL(path).pathname.split('/').at(-1)!;
      const order = [...rows.values()].find(row => row.entity_type === 'order' && row.order_id === sessionOrders.get(sessionId))!;
      const amount = order.intent === 'upgrade' ? order.payable_minor : order.snapshot.amount_minor;
      result = { id: sessionId, status: paid ? 'complete' : 'open', url: 'https://checkout.stripe.com/c/pay/fixture',
        mode: 'payment', livemode: false, client_reference_id: order.order_id, amount_total: amount, currency: 'usd', customer: 'cus_fixture',
        payment_status: paid ? 'paid' : 'unpaid', line_items: { data: [{ quantity: 1, price: { id: order.snapshot.price_id, type: 'one_time', product: order.snapshot.product_id, unit_amount: amount } }], has_more: false },
        total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
        payment_intent: { id: sessionId === 'cs_fixture' ? 'pi_fixture' : `pi_${sessionId}`, latest_charge: { paid: true, refunded: false, disputed: false, amount_refunded: 0 }, status: 'succeeded', amount_received: amount, currency: 'usd', metadata: { order_id: order.order_id } } };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const stripe = new StripeAdapter(async () => 'sk_test_fixture', { account: scope.stripe_account, live: false,
    successUrl: 'https://example.invalid/billing/return', cancelUrl: 'https://example.invalid/billing/cancel', maxPages: 2 }, telemetry, transport as typeof fetch);
  const sqs = { send: async (command: any) => { sends++; commands.push(command); if (failSend) { failSend = false; throw new Error('lost_send_response'); } return { MessageId: 'message_fixture' }; } };
  const queue = new BillingQueue('https://sqs.us-east-1.amazonaws.com/000000000000/test', 'test', telemetry, sqs as any);
  const readCatalog = async () => ({ ssm_version: 1, catalog: validateCatalog(offers, scope) });
  const limits = { ...budgets };
  const service = new BillingService(store, stripe, queue, readCatalog, scope.stripe_account, 'support@example.invalid', limits, () => clock);
  const request: BillingRequest = { ...operation, schema_version: 1, operation: 'createCheckout', continuation_ref: 'tx_fixture',
    input: { plan_id: 'basic', duration_option_id: 'short', catalog_version: 'fixture_v1', intent: 'purchase' } };
  return { service, store, rows, commands, logs, stripe, telemetry, readCatalog, request, offers, limits, sessions: () => sessionOrders.size,
    clock: (value: number) => { clock = value; }, paid: (value = true) => { paid = value; }, failCommit: () => { failPaymentCommit = true; },
    loseSend: () => { failSend = true; }, losePost: () => { losePostResponse = true; }, counts: () => ({ posts, sends }) };
}
test('real adapters: durable intent precedes Stripe, retries reuse Checkout and queue dispatch', async () => {
  const h = harness();
  const first = await h.service.checkout(h.request) as any;
  const again = await h.service.checkout(h.request) as any;
  assert.deepEqual(first, again); assert.deepEqual(h.counts(), { posts: 1, sends: 1 });
  const firstWrite = h.commands.find(c => c.constructor.name === 'TransactWriteCommand').input.TransactItems;
  assert.equal(firstWrite.filter((item: any) => item.Put).length, 3);
  assert.ok(firstWrite.some((item: any) => item.ConditionCheck?.TableName === 'entitlements'));
  assert.equal(h.commands.filter(c => c.constructor.name === 'GetCommand').every(c => c.input.ConsistentRead), true);
});
test('real adapters: delayed paid reconciliation commits order, subscription, history and projection atomically', async () => {
  const h = harness(); await h.service.checkout(h.request);
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  const incoming = { ...message, operation_id: work.operation_id, durable_record_key: { PK: work.PK, SK: work.SK } };
  await h.service.consume({ ...incoming, message_type: 'dispatch_hint' });
  await h.service.consume(incoming); assert.equal(h.counts().sends, 1); // early run never forwards
  h.clock(work.due_at); h.paid(); h.failCommit();
  await assert.rejects(h.service.consume(incoming));
  assert.equal([...h.rows.values()].some(row => row.entity_type === 'entitlement'), false);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'order')!.state, 'pending');
  h.clock(work.due_at + budgets.processing_lease_seconds + 1);
  await h.service.consume(incoming); await h.service.consume(incoming);
  const entitlement = [...h.rows.values()].find(row => row.entity_type === 'entitlement')!;
  assert.equal(entitlement.valid_until, now + 1 + 3 * 86400);
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'decision_history').length, 1);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!.due_partition, undefined);
  const active = await h.service.checkout(h.request) as any; assert.equal(active.outcome, 'conflict'); assert.equal(h.counts().posts, 1);
});
test('concurrent purchases cannot create two orders or charges', async () => {
  const h = harness();
  const results = await Promise.allSettled([h.service.checkout(h.request), h.service.checkout(h.request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await h.service.checkout(h.request);
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'order').length, 1);
  assert.equal(h.counts().posts, 1);
});
test('uncertain Checkout outcome never blindly retries beyond Stripe idempotency retention', async () => {
  const h = harness(); h.losePost(); await assert.rejects(h.service.checkout(h.request));
  h.clock(now + 23 * 3600);
  const repair = await h.service.checkout(h.request) as any;
  assert.equal(repair.outcome, 'support_required'); assert.equal(repair.error_code, 'financial_support_required');
  assert.equal(h.counts().posts, 1);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'order')!.state, 'pending');
});
test('DynamoDB adapter rejects invalid records before any SDK call', async () => {
  const h = harness();
  await assert.rejects(h.store.commit([{ row: { PK: 'bad', SK: 'bad', entity_type: 'entitlement' } }]));
  assert.equal(h.commands.length, 0);
});
test('Parameter Store adapters use String catalog and SecureString secret with bounded caching', async () => {
  const h = harness(); const commands: any[] = [];
  const ssm = { send: async (command: any) => { commands.push(command.input); return { Parameter: command.input.WithDecryption
    ? { Type: 'SecureString', Value: 'SECRET_SENTINEL', Version: 1 } : { Type: 'String', Value: JSON.stringify(catalog), Version: 1 } }; } };
  const cache = parameterCatalog('/test/catalog', scope, h.telemetry, ssm as any);
  await cache.read(); await cache.read();
  const secret = parameterSecret('/test/stripe', h.telemetry, ssm as any); await secret(); await secret();
  assert.deepEqual(commands, [{ Name: '/test/catalog', WithDecryption: false }, { Name: '/test/stripe', WithDecryption: true }]);
  assert.equal(h.logs.join('').includes('SECRET_SENTINEL'), false);
});
test('webhook signature covers exact raw bytes, timestamp, mode and account', () => {
  const raw = Buffer.from(JSON.stringify({ id: 'evt_fixture', livemode: false, type: 'checkout.session.completed' }));
  const sig = (body: Buffer, timestamp = now) => `t=${timestamp},v1=${createHmac('sha256', 'whsec_fixture').update(`${timestamp}.`).update(body).digest('hex')}`;
  assert.equal(verifyWebhook(raw, sig(raw), 'whsec_fixture', false, 'acct_fixture', now).id, 'evt_fixture');
  for (const invalid of [() => verifyWebhook(Buffer.concat([raw, Buffer.from(' ')]), sig(raw), 'whsec_fixture', false, 'acct_fixture', now),
    () => verifyWebhook(raw, sig(raw), 'whsec_fixture', false, 'acct_fixture', now + 301),
    () => verifyWebhook(raw, sig(raw), 'whsec_fixture', true, 'acct_fixture', now),
    () => verifyWebhook(raw, `t=${now},${sig(raw)}`, 'whsec_fixture', false, 'acct_fixture', now)]) assert.throws(invalid);
});
test('composed Lambda routes only allowed SQS source and reports individual invalid messages', async () => {
  const h = harness();
  const config = { environment: 'test', scope, supportEmail: 'support@example.invalid', queueArn: 'arn:aws:sqs:us-east-1:000000000000:test',
    replayRuleArn: 'arn:aws:events:us-east-1:000000000000:rule/replay' } as HandlerConfig;
  const handler = composeBillingHandler(config, h.service, h.telemetry, h.readCatalog, async () => 'whsec_fixture');
  const result = await handler({ Records: [{ messageId: 'bad', eventSource: 'aws:sqs', eventSourceARN: config.queueArn, body: '{}' }] }, {});
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'bad' }] });
  await assert.rejects(handler({ operation: 'listPlans', Records: [] }, {}), /ambiguous/);
  await assert.rejects(handler({ Records: [{ messageId: 'bad', eventSource: 'aws:sqs', eventSourceARN: 'foreign', body: '{}' }] }, {}), /invalid_sqs_source/);
});
test('paid upgrade reserves credit, preserves old access until payment and consumes credit once', async () => {
  const h = harness(); await h.service.checkout(h.request); h.paid(); h.clock(now + 300);
  const order = [...h.rows.values()].find(row => row.entity_type === 'order')!;
  await h.service.reconcileKey({ PK: order.PK, SK: order.SK });
  const original = [...h.rows.values()].find(row => row.entity_type === 'entitlement')!;
  const premium = structuredClone(h.offers.plans.basic);
  premium.tier_order = 2; premium.duration_options.short.amount_minor = 2468;
  premium.duration_options.short.price_id = 'price_premium'; premium.duration_options.short.product_id = 'prod_premium';
  h.offers.plans.premium = premium;
  const quoteRequest: BillingRequest = { ...h.request, operation: 'quoteUpgrade', input: { subscription_id: order.order_id,
    source_revision: 1, plan_id: 'premium', duration_option_id: 'short', catalog_version: 'fixture_v1' } };
  const quote = await h.service.quoteUpgrade(quoteRequest) as any;
  assert.equal(quote.outcome, 'ok'); assert.equal(quote.payload.credit_minor, 1232);
  const confirm = { ...h.request, operation: 'confirmUpgrade', input: { quote_id: quote.payload.quote_id } };
  h.paid(false);
  await h.service.confirmUpgrade(confirm); await h.service.confirmUpgrade(confirm);
  assert.deepEqual([...h.rows.values()].find(row => row.entity_type === 'entitlement'), original);
  assert.equal(h.counts().posts, 2);
  const upgrade = [...h.rows.values()].find(row => row.entity_type === 'order' && row.intent === 'upgrade')!;
  h.clock(now + 320); h.paid();
  await h.service.reconcileKey({ PK: upgrade.PK, SK: upgrade.SK });
  await h.service.reconcileKey({ PK: upgrade.PK, SK: upgrade.SK });
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'consumed_credit').length, 1);
  const changed = [...h.rows.values()].find(row => row.entity_type === 'entitlement')!;
  assert.equal(changed.plan_id, 'premium'); assert.equal(changed.revision, 2);
  assert.equal(changed.valid_until, now + 319 + 3 * 86400);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'credit_reservation')!.state, 'consumed');
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'decision_history').length, 2);
});
test('stale catalog input cannot create a Checkout or provider effect', async () => {
  const h = harness(); const response = await h.service.checkout({ ...h.request, input: { ...h.request.input, catalog_version: 'stale' } }) as any;
  assert.equal(response.error_code, 'catalog_changed'); assert.deepEqual(h.counts(), { posts: 0, sends: 0 });
});
test('committed pending purchase can retry without the latest catalog', async () => {
  const h = harness(); await h.service.checkout(h.request);
  h.offers.schema_version = 99;
  const response = await h.service.checkout(h.request) as any;
  assert.equal(response.outcome, 'ok'); assert.equal(h.counts().posts, 1);
});
test('webhook handling persists minimal event evidence and deduplicates signed deliveries', async () => {
  const h = harness(); await h.service.checkout(h.request); h.paid(); h.clock(now + 10);
  const config = { environment: 'test', scope, live: false, supportEmail: 'support@example.invalid',
    queueArn: 'arn:aws:sqs:us-east-1:000000000000:test', replayRuleArn: 'arn:aws:events:us-east-1:000000000000:rule/replay' } as HandlerConfig;
  const app = composeBillingHandler(config, h.service, h.telemetry, h.readCatalog, async () => 'whsec_fixture');
  const body = JSON.stringify({ id: 'evt_delivery', livemode: false, type: 'checkout.session.completed', data: { object: { id: 'cs_fixture', email: 'PRIVATE_SENTINEL' } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${createHmac('sha256', 'whsec_fixture').update(`${timestamp}.${body}`).digest('hex')}`;
  const event = { httpMethod: 'POST', path: '/billing/webhook', headers: { 'stripe-signature': signature }, body };
  for (let delivery = 0; delivery < 10; delivery++) {
    const incoming = delivery % 2 ? { ...event, body: Buffer.from(body).toString('base64'), isBase64Encoded: true } : event;
    assert.equal((await app(incoming, {}) as any).statusCode, 200);
  }
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'decision_history').length, 1);
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'event').length, 1);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'event')!.state, 'committed');
  assert.equal(JSON.stringify([...h.rows.values()]).includes('PRIVATE_SENTINEL'), false);
  assert.equal(h.logs.join('').includes('PRIVATE_SENTINEL'), false);
  assert.equal(h.logs.join('').includes('corr_fixture'), true);
});
test('replaying a completed purchase intent after expiry cannot create another Checkout', async () => {
  const h = harness(); await h.service.checkout(h.request); h.paid(); h.clock(now + 10);
  const order = [...h.rows.values()].find(row => row.entity_type === 'order')!;
  await h.service.reconcileKey({ PK: order.PK, SK: order.SK }); h.clock(now + 4 * 86400);
  const result = await h.service.checkout(h.request) as any;
  assert.equal(result.outcome, 'conflict'); assert.equal(h.counts().posts, 1);
});
test('uncertain Checkout retries reuse the durable provider effect within its retention window', async () => {
  const h = harness(); h.losePost(); await assert.rejects(h.service.checkout(h.request));
  const result = await h.service.checkout(h.request) as any;
  assert.equal(result.outcome, 'ok'); assert.equal(h.sessions(), 1); assert.equal(h.counts().posts, 2);
});
test('Stripe rejects wrong account, recurring price or changed price before Checkout POST', async () => {
  for (const fault of ['account', 'recurring', 'amount']) {
    const h = harness(); let posts = 0;
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') posts++;
      const response = String(url).endsWith('/account') ? { id: fault === 'account' ? 'acct_wrong' : scope.stripe_account }
        : { type: fault === 'recurring' ? 'recurring' : 'one_time', active: true, product: 'prod_fixture', unit_amount: fault === 'amount' ? 1 : 1234, currency: 'usd', livemode: false };
      return new Response(JSON.stringify(response));
    };
    const stripe = new StripeAdapter(async () => 'sk_test_fixture', { account: scope.stripe_account, live: false,
      successUrl: 'https://example.invalid/success', cancelUrl: 'https://example.invalid/cancel', maxPages: 1 }, h.telemetry, transport as typeof fetch);
    const snapshot = (await h.readCatalog()).catalog.plans.basic!;
    await assert.rejects(stripe.create({ order_id: 'fixture', operation_id: 'fixture', intent: 'purchase', snapshot: {
      ...snapshot.duration_options.short, price_id: 'price_fixture', product_id: 'prod_fixture' } }));
    assert.equal(posts, 0);
  }
});
test('bounded replay persists its cursor and fairly reaches later due work', async () => {
  const h = harness(); h.limits.page_size = 1; h.limits.max_pages = 1;
  for (const subject of ['one', 'two', 'three']) await h.service.checkout({ ...h.request, identity: { ...identity, subject } });
  h.clock(now + 1000);
  await h.service.replay();
  const first = [...h.rows.values()].find(row => row.entity_type === 'replay_checkpoint')!;
  assert.ok(first.cursor); assert.equal(first.lease, undefined);
  await h.service.replay();
  const second = [...h.rows.values()].find(row => row.entity_type === 'replay_checkpoint')!;
  assert.notDeepEqual(second.cursor, first.cursor);
  await h.service.replay();
  const third = [...h.rows.values()].find(row => row.entity_type === 'replay_checkpoint')!;
  assert.equal(third.cursor, undefined); assert.equal(h.counts().sends, 6);
});
test('duplicate Pipe hints do not fan out a confirmed delayed send', async () => {
  const h = harness(); await h.service.checkout(h.request);
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  const hint = { ...message, message_type: 'dispatch_hint', operation_id: work.operation_id, durable_record_key: { PK: work.PK, SK: work.SK } };
  for (let duplicate = 0; duplicate < 10; duplicate++) await h.service.consume(hint);
  assert.equal(h.counts().sends, 1);
});
test('stale processing fence cannot commit a paid entitlement', async () => {
  const h = harness(); await h.service.checkout(h.request); h.paid(); h.clock(now + 10);
  const order = [...h.rows.values()].find(row => row.entity_type === 'order')!;
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  await h.store.commit([{ row: { ...work, revision: work.revision + 1 }, expectedRevision: work.revision }]);
  await assert.rejects(h.service.reconcileKey({ PK: order.PK, SK: order.SK }, { key: { PK: work.PK, SK: work.SK }, revision: work.revision }));
  assert.equal([...h.rows.values()].some(row => row.entity_type === 'entitlement'), false);
  await h.service.reconcileKey({ PK: order.PK, SK: order.SK }, { key: { PK: work.PK, SK: work.SK }, revision: work.revision + 1 });
  assert.equal([...h.rows.values()].filter(row => row.entity_type === 'entitlement').length, 1);
});
test('pending payment advances one generation and stale/early runs never multiply successors', async () => {
  const h = harness(); await h.service.checkout(h.request);
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  const incoming = { ...message, operation_id: work.operation_id, durable_record_key: { PK: work.PK, SK: work.SK } };
  h.clock(work.due_at); await h.service.consume(incoming);
  for (let copy = 0; copy < 10; copy++) {
    await h.service.consume(incoming);
    await h.service.consume({ ...incoming, generation: 2 });
  }
  assert.equal(h.counts().sends, 2);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!.generation, 2);
  assert.equal([...h.rows.values()].some(row => row.entity_type === 'entitlement'), false);
});
test('scheduled replay recovers an uncertain send without relying on a stream or browser', async () => {
  const h = harness(); h.loseSend(); await h.service.checkout(h.request);
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  assert.equal(work.dispatch_status, 'claimed');
  h.clock(work.due_at); await h.service.replay();
  assert.equal(h.counts().sends, 2);
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!.dispatch_status, 'sent');
  await h.service.replay(); assert.equal(h.counts().sends, 2);
});
test('exhausted recovery retains repair evidence, leaves the due index, and does not discard late payment', async () => {
  const h = harness(); await h.service.checkout(h.request);
  const work = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  h.clock(work.deadline + 1); await assert.rejects(h.service.replay(), /billing_replay_item_failed/);
  const retained = [...h.rows.values()].find(row => row.entity_type === 'reconciliation_work')!;
  assert.equal(retained.state, 'repair_required'); assert.equal(retained.due_partition, undefined);
  const order = [...h.rows.values()].find(row => row.entity_type === 'order')!;
  h.paid(); await h.service.reconcileKey({ PK: order.PK, SK: order.SK });
  assert.equal([...h.rows.values()].find(row => row.entity_type === 'entitlement')!.allowed, true);
  assert.equal(h.counts().posts, 1);
});
