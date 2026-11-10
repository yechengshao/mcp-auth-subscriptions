import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Telemetry } from '../../observability/telemetry.js';
import { parseXray, xrayHeader, header } from '../../observability/context.js';
import { configFromEnvironment } from '../../observability/config.js';
import { withHttpTelemetry, withAuthorizerTelemetry, withNativeTelemetry, withSqsRecordTelemetry, withReplayTelemetry,
  propagateNative, propagateSqs } from '../../observability/adapters.js';
import { validateOperation } from '../../billing/contracts/validate.js';
import { message, operation as nativeFixture } from '../fixtures/contracts.js';
const SECRET = 'NEVER_LOG_TOKEN_COOKIE_PRIVATE_KEY_PAYMENT';
const parent = 'Root=1-6a000000-123456789012345678901234;Parent=1234567890abcdef;Sampled=1';
function setup(service: 'access' | 'billing' | 'authorizer' = 'access', metrics = false) {
  const logs: string[] = [];
  return { telemetry: new Telemetry({ service, environment: 'test', release: 'v1', metrics }, { sink: line => { logs.push(line); } }), logs };
}

test('HTTP logging preserves existing AWS identifiers and business responses without secret capture', async () => {
  const { telemetry, logs } = setup();
  const handler = withHttpTelemetry(telemetry, 'http.token', async () => ({ statusCode: 200, body: SECRET,
    headers: { 'Set-Cookie': SECRET, 'X-Correlation-Id': 'stale' }, multiValueHeaders: { 'Set-Cookie': [SECRET], 'x-correlation-id': ['stale'] } }));
  const result = await handler({ headers: { Authorization: SECRET, Cookie: SECRET, 'x-correlation-id': 'corr_fixture', 'x-amzn-trace-id': parent },
    requestContext: { requestId: 'gateway_fixture' } }, { awsRequestId: 'lambda_fixture' });
  assert.equal(result.body, SECRET); assert.equal(result.headers!['Set-Cookie'], SECRET);
  assert.equal(result.headers!['x-correlation-id'], 'corr_fixture'); assert.ok(!('X-Correlation-Id' in result.headers!));
  assert.deepEqual(result.multiValueHeaders, { 'Set-Cookie': [SECRET] });
  const record = JSON.parse(logs[0]!);
  assert.equal(record.correlation_id, 'corr_fixture'); assert.equal(record.request_id, 'lambda_fixture');
  assert.equal(record.gateway_request_id, 'gateway_fixture'); assert.equal(record.trace_id, '1-6a000000-123456789012345678901234');
  assert.equal(record.trace_parent_id, '1234567890abcdef'); assert.ok(!('span_id' in record));
  assert.ok(!logs.join('').includes(SECRET));
});

test('native and delayed SQS relays keep correlation and AWS context without generating spans', async () => {
  const access = setup(), billing = setup('billing');
  let record: { messageId: string; body: string; attributes: { AWSTraceHeader: string } } | undefined;
  const billingHandler = withNativeTelemetry(billing.telemetry, async event => {
    validateOperation(event, 'test');
    await billing.telemetry.dependency('sqs.publish', async () => {
      const body = JSON.stringify({ ...message, correlation_id: billing.telemetry.currentCorrelationId() });
      const sent = propagateSqs(billing.telemetry, { MessageBody: body });
      const forwarded = sent.MessageSystemAttributes!.AWSTraceHeader as { StringValue: string };
      record = { messageId: 'message_fixture', body, attributes: { AWSTraceHeader: forwarded.StringValue } };
    });
    return 'unchanged';
  });
  const handler = withHttpTelemetry(access.telemetry, 'http.authorize', async () => {
    const result = await billingHandler(propagateNative(access.telemetry, nativeFixture), {});
    assert.equal(result, 'unchanged'); return { statusCode: 200 };
  });
  await handler({ headers: { 'x-amzn-trace-id': parent, 'x-correlation-id': 'workflow_fixture' } }, {});
  assert.ok(record); assert.equal(record.attributes.AWSTraceHeader, parent);
  await withSqsRecordTelemetry(billing.telemetry, async () => {
    assert.equal(billing.telemetry.currentTraceHeader(), parent);
    billing.telemetry.log('transition', 'billing.reconcile', 'entitlement_committed');
  })(record, {});
  assert.equal(JSON.parse(billing.logs.at(-1)!).correlation_id, 'workflow_fixture');
  assert.equal(billing.telemetry.currentCorrelationId(), undefined);
});

