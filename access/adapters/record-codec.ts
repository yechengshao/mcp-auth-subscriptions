import { validateAccessRecord } from '../contracts/storage.js';

/**
 * Persistence-only record stamping. Every access record carries the current schema version,
 * and one validator checks it. Changes must be additive: new fields are optional and nothing
 * is removed or changed in meaning. A breaking change needs its own migration plan.
 */
export const SCHEMA_VERSION = 1;

export function encodeRecord<T extends object>(row: T): T & { schema_version: number } {
  return { ...row, schema_version: SCHEMA_VERSION };
}

export function validateStoredRecord(row: unknown, environment: string): void {
  validateAccessRecord(row, environment);
}
