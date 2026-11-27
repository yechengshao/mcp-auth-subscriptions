import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSchema, transactionSchema } from '../../access/contracts/schemas.js';
import { accessRecordSchemas } from '../../access/contracts/storage.js';
import { redirectUriAllowed } from '../../access/config.js';

/** Finds every `redirect_uri` pattern in a schema tree, so the test follows whichever record holds it. */
function redirectPatterns(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'redirect_uri' && value && typeof (value as { pattern?: unknown }).pattern === 'string') {
      found.push((value as { pattern: string }).pattern);
    }
    redirectPatterns(value, found);
  }
  return found;
}

// The stored and request redirect patterns must accept exactly what the request check accepts (2026-11-27 amendment).
test('every stored and request redirect pattern accepts the native-app forms and rejects lookalikes', () => {
  const patterns = [...redirectPatterns(accessRecordSchemas), ...redirectPatterns(sessionSchema),
    ...redirectPatterns(transactionSchema)].map(source => new RegExp(source));
  assert.ok(patterns.length >= 2, 'stored and request patterns are present');
  const accepted = ['https://claude.example.invalid/cb', 'http://localhost:53682/callback', 'http://127.0.0.1/cb', 'claude://claude.ai/oauth/callback'];
  const rejected = ['http://claude.example.invalid/cb', 'http://localhost.example.invalid/cb', 'claude://claude.ai.evil.invalid/cb', 'claude://evil.invalid/cb', 'ftp://x.invalid/cb'];
  for (const uri of accepted) {
    assert.equal(redirectUriAllowed(uri), true, uri);
    for (const pattern of patterns) assert.equal(pattern.test(uri), true, `${pattern.source}: ${uri}`);
  }
  for (const uri of rejected) {
    assert.equal(redirectUriAllowed(uri), false, uri);
    for (const pattern of patterns) assert.equal(pattern.test(uri), false, `${pattern.source}: ${uri}`);
  }
});
