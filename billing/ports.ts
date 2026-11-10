/** Persistence models shared by billing use cases and the AWS adapter. */
export type Row = Record<string, any>;
export interface Key { PK: string; SK: string }
export interface DueCursor extends Key { due_partition: string; due_sort: string }
export interface Write { row: Row; expectedRevision?: number }
export interface Guard { key: Key; revision?: number; projection?: boolean }

/** A conditional write lost a race; application workflows may reload and reconcile. */
export class BillingConflict extends Error {
  constructor() { super('billing_state_conflict'); }
}

/** Billing repository boundary. The adapter owns DynamoDB commands and validation. */
export interface BillingRepository {
  readonly environment: string;
  key(identity: { issuer: string; subject: string }, sortKey: string): Key;
  get(key: Key, projection?: boolean): Promise<Row | undefined>;
  commit(writes: Write[], token?: string, guards?: Guard[]): Promise<void>;
  due(shard: number, now: number, limit: number, start?: DueCursor): Promise<{ keys: Key[]; next: DueCursor | undefined }>;
}

export interface BillingQueuePort {
  send(message: unknown, delay: number): Promise<unknown>;
}

/** Stripe-facing operations used by billing application workflows. */
export interface BillingPayments {
  create(order: Row, customer?: string): Promise<Row>;
  session(id: string): Promise<Row>;
  creditable(order: Row): Promise<boolean>;
  verifyPaid(session: Row, order: Row): Promise<{ paymentId: string; customerId: string; paidAt: number } | undefined>;
}

