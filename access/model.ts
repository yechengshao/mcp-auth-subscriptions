/** Persisted access rows are validated at the DynamoDB adapter boundary. */
export type AccessRow = Record<string, any>;
export interface StateKey { PK: string; SK: string }
export interface StateWrite { row: AccessRow; expectedRevision?: number }
export interface StateCheck { key: StateKey; expectedRevision?: number; projection?: boolean }
