import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { validateAccessRecord } from './contracts/storage.js';
import { compile } from '../contracts/schema.js';
import { entitlementSchema } from '../contracts/entitlement.js';
import { identityPartition } from '../contracts/identity.js';
import { identifierPattern, sha256HexPattern } from '../contracts/patterns.js';
import type { Telemetry } from '../observability/telemetry.js';
import type { AccessRow, StateCheck, StateKey, StateWrite } from './model.js';
import { transitionTransaction } from './transitions.js';
import type { BrowserSessionStore, PendingLogin, VerifiedLogin } from './ports.js';
const entitlementShape = compile(entitlementSchema);
const conflict = (error: unknown) => error instanceof Error && ['TransactionCanceledException','ConditionalCheckFailedException'].includes(error.name);
/** Access owns state writes; the separate billing projection is read/condition-check only. */
export class AccessStore implements BrowserSessionStore {
  constructor(readonly environment: string, private readonly table: string, private readonly entitlementTable: string,
    readonly telemetry: Telemetry, private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({
      maxAttempts: 1, requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
    }))) {
    if (!identifierPattern.test(environment) || table === entitlementTable) throw new Error('invalid_access_storage_configuration');
  }
  private key(key: StateKey) {
    if (typeof key.PK !== 'string' || !key.PK.startsWith(`ENV#${this.environment}#`) || typeof key.SK !== 'string' || !key.SK) throw new Error('invalid_access_key');
  }
  private base(PK: string, SK: string, entity_type: string) {
    return { PK, SK, entity_type, schema_version: 1, revision: 1, environment: this.environment };
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
  async createLogin(input: PendingLogin): Promise<void> {
    const session = { ...this.base(`ENV#${this.environment}#SESSION#${input.sessionDigest}`, 'SESSION', 'session'),
      purpose: input.purpose, tx_id: input.transactionId, authentication_stage: 'pending_identity',
      csrf_digest: input.csrfDigest, created_at: input.createdAt, expires_at: input.expiresAt, delete_after: input.deleteAfter };
    const transaction = { ...this.base(`ENV#${this.environment}#TX#${input.transactionId}`, 'STATE', 'transaction'),
      purpose: input.purpose, phase: 'pending_identity', correlation_id: input.correlationId,
      created_at: input.createdAt, expires_at: input.expiresAt, delete_after: input.deleteAfter,
      ...(input.grantId ? { grant_id: input.grantId } : {}),
      ...(input.downstream ? { downstream: input.downstream } : { local_destination: '/billing' }) };
    const attempt = { ...this.base(`ENV#${this.environment}#UPSTREAM#${input.stateDigest}`, 'ATTEMPT', 'upstream_attempt'),
      tx_id: input.transactionId, session_digest: input.sessionDigest, nonce_digest: input.nonceDigest,
      pkce_verifier: input.pkceVerifier, cognito_client_id: input.cognitoClientId, cognito_issuer: input.cognitoIssuer,
      callback_uri: input.callbackUri, created_at: input.createdAt, expires_at: input.expiresAt,
      delete_after: input.deleteAfter, consumed: false };
    await this.commit([{ row: session }, { row: transaction }, { row: attempt }]);
  }
  async loadContext(sessionDigest: string): Promise<{ session: AccessRow; transaction: AccessRow } | undefined> {
    const session = await this.get({ PK: `ENV#${this.environment}#SESSION#${sessionDigest}`, SK: 'SESSION' });
    if (!session) return undefined;
    const transaction = await this.get({ PK: `ENV#${this.environment}#TX#${session.tx_id}`, SK: 'STATE' });
    return transaction ? { session, transaction } : undefined;
  }
  loadUpstreamAttempt(stateDigest: string) {
    return this.get({ PK: `ENV#${this.environment}#UPSTREAM#${stateDigest}`, SK: 'ATTEMPT' });
  }
  async cancelLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow }): Promise<void> {
    const { pkce_verifier: _verifier, ...attempt } = input.attempt;
    await this.commit([
      { row: { ...attempt, consumed: true, revision: input.attempt.revision + 1 }, expectedRevision: input.attempt.revision },
      { row: { ...input.session, revoked: true, revision: input.session.revision + 1 }, expectedRevision: input.session.revision },
      { row: transitionTransaction(input.transaction, 'cancelled'), expectedRevision: input.transaction.revision },
    ]);
  }
  async completeLogin(input: { attempt: AccessRow; session: AccessRow; transaction: AccessRow; verified: VerifiedLogin }): Promise<void> {
    const { pkce_verifier: _verifier, ...attempt } = input.attempt;
    const verifiedSession = { ...this.base(`ENV#${this.environment}#SESSION#${input.verified.newSessionDigest}`, 'SESSION', 'session'),
      purpose: input.session.purpose, tx_id: input.session.tx_id, authentication_stage: 'identity_verified',
      identity: input.verified.identity, subscriber_id: input.verified.subscriberId, csrf_digest: input.verified.csrfDigest,
      ...(input.verified.grantId ? { grant_id: input.verified.grantId } : {}),
      created_at: input.session.created_at, expires_at: input.session.expires_at, delete_after: input.session.delete_after };
    await this.commit([
      { row: { ...attempt, consumed: true, revision: input.attempt.revision + 1 }, expectedRevision: input.attempt.revision },
      { row: { ...input.session, revoked: true, revision: input.session.revision + 1 }, expectedRevision: input.session.revision },
      { row: verifiedSession },
      { row: transitionTransaction(input.transaction, 'identity_verified', { identity: input.verified.identity,
        subscriber_id: input.verified.subscriberId }), expectedRevision: input.transaction.revision },
    ]);
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
      const identityPrefix = `ENV#${this.environment}#IDENTITY#`;
      if (check.projection && (check.key.SK !== 'ENTITLEMENT' || !check.key.PK.startsWith(identityPrefix) ||
          !sha256HexPattern.test(check.key.PK.slice(identityPrefix.length)))) throw new Error('invalid_entitlement_check');
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
  async ensureSubscriber(identity: { issuer: string; subject: string }): Promise<string> {
    return (await this.ensureProfile(identity)).subscriber_id;
  }
  grantFamily(grantId: string) {
    return this.get({ PK: `ENV#${this.environment}#GRANT#${grantId}`, SK: 'FAMILY' });
  }
  async logout(session: AccessRow, family: AccessRow | undefined, revokedAt: number): Promise<void> {
    const writes: StateWrite[] = [{ row: { ...session, revoked: true, revision: session.revision + 1 }, expectedRevision: session.revision }];
    if (family?.status === 'active') writes.push({ row: { ...family, status: 'revoked', revoked_at: revokedAt,
      revocation_reason: 'logout', revision: family.revision + 1 }, expectedRevision: family.revision });
    await this.commit(writes);
  }
}
