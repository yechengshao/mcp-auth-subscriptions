import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAccessRecord, validateAccessRecord } from '../../access/contracts/storage.js';
import { accessRecords } from '../fixtures/storage.js';

const unknownField = { written_by_newer_release: 'value' };

for (const [kind, value] of Object.entries(accessRecords)) {
  test(`access ${kind}: reads ignore unknown top-level fields and writes still reject them`, () => {
    readAccessRecord({ ...value, ...unknownField }, 'test');
    assert.throws(() => validateAccessRecord({ ...value, ...unknownField }, 'test'), /invalid_(contract|access_record)/);
  });

  test(`access ${kind}: reads still reject a wrong known field`, () => {
    assert.throws(() => readAccessRecord({ ...value, environment: 'prod' }, 'test'), /invalid_(contract|access_record)/);
    assert.throws(() => readAccessRecord({ ...value, revision: -1 }, 'test'), /invalid_(contract|access_record)/);
  });
}

test('reads still reject unknown sensitive names even though benign unknown fields are ignored', () => {
  for (const kind of Object.keys(accessRecords)) {
    for (const name of ['token', 'private_key', 'raw_refresh', 'local_destination']) {
      assert.throws(() => readAccessRecord({ ...accessRecords[kind], [name]: 'value' }, 'test'), /invalid_(contract|access_record)/, `${kind}.${name}`);
    }
  }
});

test('nested objects stay closed on read, so unknown fields inside them are still rejected', () => {
  const binding = accessRecords.subscriber_binding! as Record<string, unknown>;
  const mutation = binding.mutation as Record<string, unknown>;
  assert.throws(() => readAccessRecord({ ...binding, mutation: { ...mutation, unexpected: true } }, 'test'),
    /invalid_(contract|access_record)/);
});

test('a record that carries an unknown field can be rewritten from its known fields by an older release', () => {
  const stored = { ...accessRecords.grant_family!, ...unknownField };
  readAccessRecord(stored, 'test');
  const { written_by_newer_release: _dropped, ...rewritten } = stored;
  validateAccessRecord(rewritten, 'test');
});
