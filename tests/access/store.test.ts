import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessStore } from '../../access/store.js';
import { Telemetry } from '../../observability/telemetry.js';
import { accessRecords } from '../fixtures/storage.js';
import { identity, entitlement } from '../fixtures/contracts.js';
const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'fixture' }, { sink: () => undefined });
test('state adapter reads strongly and cannot write the billing entitlement table', async () => {
  const commands: any[] = [];
  const db = { send: async (command: any) => { commands.push(command.input); return { Item: command.input.TableName === 'entitlements' ? entitlement : accessRecords.session }; } };
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), db as any);
  await store.get({ PK: accessRecords.session!.PK as string, SK: 'SESSION' });
  await store.entitlement(identity);
  assert.equal(commands.every(command => command.ConsistentRead), true);
  await assert.rejects(store.commit([{ row: entitlement }]));
  assert.equal(commands.length, 2);
});
test('access writes are revision-fenced and projection authority participates only as a condition check', async () => {
  const commands: any[] = [];
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), { send: async (command: any) => { commands.push(command.input); return {}; } } as any);
  const row = { ...accessRecords.session!, revision: 2 };
  await store.commit([{ row, expectedRevision: 1 }], [{ key: { PK: entitlement.PK, SK: 'ENTITLEMENT' }, projection: true, expectedRevision: 1 }]);
  const items = commands[0].TransactItems;
  assert.equal(items[0].Put.TableName, 'state'); assert.equal(items[0].Put.ConditionExpression, '#revision = :revision');
  assert.equal(items[1].ConditionCheck.TableName, 'entitlements');
  await assert.rejects(store.commit([{ row: { ...row, delete_after: 0 }, expectedRevision: 1 }]));
  assert.equal(commands.length, 1);
});
test('profile creation races consistently reuse the winning stable subscriber ID without TTL', async () => {
  let reads = 0;
  const winner = accessRecords.identity_profile!;
  const db = { send: async (command: any) => {
    if (command.constructor.name === 'GetCommand') return { Item: reads++ ? winner : undefined };
    const error = new Error('race'); error.name = 'TransactionCanceledException'; throw error;
  } };
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), db as any);
  const profile = await store.ensureProfile(identity);
  assert.equal(profile.subscriber_id, winner.subscriber_id); assert.equal(profile.delete_after, undefined);
});
test('cross-environment and foreign-row reads fail before exposing authority', async () => {
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), { send: async () => ({ Item: { ...entitlement, identity_subject: 'foreign' } }) } as any);
  await assert.rejects(store.get({ PK: 'ENV#production#TX#foreign', SK: 'STATE' }), /invalid_access_key/);
  await assert.rejects(store.entitlement(identity), /entitlement_owner_mismatch/);
});
