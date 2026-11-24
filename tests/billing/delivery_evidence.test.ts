import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Stripe from 'stripe';
import { composeBillingHandler } from '../../billing/handler.js';
import { BillingService } from '../../billing/service.js';
import { identityPartition } from '../../billing/contracts/validate.js';
import { Telemetry } from '../../observability/telemetry.js';
import { catalog as catalogFixture, environment, identity, now, message as queueMessage } from '../fixtures/contracts.js';
import { budgets, FakeQueue, FakeStripe, handlerConfig, MemoryBillingRepository, stripeAccount, webhookSecret } from '../fixtures/billing_memory.js';

/*
 * Delivery evidence for B013. The composed billing Lambda handles every trigger kind (HTTP webhook, SQS batch,
 * scheduled replay) against an in-memory repository, so these tests exercise the emitted handler rather than
 * the service in isolation. Clock is injectable so replay can advance past dispatch leases deterministically.
 */

function setup() {
  let clock = now;
  const telemetry = new Telemetry({ service: 'billing', environment: 'test', release: 'delivery_fixture' } as never,
    { sink: () => undefined, now: () => clock * 1000 });
  const repo = new MemoryBillingRepository(environment);
  const stripe = new FakeStripe();
  const queue = new FakeQueue();
  const readCatalog = async () => ({ catalog: catalogFixture, ssm_version: 1 }) as never;
  const service = new BillingService(repo, stripe, queue, readCatalog, stripeAccount, handlerConfig.supportEmail, budgets, telemetry, () => clock);
  const handler = composeBillingHandler(handlerConfig, service, telemetry, readCatalog, async () => webhookSecret);
  const purchase = {
    schema_version: 1, operation: 'createCheckout', environment, correlation_id: 'delivery_corr_fixture',
    idempotency_key: 'tx_delivery_fixture', continuation_ref: 'tx_delivery_fixture', identity,
    input: { plan_id: 'basic', duration_option_id: 'short', catalog_version: 'fixture_v1', intent: 'purchase' },
  };
  const deliver = (body: string, eventId = 'evt_fixture_1') => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret, timestamp: Math.floor(Date.now() / 1000) });
    return handler({ httpMethod: 'POST', path: '/billing/webhook', isBase64Encoded: false,
      headers: { 'stripe-signature': header }, body, requestContext: { requestId: eventId } } as never, {} as never) as Promise<{ statusCode: number }>;
  };
  const paidEvent = (eventId: string, sessionId: string) => JSON.stringify({
    id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, account: stripeAccount,
    data: { object: { id: sessionId } },
  });
  return { repo, stripe, queue, handler, purchase, deliver, paidEvent, advance: (seconds: number) => { clock = now + seconds; }, clock: () => clock };
}

const rowsOf = (repo: MemoryBillingRepository, type: string) => [...repo.rows.values()].filter(row => row.entity_type === type);

test('ten duplicate and concurrent webhook deliveries create one event, one subscription term and no second Checkout', async () => {
  const w = setup();
  const created = await w.handler({ ...w.purchase }, {} as never) as { outcome: string };
  assert.equal(created.outcome, 'ok');
  assert.equal(w.stripe.creates, 1);
  w.stripe.markPaid('cs_fixture_1');

  const body = w.paidEvent('evt_concurrent_1', 'cs_fixture_1');
  const statuses = await Promise.all(Array.from({ length: 10 }, () => w.deliver(body).then(r => r.statusCode, () => 500)));
  // A racing delivery may lose its conditional write. Stripe retries any non-2xx answer, and none of them activates access.
  assert.ok(statuses.every(status => status === 200 || status === 400 || status === 500), `unexpected statuses ${statuses.join(',')}`);
  assert.ok(statuses.includes(200), 'at least one delivery is accepted');

  assert.equal((await w.deliver(body)).statusCode, 200, 'a sequential redelivery after the race is accepted');
  assert.equal(rowsOf(w.repo, 'subscription').length, 1, 'exactly one subscription term');
  assert.equal(rowsOf(w.repo, 'decision_history').length, 1, 'exactly one decision record');
  assert.equal((await w.repo.get(w.repo.key(identity, 'ENTITLEMENT')))?.revision, 1, 'the entitlement is written once');
  assert.equal(w.stripe.creates, 1);
});

