import { validateAccessRecord } from '../contracts/storage.js';

/**
 * Persistence-only record versioning. Domain code builds records without a version;
 * the DynamoDB adapter stamps the write version on every write and selects the validator
 * for the version read back. Keep an old version in READ_SCHEMA_VERSIONS until its records expire.
 */
export const WRITE_SCHEMA_VERSION = 1;
export const READ_SCHEMA_VERSIONS: readonly number[] = [1];

type RecordValidator = (row: unknown, environment: string) => void;
const validators: Record<number, RecordValidator> = { 1: validateAccessRecord };

export function encodeRecord<T extends object>(row: T): T & { schema_version: number } {
  return { ...row, schema_version: WRITE_SCHEMA_VERSION };
}

export function validateStoredRecord(row: unknown, environment: string): void {
  const version = (row as { schema_version?: unknown } | null | undefined)?.schema_version;
  if (typeof version !== 'number' || !READ_SCHEMA_VERSIONS.includes(version) || !Object.hasOwn(validators, version)) {
    throw new Error('invalid_access_record_schema_version');
  }
  validators[version]!(row, environment);
}
