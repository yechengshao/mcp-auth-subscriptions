import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createTtlCache } from '../../contracts/ttl-cache.js';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
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
const restApiParameterPattern = /^\/mcp\/(development|test|production)\/access-api\/rest-api-id$/;
const stageParameterPattern = /^\/mcp\/(development|test|production)\/access-api\/stage$/;
/** Reads the deployed REST API ID and stage the gateway stack publishes; five-minute cache, failures never cached. */
export function parameterRestApiTarget(restApiName: string | undefined, stageName: string | undefined,
  ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } }), now = Date.now) {
  if (!restApiName || !restApiParameterPattern.test(restApiName) || !stageName || !stageParameterPattern.test(stageName)) {
    throw new Error('invalid_rest_api_target_configuration');
  }
  const read = async (name: string): Promise<string> => {
    const response = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
    const value = response.Parameter?.Value;
    if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_rest_api_target');
    return value;
  };
  return createTtlCache(async (): Promise<{ rest_api_id: string; stage: string }> => {
    const [rest_api_id, stage] = await Promise.all([read(restApiName), read(stageName)]);
    return { rest_api_id, stage };
  }, { ttlMs: 300_000, now });
}
/** Reads a SecureString only, with a one-minute cache; the value is never logged. */
export function parameterSecret(name: string, telemetry: Telemetry, ssm = new SSMClient({ maxAttempts: 2, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 } }), now = Date.now) {
  return createTtlCache(async (): Promise<string> => {
    const response = await telemetry.dependency('ssm.secret', () => ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), { abortSignal: AbortSignal.timeout(3000) }));
    if (response.Parameter?.Type !== 'SecureString' || !response.Parameter.Value) throw new Error('secret_unavailable');
    return response.Parameter.Value;
  }, { ttlMs: 60_000, now });
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