test('concurrent requests and nested replay records isolate and restore diagnostic context', async () => {
  const { telemetry, logs } = setup('billing');
  await telemetry.observe('billing.replay', { correlationId: 'outer' }, async () => {
    await Promise.all(['saved_a','saved_b'].map(id => telemetry.observe('billing.reconcile', { correlationId: id }, async () => {
      await Promise.resolve(); telemetry.log('transition', 'billing.reconcile', 'entitlement_committed');
      assert.equal(telemetry.currentCorrelationId(), id);
    })));
    assert.equal(telemetry.currentCorrelationId(), 'outer');
  });
  assert.equal(telemetry.currentCorrelationId(), undefined);
  const records = logs.map(line => JSON.parse(line)).filter(r => r.outcome === 'entitlement_committed');
  assert.deepEqual(new Set(records.map(r => r.correlation_id)), new Set(['saved_a','saved_b']));
});

test('missing or malformed tracking metadata never manufactures an X-Ray trace', async () => {
  const { telemetry, logs } = setup();
  await telemetry.observe('http.status', { correlationId: `bad\n${SECRET}` }, async () => {
    assert.equal(telemetry.currentTraceHeader(), undefined);
    assert.match(telemetry.currentCorrelationId()!, /^[A-Za-z0-9_-]{1,64}$/);
  });
  assert.ok(!('trace_id' in JSON.parse(logs[0]!)));
  assert.equal(parseXray(parent+';Parent=aaaaaaaaaaaaaaaa'), undefined);
  assert.equal(parseXray(parent.replace(';Parent=', '=junk;Parent=')), undefined);
  assert.equal(header({ 'X-Correlation-Id': 'a', 'x-correlation-id': 'b' }, 'x-correlation-id'), undefined);
  assert.ok(!logs.join('').includes(SECRET));
});

test('unsampled AWS context is relayed unchanged but not advertised as a captured trace', async () => {
  const { telemetry, logs } = setup();
  const unsampled = parent.replace('Sampled=1','Sampled=0');
  await telemetry.observe('http.status', { parent: parseXray(unsampled)! }, async () => assert.equal(telemetry.currentTraceHeader(), unsampled));
  assert.ok(!('trace_id' in JSON.parse(logs[0]!)));
  assert.deepEqual(parseXray(xrayHeader(parseXray(parent)!)), parseXray(parent));
});

