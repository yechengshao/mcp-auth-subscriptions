import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessStore } from '../../access/store.js';
import { transitionTransaction } from '../../access/transitions.js';
import { Telemetry } from '../../observability/telemetry.js';
import { accessRecords } from '../fixtures/storage.js';

const telemetry = () => new Telemetry({ service: 'access', environment: 'test', release: 'race_fixture' }, { sink: () => undefined });
const keyOf = (item: { PK: string; SK: string }) => `${item.PK}|${item.SK}`;

/** A DynamoDB stand-in that evaluates the revision conditions the store sends, atomically per transaction. */
class RevisionDb {
  readonly items = new Map<string, Record<string, any>>();
  async send(command: { constructor: { name: string }; input: any }) {
    if (command.constructor.name === 'GetCommand') return { Item: this.items.get(keyOf(command.input.Key)) };
    if (command.constructor.name !== 'TransactWriteCommand') throw new Error('unexpected_command');
    const writes: Array<() => void> = [];
    for (const { Put, ConditionCheck } of command.input.TransactItems) {
      const target = Put ? Put.Item : ConditionCheck.Key;
      const existing = this.items.get(keyOf(target));
      const expected = (Put ? Put : ConditionCheck).ExpressionAttributeValues?.[':revision'];
      const ok = expected === undefined ? existing === undefined : existing?.revision === expected;
      if (!ok) { const error = new Error('conditional check failed'); error.name = 'TransactionCanceledException'; throw error; }
      if (Put) writes.push(() => this.items.set(keyOf(Put.Item), Put.Item));
    }
    writes.forEach(write => write());
    return {};
  }
}

test('two owners advancing the same transaction revision race: exactly one write lands and the other is a conflict', async () => {
  const db = new RevisionDb();
  const seeded = { ...accessRecords.transaction!, revision: 1 } as Record<string, any>;
  db.items.set(keyOf(seeded as { PK: string; SK: string }), seeded);
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), db as any);
  const loadedByA = await store.get({ PK: seeded.PK, SK: seeded.SK });
  const loadedByB = await store.get({ PK: seeded.PK, SK: seeded.SK });
  assert.ok(loadedByA && loadedByB);

  const attempt = (loaded: any) => store.commit([{ row: transitionTransaction(loaded, 'failed'), expectedRevision: loaded.revision }]);
  const results = await Promise.allSettled([attempt(loadedByA), attempt(loadedByB)]);

  const won = results.filter(result => result.status === 'fulfilled');
  const lost = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one owner may advance the transaction');
  assert.equal(lost.length, 1);
  assert.equal((lost[0]!.reason as Error).name, 'TransactionCanceledException');
  const stored = db.items.get(keyOf(seeded as { PK: string; SK: string }))!;
  assert.equal(stored.revision, 2);
  assert.equal(stored.phase, 'failed');
});

test('a stale owner cannot resurrect a transaction the winner already moved past', async () => {
  const db = new RevisionDb();
  const seeded = { ...accessRecords.transaction!, revision: 1 } as Record<string, any>;
  db.items.set(keyOf(seeded as { PK: string; SK: string }), seeded);
  const store = new AccessStore('test', 'state', 'entitlements', telemetry(), db as any);
  const stale = await store.get({ PK: seeded.PK, SK: seeded.SK });
  await store.commit([{ row: transitionTransaction(stale!, 'failed'), expectedRevision: 1 }]);
  await assert.rejects(store.commit([{ row: transitionTransaction(stale!, 'failed'), expectedRevision: 1 }]),
    (error: Error) => error.name === 'TransactionCanceledException');
  assert.equal(db.items.get(keyOf(seeded as { PK: string; SK: string }))!.revision, 2);
});
