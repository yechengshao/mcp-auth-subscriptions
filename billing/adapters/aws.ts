import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createCatalogCache } from '../contracts/catalog-cache.js';
import { validateBillingRecord } from '../contracts/storage.js';
import { identityPartition, validateQueue, type Scope } from '../contracts/validate.js';
import { propagateSqs } from '../observability.js';
import type { Telemetry } from '../../observability/telemetry.js';
import { BillingConflict, type BillingRepository, type BillingQueuePort, type DueCursor, type Key, type Row, type Write } from '../ports.js';
export type { DueCursor, Key, Row, Write } from '../ports.js';
export const conditionalConflict = (error: unknown) => error instanceof Error && ['ConditionalCheckFailedException','TransactionCanceledException'].includes(error.name);
export class BillingStore implements BillingRepository {
  constructor(readonly environment: string, readonly stateTable: string, readonly entitlementTable: string,
    readonly telemetry: Telemetry,
    private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } }), { marshallOptions: { removeUndefinedValues: false } })) {}
  key(identity: { issuer: string; subject: string }, SK: string): Key { return { PK: identityPartition(this.environment, identity.issuer, identity.subject), SK }; }
  async get(key: Key, projection = false): Promise<Row | undefined> {
    const response = await this.telemetry.dependency('dynamodb.read', () => this.db.send(new GetCommand({
      TableName: projection ? this.entitlementTable : this.stateTable, Key: key, ConsistentRead: true,
    })));
    if (response.Item) validateBillingRecord(response.Item, this.environment);
    return response.Item;
  }
  async commit(writes: Write[], token?: string, guards: Array<{ key: Key; revision?: number; projection?: boolean }> = []): Promise<void> {
    if (!writes.length || writes.length > 100) throw new Error('invalid_transaction');
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = writes.map(({ row, expectedRevision }) => {
      validateBillingRecord(row, this.environment);
      if (expectedRevision !== undefined && row.revision !== expectedRevision + 1) throw new Error('invalid_revision');
      if (expectedRevision === undefined && row.revision !== 1 && row.entity_type !== 'decision_history') throw new Error('invalid_initial_revision');
      return { Put: { TableName: row.entity_type === 'entitlement' ? this.entitlementTable : this.stateTable, Item: row,
        ConditionExpression: expectedRevision === undefined ? 'attribute_not_exists(PK)' : '#revision = :revision',
        ...(expectedRevision === undefined ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': expectedRevision } }) } };
    });
    for (const guard of guards) items.push({ ConditionCheck: { TableName: guard.projection ? this.entitlementTable : this.stateTable, Key: guard.key,
      ConditionExpression: guard.revision === undefined ? 'attribute_not_exists(PK)' : '#revision = :revision',
      ...(guard.revision === undefined ? {} : { ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': guard.revision } }) } });
    try {
      await this.telemetry.dependency('dynamodb.transact', () => this.db.send(new TransactWriteCommand({
        TransactItems: items, ...(token ? { ClientRequestToken: token } : {}),
      })));
    } catch (error) {
      if (conditionalConflict(error)) throw new BillingConflict();
      throw error;
    }
  }
  async due(shard: number, now: number, limit: number, start?: DueCursor) {
    if (!Number.isInteger(shard) || shard < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_query_budget');
    const response = await this.telemetry.dependency('dynamodb.read', () => this.db.send(new QueryCommand({
      TableName: this.stateTable, IndexName: 'DueWork', KeyConditionExpression: 'due_partition = :partition AND due_sort <= :due',
      ExpressionAttributeValues: { ':partition': `ENV#${this.environment}#DUE#${shard}`, ':due': `${now.toString().padStart(12, '0')}#\uffff` },
      Limit: limit, ...(start ? { ExclusiveStartKey: start } : {}),
    })));
    return { keys: (response.Items ?? []).map(row => ({ PK: row.PK as string, SK: row.SK as string })), next: response.LastEvaluatedKey as DueCursor | undefined };
  }
}
export function parameterCatalog(name: string, scope: Scope, telemetry: Telemetry, ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } }), options: { max_age_ms?: number; fetch_timeout_ms?: number } = {}) {
  if (!name.startsWith('/')) throw new Error('invalid_catalog_parameter');
  return createCatalogCache(async signal => {
    const response = await telemetry.dependency('ssm.catalog', () => ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }), { abortSignal: signal }));
    if (response.Parameter?.Type !== 'String' || !response.Parameter.Value || !response.Parameter.Version) throw new Error('invalid_catalog_parameter');
    return { version: response.Parameter.Version, value: JSON.parse(response.Parameter.Value) as unknown };
  }, scope, options);
}
export function parameterSecret(name: string, telemetry: Telemetry, ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } }), now = Date.now) {
  let cached: string | undefined, until = 0;
  return async () => {
    if (cached && now() < until) return cached;
    const response = await telemetry.dependency('ssm.secret', () => ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), { abortSignal: AbortSignal.timeout(3000) }));
    if (response.Parameter?.Type !== 'SecureString' || !response.Parameter.Value) throw new Error('secret_unavailable');
    cached = response.Parameter.Value; until = now() + 60000; return cached;
  };
}
export class BillingQueue implements BillingQueuePort {
  constructor(private readonly url: string, private readonly environment: string, private readonly telemetry: Telemetry,
    private readonly sqs = new SQSClient({ maxAttempts: 1, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } })) {}
  async send(message: unknown, delay: number) {
    validateQueue(message, this.environment);
    if (!Number.isInteger(delay) || delay < 0 || delay > 900) throw new Error('invalid_delay');
    return this.telemetry.dependency('sqs.publish', () => this.sqs.send(new SendMessageCommand(propagateSqs(this.telemetry, {
      QueueUrl: this.url, MessageBody: JSON.stringify(message), DelaySeconds: delay,
    }))));
  }
}
