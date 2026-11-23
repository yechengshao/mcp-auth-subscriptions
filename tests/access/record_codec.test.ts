import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, encodeRecord, validateStoredRecord } from '../../access/adapters/record-codec.js';
import { accessRecords } from '../fixtures/storage.js';
import { environment } from '../fixtures/contracts.js';

test('the adapter stamps the current schema version and the validator accepts the result', () => {
  const { schema_version: _ignored, ...domainRow } = accessRecords.subscriber_binding! as Record<string, unknown>;
  const encoded = encodeRecord(domainRow);
  assert.equal(encoded.schema_version, SCHEMA_VERSION);
  validateStoredRecord(encoded, environment);
});

test('a stored record with an unknown schema version fails validation', () => {
  const stored = { ...accessRecords.subscriber_binding!, schema_version: 99 };
  assert.throws(() => validateStoredRecord(stored, environment));
});

test('a stored record without a schema version fails validation', () => {
  const { schema_version: _ignored, ...unversioned } = accessRecords.subscriber_binding! as Record<string, unknown>;
  assert.throws(() => validateStoredRecord(unversioned, environment));
});
