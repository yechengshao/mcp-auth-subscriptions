import type { AccessRow, StateKey } from '../../../access/model.js';
import { encodeRecord, validateStoredRecord } from '../../../access/adapters/record-codec.js';
import type { ApiGatewayUsagePlanPort, UsageBindingStore } from '../../../access/usage_bindings.js';
import { entitlement, environment, usage_mapping, now } from '../../fixtures/contracts.js';
import { accessRecords } from '../../fixtures/storage.js';

export const key = (value: { PK: string; SK: string }) => `${value.PK}\0${value.SK}`;
export class MemoryBindings implements UsageBindingStore {
  readonly environment = environment;
  readonly rows = new Map<string, AccessRow>();
  paid: AccessRow = structuredClone(entitlement);
  async get(value: StateKey) { const row = this.rows.get(key(value)); return row && structuredClone(row); }
  async entitlement() { return structuredClone(this.paid); }
  async commit(writes: Array<{ row: AccessRow; expectedRevision?: number }>, checks: Array<{ key: StateKey; expectedRevision?: number; projection?: boolean }> = []) {
    for (const check of checks) {
      if (check.projection && (check.expectedRevision !== this.paid.revision || this.paid.allowed !== true)) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
    }
    for (const { row, expectedRevision } of writes) {
      const previous = this.rows.get(key(row as { PK: string; SK: string }));
      if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) {
        const error = new Error('conditional conflict'); error.name = 'TransactionCanceledException'; throw error;
      }
      validateStoredRecord(encodeRecord(row), this.environment);
    }
    for (const { row } of writes) this.rows.set(key(row as { PK: string; SK: string }), structuredClone(row));
  }
}

export class MemoryGateway implements ApiGatewayUsagePlanPort {
  readonly created: Array<{ name: string; value: string }> = [];
  readonly associated: Array<{ usagePlanId: string; apiKeyId: string }> = [];
  readonly removeCalls: Array<{ usagePlanId: string; apiKeyId: string }> = [];
  readonly values = new Map<string, string>();
  readonly fail = new Map<string, { kind: string; afterEffect: boolean }>();
  onCreate: (() => void | Promise<void>) | undefined = undefined;
  async createApiKey(input: { name: string; value: string }) {
    const failure = this.fail.get('create');
    if (failure) this.fail.delete('create');
    if (failure?.afterEffect) { this.created.push(input); this.values.set(input.value, 'key_fixture'); }
    if (failure) throw Object.assign(new Error('sanitized'), { kind: failure.kind });
    this.created.push(input); this.values.set(input.value, 'key_fixture'); await this.onCreate?.();
    return { apiKeyId: 'key_fixture' };
  }
  async findApiKey(input: { name: string; value: string }) {
    const id = this.values.get(input.value);
    return id && this.created.some(item => item.name === input.name && item.value === input.value) ? { apiKeyId: id } : undefined;
  }
  async associateApiKey(input: { usagePlanId: string; apiKeyId: string }) {
    const failure = this.fail.get('associate');
    if (failure) this.fail.delete('associate');
    if (failure?.afterEffect) this.associated.push(input);
    if (failure) throw Object.assign(new Error('sanitized'), { kind: failure.kind });
    this.associated.push(input);
  }
  async hasAssociation(input: { usagePlanId: string; apiKeyId: string }) {
    return this.associated.some(value => value.usagePlanId === input.usagePlanId && value.apiKeyId === input.apiKeyId);
  }
  async removeApiKeyAssociation(input: { usagePlanId: string; apiKeyId: string }) {
    this.removeCalls.push(input);
    const failure = this.fail.get('remove');
    if (failure) this.fail.delete('remove');
    if (failure?.afterEffect) this.removeAssociationState(input);
    if (failure) throw Object.assign(new Error('sanitized'), { kind: failure.kind });
    this.removeAssociationState(input);
  }
  private removeAssociationState(input: { usagePlanId: string; apiKeyId: string }) {
    for (let index = this.associated.length - 1; index >= 0; index--) {
      const value = this.associated[index]!;
      if (value.usagePlanId === input.usagePlanId && value.apiKeyId === input.apiKeyId) this.associated.splice(index, 1);
    }
  }
  async listAssociations(input: { apiKeyId: string }) {
    return this.associated.filter(value => value.apiKeyId === input.apiKeyId).map(value => ({
      usage_plan_id: value.usagePlanId, rest_api_id: usage_mapping.rest_api_id, stage: usage_mapping.stage,
    }));
  }
}

