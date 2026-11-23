import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_SCHEMA_VERSIONS, WRITE_SCHEMA_VERSION, encodeRecord, validateStoredRecord } from '../../access/adapters/record-codec.js';
import { accessRecords } from '../fixtures/storage.js';
import { environment } from '../fixtures/contracts.js';

test('the write version is stamped by the adapter and is always readable', () => {
  assert.ok(READ_SCHEMA_VERSIONS.includes(WRITE_SCHEMA_VERSION));
  const { schema_version: _ignored, ...domainRow } = accessRecords.subscriber_binding! as Record<string, unknown>;
  const encoded = encodeRecord(domainRow);
  assert.equal(encoded.schema_version, WRITE_SCHEMA_VERSION);
  validateStoredRecord(encoded, environment);
});

test('a stored record with an unknown schema version fails closed', () => {
  const stored = { ...accessRecords.subscriber_binding!, schema_version: 99 };
  assert.throws(() => validateStoredRecord(stored, environment), /invalid_access_record_schema_version/);
});

test('a stored record without a schema version is not accepted as the current version', () => {
  const { schema_version: _ignored, ...unversioned } = accessRecords.subscriber_binding! as Record<string, unknown>;
  assert.throws(() => validateStoredRecord(unversioned, environment), /invalid_access_record_schema_version/);
});
