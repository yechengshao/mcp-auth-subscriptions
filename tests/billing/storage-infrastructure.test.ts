import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = () => JSON.parse(readFileSync('infra/billing/storage.yaml', 'utf8'));
test('billing storage retains exactly two encrypted on-demand tables without financial TTL', () => {
  const t = template();
  const tables = Object.values(t.Resources).filter((r: any) => r.Type === 'AWS::DynamoDB::Table') as any[];
  assert.equal(tables.length, 2);
  for (const r of tables) {
    assert.equal(r.DeletionPolicy, 'Retain');
    assert.equal(r.UpdateReplacePolicy, 'Retain');
    assert.equal(r.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.equal(r.Properties.DeletionProtectionEnabled, true);
    assert.equal(r.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
    assert.equal(r.Properties.TimeToLiveSpecification, undefined);
    assert.deepEqual(r.Properties.KeySchema, [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }]);
  }
  assert.equal(t.Resources.BillingState.Properties.StreamSpecification.StreamViewType, 'NEW_IMAGE');
  assert.equal(t.Resources.BillingEntitlements.Properties.StreamSpecification, undefined);
  assert.deepEqual(t.Resources.BillingState.Properties.GlobalSecondaryIndexes, [{ IndexName: 'DueWork', KeySchema: [{ AttributeName: 'due_partition', KeyType: 'HASH' }, { AttributeName: 'due_sort', KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } }]);
});
test('projection read policy cannot read payment records or mutate eligibility', () => {
  const t = template();
  assert.deepEqual(t.Resources.AccessEntitlementPolicy.Properties.PolicyDocument.Statement, [{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], Resource: { 'Fn::GetAtt': ['BillingEntitlements', 'Arn'] } }]);
  const text = JSON.stringify(t);
  for (const denied of ['dynamodb:Scan', 'dynamodb:*', 'AWS::Lambda::Function', 'AWS::Pipes::Pipe', 'AWS::SQS::Queue', 'AWS::KMS::Key']) assert.equal(text.includes(denied), false);
  assert.equal(text.includes('cognito'), false);
});
test('future Pipe filter admits only work INSERTs and exposes only reference outputs', () => {
  const t = template();
  const filter = JSON.parse(t.Outputs.ReconciliationInsertFilter.Value);
  assert.deepEqual(filter.eventName, ['INSERT']);
  assert.deepEqual(filter.dynamodb.Keys.SK.S, [{ prefix: 'WORK#' }]);
  assert.deepEqual(filter.dynamodb.NewImage.entity_type.S, ['reconciliation_work']);
  assert.deepEqual(filter.dynamodb.NewImage.kind.S, ['reconcile_payment']);
  assert.deepEqual(filter.dynamodb.NewImage.schema_version.N, ['1']);
  assert.deepEqual(t.Outputs.BillingStreamArn.Value, { 'Fn::GetAtt': ['BillingState', 'StreamArn'] });
  assert.ok(t.Outputs.BillingStoragePolicyArn);
  assert.ok(t.Outputs.AccessEntitlementPolicyArn);
});
