import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observabilityTemplate, gatewayStageSettings, lambdaTelemetrySettings } from '../../infra/observability/template.js';
type Resource = { Type: string; Condition?: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: Record<string, unknown> };
const template = observabilityTemplate() as { Parameters: Record<string, Record<string, unknown>>; Conditions: Record<string, unknown>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
function conditions(environment: string, tracing = 'auto', alarms = 'false') {
  const parameters: Record<string, string> = { Environment: environment, Tracing: tracing, EnableAlarms: alarms };
  const evaluate = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const entry = value as Record<string, unknown>;
    if (typeof entry.Ref === 'string') return parameters[entry.Ref];
    if (typeof entry.Condition === 'string') return evaluate(template.Conditions[entry.Condition]);
    if (Array.isArray(entry['Fn::Equals'])) { const [a,b] = entry['Fn::Equals']; return evaluate(a) === evaluate(b); }
    if (Array.isArray(entry['Fn::And'])) return entry['Fn::And'].every(item => evaluate(item));
    if (Array.isArray(entry['Fn::Or'])) return entry['Fn::Or'].some(item => evaluate(item));
    return undefined;
  };
  return Object.fromEntries(Object.entries(template.Conditions).map(([name,value]) => [name, evaluate(value)]));
}

test('committed template matches its typed source and monitoring resource inventory', () => {
  const generated = JSON.parse(readFileSync(new URL('../../../infra/observability/template.json', import.meta.url), 'utf8'));
  assert.deepEqual(generated, template);
  const resources = Object.values(template.Resources);
  assert.equal(resources.filter(r => r.Type === 'AWS::Logs::LogGroup').length, 5);
  assert.equal(resources.filter(r => r.Type === 'AWS::CloudWatch::Alarm').length, 10);
  assert.equal(resources.filter(r => r.Type === 'AWS::CloudWatch::Dashboard').length, 1);
  assert.equal(resources.filter(r => r.Type === 'AWS::XRay::SamplingRule').length, 1);
  assert.ok(!resources.some(r => /AWS::Lambda::Function|AWS::DynamoDB|AWS::SQS|AWS::SNS::Subscription|AWS::ApiGateway::Account|AWS::ApiGateway::Stage/.test(r.Type)));
});
test('economical profiles retain finite logs and disable nonproduction tracing by default', () => {
  assert.equal(conditions('development').TracingEnabled, false);
  assert.equal(conditions('test').TracingEnabled, false);
  assert.equal(conditions('production').TracingEnabled, true);
  assert.equal(conditions('development','enabled').TracingEnabled, true);
  assert.equal(conditions('production','disabled').TracingEnabled, false);
  assert.equal(conditions('development').Production, false);
  assert.equal(conditions('production').Production, true);
  assert.equal(conditions('production').AlarmsEnabled, false);
  assert.equal(conditions('production','auto','true').AlarmsEnabled, true);
  for (const resource of Object.values(template.Resources).filter(r => r.Type === 'AWS::Logs::LogGroup')) {
    assert.deepEqual(resource.Properties.RetentionInDays, { 'Fn::If': ['Production',14,3] });
    assert.equal(resource.DeletionPolicy, 'Retain');
  }
  const rule = template.Resources.GatewaySampling!.Properties.SamplingRule as Record<string, unknown>;
  assert.equal(rule.FixedRate, .01); assert.equal(rule.ReservoirSize, 0);
  assert.ok(JSON.stringify(rule.ResourceARN).includes('${RestApiId}/stages/${StageName}'));
});
test('function telemetry policies are scoped to own logs with conditional export-only X-Ray rights', () => {
  for (const name of ['Access','Authorizer','Billing']) {
    const policy = template.Resources[`${name}TelemetryPolicy`]!.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    assert.deepEqual(policy.Statement[0]!.Action, ['logs:CreateLogStream','logs:PutLogEvents']);
    assert.ok(JSON.stringify(policy.Statement[0]!.Resource).includes(`\${${name}FunctionName}`));
    const conditional = policy.Statement[1]!['Fn::If'] as unknown[];
    assert.equal(conditional[0], 'TracingEnabled');
    assert.deepEqual(conditional[1], { Effect: 'Allow', Action: ['xray:PutTraceSegments','xray:PutTelemetryRecords'], Resource: '*' });
    assert.ok(!JSON.stringify(policy).includes('dynamodb:')); assert.ok(!JSON.stringify(policy).includes('lambda:InvokeFunction'));
  }
});
test('gateway fragment disables body tracing and detailed metrics without owning the stage/account', () => {
  const format = template.Outputs.GatewayAccessFormat!.Value as string;
  const stage = gatewayStageSettings('LOG_ARN', format, true);
  assert.deepEqual(stage.MethodSettings, [{ ResourcePath: '/*', HttpMethod: '*', DataTraceEnabled: false, LoggingLevel: 'ERROR', MetricsEnabled: false }]);
  for (const forbidden of ['Authorization','Cookie','queryString','identity','authorizer','integrationErrorMessage']) assert.ok(!format.includes(forbidden));
  const policy = JSON.stringify(template.Resources.GatewayTelemetryPolicy);
  assert.ok(policy.includes('API-Gateway-Execution-Logs_')); assert.ok(policy.includes('/access'));
});
test('native alarms use fixed dimensions, supplied thresholds and a single shared dashboard', () => {
  for (const alarm of Object.values(template.Resources).filter(r => r.Type === 'AWS::CloudWatch::Alarm')) {
    assert.equal(alarm.Condition, 'AlarmsEnabled');
    assert.deepEqual(alarm.Properties.AlarmActions, [{ Ref: 'NotificationTopicArn' }]);
    assert.deepEqual(alarm.Properties.TreatMissingData, { Ref: 'MissingDataPolicy' });
    assert.ok(typeof alarm.Properties.Threshold === 'object');
    for (const forbidden of ['correlation_id','user_id','order_id']) assert.ok(!JSON.stringify(alarm).includes(forbidden));
  }
  assert.equal(template.Resources.Dashboard!.Condition, 'Production');
  const fragment = lambdaTelemetrySettings('Active','billing','production','v1');
  assert.equal(fragment.Environment.Variables.MCP_SERVICE, 'billing');
  assert.deepEqual(fragment.TracingConfig, { Mode: 'Active' });
  assert.throws(() => lambdaTelemetrySettings('Active','unknown','test','v1'));
});
