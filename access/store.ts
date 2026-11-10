import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { validateAccessRecord } from './contracts/storage.js';
import { compile, entitlementSchema } from '../billing/contracts/schemas.js';
import { identityPartition } from '../billing/contracts/validate.js';
import type { Telemetry } from '../observability/telemetry.js';
export type AccessRow = Record<string, any>;
export interface StateKey { PK: string; SK: string }
interface StateWrite { row: AccessRow; expectedRevision?: number }
interface StateCheck { key: StateKey; expectedRevision?: number; projection?: boolean }
const entitlementShape = compile(entitlementSchema);
const conflict = (error: unknown) => error instanceof Error && ['TransactionCanceledException','ConditionalCheckFailedException'].includes(error.name);
/** Access owns state writes; the separate billing projection is read/condition-check only. */
export class AccessStore {
  constructor(readonly environment: string, private readonly table: string, private readonly entitlementTable: string,
    readonly telemetry: Telemetry, private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({
      maxAttempts: 1, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
    }))) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(environment) || table === entitlementTable) throw new Error('invalid_access_storage_configuration');
  }
  private key(key: StateKey) {
    if (typeof key.PK !== 'string' || !key.PK.startsWith(`ENV#${this.environment}#`) || typeof key.SK !== 'string' || !key.SK) throw new Error('invalid_access_key');
  }
  async get(key: StateKey): Promise<AccessRow | undefined> {
    this.key(key);
    const result = await this.telemetry.dependency('dynamodb.read', () => this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true })));
    if (result.Item) {
      validateAccessRecord(result.Item, this.environment);
      if (result.Item.PK !== key.PK || result.Item.SK !== key.SK) throw new Error('access_record_mismatch');
    }
    return result.Item;
  }
  async entitlement(identity: { issuer: string; subject: string }): Promise<AccessRow | undefined> {
    const key = { PK: identityPartition(this.environment, identity.issuer, identity.subject), SK: 'ENTITLEMENT' };
    const result = await this.telemetry.dependency('dynamodb.read', () => this.db.send(new GetCommand({ TableName: this.entitlementTable, Key: key, ConsistentRead: true })));
    if (result.Item) {
      entitlementShape(result.Item);
      if (result.Item.PK !== key.PK || result.Item.environment !== this.environment || result.Item.identity_issuer !== identity.issuer || result.Item.identity_subject !== identity.subject) throw new Error('entitlement_owner_mismatch');
    }
    return result.Item;
  }
  async commit(writes: StateWrite[], checks: StateCheck[] = []) {
    if (!writes.length || writes.length + checks.length > 100) throw new Error('invalid_access_transaction');
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = writes.map(({ row, expectedRevision }) => {
      validateAccessRecord(row, this.environment);
      if (row.revision !== (expectedRevision ?? 0) + 1) throw new Error('invalid_access_revision');
      return { Put: { TableName: this.table, Item: row,
        ConditionExpression: expectedRevision === undefined ? 'attribute_not_exists(PK)' : '#revision = :revision',
        ...(expectedRevision === undefined ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': expectedRevision } }) } };
    });
    for (const check of checks) {
      this.key(check.key);
      if (check.projection && (check.key.SK !== 'ENTITLEMENT' || !new RegExp(`^ENV#${this.environment}#IDENTITY#[a-f0-9]{64}$`).test(check.key.PK))) throw new Error('invalid_entitlement_check');
      items.push({ ConditionCheck: { TableName: check.projection ? this.entitlementTable : this.table, Key: check.key,
        ConditionExpression: check.expectedRevision === undefined ? 'attribute_not_exists(PK)' : '#revision = :revision',
        ...(check.expectedRevision === undefined ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': check.expectedRevision } }) } });
    }
    await this.telemetry.dependency('dynamodb.transact', () => this.db.send(new TransactWriteCommand({ TransactItems: items })));
  }
  async ensureProfile(identity: { issuer: string; subject: string }): Promise<AccessRow> {
    const key = { PK: identityPartition(this.environment, identity.issuer, identity.subject), SK: 'PROFILE' };
    const current = await this.get(key); if (current) return current;
    const proposed = { ...key, entity_type: 'identity_profile', schema_version: 1, revision: 1,
      environment: this.environment, identity, subscriber_id: randomUUID() };
    try { await this.commit([{ row: proposed }]); return proposed; }
    catch (error) {
      if (!conflict(error)) throw error;
      const winner = await this.get(key); if (!winner) throw error;
      return winner;
    }
  }
}