test('a partial SQS batch reports only the messages that must be retried', async () => {
  const w = setup();
  await w.handler({ ...w.purchase }, {} as never);
  const work = rowsOf(w.repo, 'reconciliation_work')[0]!;
  const queueArn = handlerConfig.queueArn;
  const ok = { ...queueMessage, durable_record_key: { PK: work.PK, SK: work.SK }, operation_id: work.operation_id,
    correlation_id: work.correlation_id, generation: work.generation };
  const missing = { ...queueMessage, durable_record_key: { PK: identityPartition(environment, identity.issuer, identity.subject), SK: 'WORK#absent' },
    operation_id: 'absent_operation' };
  const record = (messageId: string, body: string) => ({ messageId, eventSource: 'aws:sqs', eventSourceARN: queueArn, body });
  const response = await w.handler({ Records: [
    record('m_malformed', '{}'),
    record('m_missing_work', JSON.stringify(missing)),
    record('m_current', JSON.stringify(ok)),
  ] }, {} as never) as { batchItemFailures: Array<{ itemIdentifier: string }> };
  assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: 'm_malformed' }, { itemIdentifier: 'm_missing_work' }],
    'only the malformed and missing-work messages are retried; the current message succeeds');
});

test('the first reconciliation is delayed by the configured delay and never by more than fifteen minutes', async () => {
  const w = setup();
  await w.handler({ ...w.purchase }, {} as never);
  assert.deepEqual(w.queue.delays, [budgets.initial_delay_seconds]);
  assert.ok(w.queue.delays.every(delay => delay >= 0 && delay <= 900), 'SQS delay stays inside its maximum');
});

test('outbox replay resends a stalled dispatch only after its lease and grace window, and never fans out', async () => {
  const w = setup();
  await w.handler({ ...w.purchase }, {} as never);
  assert.equal(w.queue.messages.length, 1);

  // Within expected delivery + replay grace + visibility, the confirmed send must not be duplicated.
  w.advance(budgets.initial_delay_seconds + 1);
  await w.handler({ 'detail-type': 'Scheduled Event', source: 'aws.events', resources: [handlerConfig.replayRuleArn] } as never, {} as never);
  assert.equal(w.queue.messages.length, 1, 'an in-window replay does not duplicate the send');

  // After the window, replay resends exactly once; an immediate second replay sees the fresh confirmed send.
  w.advance(budgets.initial_delay_seconds + budgets.delivery_replay_grace_seconds + budgets.visibility_timeout_seconds + 1);
  await w.handler({ 'detail-type': 'Scheduled Event', source: 'aws.events', resources: [handlerConfig.replayRuleArn] } as never, {} as never);
  assert.equal(w.queue.messages.length, 2, 'an expired send is replayed once');
  await w.handler({ 'detail-type': 'Scheduled Event', source: 'aws.events', resources: [handlerConfig.replayRuleArn] } as never, {} as never);
  assert.equal(w.queue.messages.length, 2, 'a second replay does not fan out');
});

test('the reconciliation DLQ receives a message only after five receives and accepts redrive only from its own queue', () => {
  const runtime = JSON.parse(readFileSync('infra/billing/runtime.yaml', 'utf8')) as {
    Resources: Record<string, { Properties: Record<string, any> }>;
  };
  const queue = runtime.Resources.Queue!.Properties;
  const dlq = runtime.Resources.DeadLetterQueue!.Properties;
  assert.equal(queue.RedrivePolicy.maxReceiveCount, 5);
  assert.deepEqual(queue.RedrivePolicy.deadLetterTargetArn, { 'Fn::GetAtt': ['DeadLetterQueue', 'Arn'] });
  assert.equal(dlq.MessageRetentionPeriod, 1209600, 'DLQ retains evidence for fourteen days');
  assert.equal(dlq.RedriveAllowPolicy.redrivePermission, 'byQueue');
  assert.equal(dlq.RedriveAllowPolicy.sourceQueueArns.length, 1, 'only the reconciliation queue may redrive');
  assert.equal(queue.VisibilityTimeout, 185, 'visibility covers the processing lease and one reconciliation run');
});
