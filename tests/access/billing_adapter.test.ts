import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { BillingAliasInvoker, BillingInvocationFailure } from '../../access/adapters/billing.js';
import { Telemetry } from '../../observability/telemetry.js';
import { parseXray } from '../../observability/context.js';

const aliasArn = 'arn:aws:lambda:us-east-1:000000000000:function:billing-test:live';
const identity = { issuer: 'https://cognito.example.invalid/pool', subject: 'verified-subject_fixture' };
const success = (correlation_id: string) => ({ schema_version: 1, correlation_id, outcome: 'ok', retryable: false,
  message: 'Available plans.', payload: { catalog_version: 'fixture_v1', plans: [] } });

function fixture(reply: unknown = success('billing_corr_fixture')) {
  const commands: Array<{ input: Record<string, unknown>; abortSignal?: AbortSignal }> = [];
  let thrown: unknown;
  const client = { async send(command: { input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) {
    commands.push({ input: structuredClone(command.input), ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}) });
    if (thrown) throw thrown;
    return { StatusCode: 200, Payload: Buffer.from(JSON.stringify(reply)) };
  } } as unknown as LambdaClient;
  const lines: string[] = [];
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'billing_adapter_fixture' }, { sink: line => lines.push(line) });
  const invoker = new BillingAliasInvoker(telemetry, { environment: 'test', accountId: '000000000000', aliasArn, timeoutMs: 2500 }, client);
  return { invoker, commands, lines, setThrown(value: unknown) { thrown = value; } };
}
const call = { operation: 'listPlans' as const, identity, idempotencyKey: 'tx_fixture', continuationRef: 'tx_fixture', input: {} };

test('billing alias adapter validates IAM envelope and result while relaying the existing correlation and X-Ray context', async () => {
  const value = fixture();
  const result = await value.invoker['telemetry'].observe('http.billing', {
    correlationId: 'billing_corr_fixture', parent: parseXray('Root=1-abcdef12-0123456789abcdef01234567;Parent=0123456789abcdef;Sampled=1')!,
  }, () => value.invoker.invoke(call));
  assert.equal(result.outcome, 'ok');
  assert.equal(value.commands.length, 1);
  const command = value.commands[0]!.input;
  assert.equal(command.FunctionName, aliasArn);
  assert.equal(command.InvocationType, 'RequestResponse');
  const envelope = JSON.parse(Buffer.from(command.Payload as Uint8Array).toString('utf8')) as Record<string, unknown>;
  assert.equal(envelope.environment, 'test');
  assert.equal(envelope.correlation_id, 'billing_corr_fixture');
  assert.deepEqual(envelope.identity, identity);
  assert.equal(envelope.continuation_ref, 'tx_fixture');
  assert.deepEqual(envelope.trace_context, { 'x-amzn-trace-id': 'Root=1-abcdef12-0123456789abcdef01234567;Parent=0123456789abcdef;Sampled=1' });
  assert.deepEqual(envelope.input, {});
});

test('billing result correlation mismatch, malformed responses, and Lambda function errors fail closed', async () => {
  for (const reply of [success('other_correlation'), { arbitrary: 'value' }]) {
    const value = fixture(reply);
    await assert.rejects(value.invoker.invoke(call), error => error instanceof BillingInvocationFailure && error.kind === 'invalid_response');
  }
  const value = fixture(); value.setThrown(Object.assign(new Error('sensitive lambda response'), { name: 'RemoteException' }));
  await assert.rejects(value.invoker.invoke(call), error => error instanceof BillingInvocationFailure &&
    error.kind === 'unavailable' && !error.message.includes('sensitive'));
  const functionErrorClient = { send: async () => ({ StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from('secret') }) } as unknown as LambdaClient;
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'function_error_fixture' }, { sink: () => undefined });
  const functionError = new BillingAliasInvoker(telemetry, { environment: 'test', accountId: '000000000000', aliasArn }, functionErrorClient);
  await assert.rejects(functionError.invoke(call), error => error instanceof BillingInvocationFailure && error.kind === 'invalid_response');
});

test('billing call cannot use unqualified function names, missing purchase continuations, or invalid operation bodies', async () => {
  const telemetry = new Telemetry({ service: 'access', environment: 'test', release: 'bad_configuration_fixture' }, { sink: () => undefined });
  assert.throws(() => new BillingAliasInvoker(telemetry, { environment: 'test', accountId: '000000000000', aliasArn: aliasArn.replace(':live', '') }), /invalid_billing_invocation_configuration/);
  assert.throws(() => new BillingAliasInvoker(telemetry, { environment: 'test', accountId: '111111111111', aliasArn }), /invalid_billing_invocation_configuration/);
  const value = fixture();
  const { continuationRef: _continuation, ...withoutContinuation } = call;
  await assert.rejects(value.invoker.invoke(withoutContinuation), error =>
    error instanceof BillingInvocationFailure && error.kind === 'configuration');
  await assert.rejects(value.invoker.invoke({ ...call, operation: 'listPlans', input: { forged_price: 'secret' } }), error =>
    error instanceof BillingInvocationFailure && error.kind === 'configuration');
  assert.equal(value.commands.length, 0);
});
