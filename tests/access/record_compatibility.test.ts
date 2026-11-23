import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAccessRecord } from '../../access/contracts/storage.js';
import { accessRecords } from '../fixtures/storage.js';

const unknownField = { written_by_newer_release: 'value' };

for (const [kind, value] of Object.entries(accessRecords)) {
  test(`access ${kind}: unknown top-level fields are accepted and carried through unchanged`, () => {
    const stored: Record<string, unknown> = { ...value, ...unknownField };
    validateAccessRecord(stored, 'test');
    // A rewrite from a loaded record keeps the newer field instead of dropping it.
    const rewritten: Record<string, unknown> = { ...stored, revision: (value.revision as number) + 1 };
    validateAccessRecord(rewritten, 'test');
    assert.equal(rewritten.written_by_newer_release, 'value');
  });

  test(`access ${kind}: declared fields are still checked`, () => {
    assert.throws(() => validateAccessRecord({ ...value, environment: 'prod' }, 'test'), /invalid_(contract|access_record)/);
    assert.throws(() => validateAccessRecord({ ...value, revision: -1 }, 'test'), /invalid_(contract|access_record)/);
  });
}

test('nested objects stay closed, so unknown fields inside them are rejected', () => {
  const binding = accessRecords.subscriber_binding! as Record<string, unknown>;
  const mutation = binding.mutation as Record<string, unknown>;
  assert.throws(() => validateAccessRecord({ ...binding, mutation: { ...mutation, unexpected: true } }, 'test'),
    /invalid_(contract|access_record)/);
});