test('HTTP errors keep OAuth shape and sanitized stack locations including multiline messages', async () => {
  const { telemetry, logs } = setup();
  const error = new Error(`provider failed\n    at ${SECRET} (/private/${SECRET}.js:1:2)`);
  const result = await withHttpTelemetry(telemetry, 'http.token', async () => { throw error; })({}, {});
  assert.equal(result.statusCode, 500); assert.equal(result.headers!['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body!), { error: 'server_error' });
  const failures = logs.map(line => JSON.parse(line)).filter(record => record.level === 'ERROR');
  assert.equal(failures.length, 1); assert.ok(failures[0].duration_ms >= 0);
  assert.ok(!logs.join('').includes(SECRET));
});

test('authorizer preserves expected denials and sanitizes unexpected platform errors', async () => {
  const { telemetry, logs } = setup('authorizer');
  await assert.rejects(withAuthorizerTelemetry(telemetry, async () => { throw new Error('Unauthorized'); })({}, {}), { message: 'Unauthorized' });
  assert.ok(!logs.some(line => JSON.parse(line).level === 'ERROR'));
  await assert.rejects(withAuthorizerTelemetry(telemetry, async () => { throw new Error(SECRET); })({}, {}), { message: 'authorizer_failed' });
  assert.ok(!logs.join('').includes(SECRET));
});

test('native/SQS/replay errors retain retry behavior without raw provider errors', async () => {
  const { telemetry, logs } = setup('billing');
  const fail = async () => { throw new Error(SECRET); };
  const result = await withNativeTelemetry(telemetry, fail)(nativeFixture, {});
  assert.equal(result.outcome, 'retryable_unavailable');
  await assert.rejects(withSqsRecordTelemetry(telemetry, fail)({ messageId: 'message_fixture', body: JSON.stringify(message) }, {}), { message: 'billing_record_failed' });
  await assert.rejects(withReplayTelemetry(telemetry, fail)({}, {}), { message: 'billing_replay_failed' });
  assert.ok(!logs.join('').includes(SECRET));
});

test('logging failures and malformed stack getters never alter business results', async () => {
  const brokenSink = new Telemetry({ service: 'access', environment: 'test', release: 'v1' }, { sink: () => { throw new Error(SECRET); } });
  assert.equal(await brokenSink.observe('http.status', {}, async () => 42), 42);
  const { telemetry, logs } = setup();
  const error = new Error(SECRET); Object.defineProperty(error, 'stack', { get() { throw error; } });
  await withHttpTelemetry(telemetry, 'http.token', async () => { throw error; })({}, {});
  const record = logs.map(line => JSON.parse(line)).find(record => record.outcome === 'server_error');
  assert.deepEqual(record.frames, []); assert.ok(!logs.join('').includes(SECRET));
});

test('CloudWatch EMF has four bounded fixed series without an SDK', () => {
  const access = setup('access', true), billing = setup('billing', true);
  access.telemetry.metric('AccessProvisioningFailureCount', 1); access.telemetry.metric('AccessProvisioningAttemptLatencyMs', 23);
  billing.telemetry.metric('BillingWebhookCommitFailureCount', 1); billing.telemetry.metric('BillingReconcileDueAgeSeconds', 60);
  access.telemetry.metric(SECRET, 1); access.telemetry.metric('BillingReconcileDueAgeSeconds', 1);
  access.telemetry.metric('AccessProvisioningFailureCount', NaN);
  const records = [...access.logs,...billing.logs].map(line => JSON.parse(line)); assert.equal(records.length, 4);
  for (const record of records) {
    assert.deepEqual(record._aws.CloudWatchMetrics[0].Dimensions, [['service','environment']]);
    assert.equal(record._aws.CloudWatchMetrics[0].Metrics[0].StorageResolution, 60);
    assert.ok(!('correlation_id' in record));
  }
  const dev = setup(); dev.telemetry.metric('AccessProvisioningFailureCount', 1); assert.equal(dev.logs.length, 0);
});

test('Lambda reserved trace context is read per invocation and is not cached', async () => {
  const previous = process.env._X_AMZN_TRACE_ID;
  const { telemetry, logs } = setup();
  const handler = withHttpTelemetry(telemetry, 'http.status', async () => { telemetry.log('transition','http.status','binding_configured'); return { statusCode: 200 }; });
  try {
    process.env._X_AMZN_TRACE_ID = parent; await handler({}, {});
    process.env._X_AMZN_TRACE_ID = parent.replace('1234567890abcdef','abcdef1234567890'); await handler({}, {});
    const records = logs.map(line => JSON.parse(line)).filter(record => record.outcome === 'binding_configured');
    assert.deepEqual(records.map(record => record.trace_parent_id), ['1234567890abcdef','abcdef1234567890']);
  } finally { if (previous === undefined) delete process.env._X_AMZN_TRACE_ID; else process.env._X_AMZN_TRACE_ID = previous; }
});

test('application has no OpenTelemetry or trace-export runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@aws-sdk/client-api-gateway', '@aws-sdk/client-dynamodb', '@aws-sdk/client-lambda', '@aws-sdk/client-sqs', '@aws-sdk/client-ssm', '@aws-sdk/lib-dynamodb', '@codegenie/serverless-express', 'ajv', 'express', 'jose', 'stripe']);
  assert.equal(configFromEnvironment('billing', {}).environment, 'development');
  assert.throws(() => configFromEnvironment('billing', { MCP_SERVICE: 'access' }));
});
