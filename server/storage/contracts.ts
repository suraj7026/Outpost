import type { Command, Data, Event, Json, RecordValue } from '../core/contracts.js';

export interface Snapshot { protocolVersion: 1; cursor: number; records: RecordValue[] }
export interface OutboxClaim { id: string; topic: string; payload: Json; epoch: number }
export interface RepositoryReader {
  get<T = Data>(kind: string, key: string): Promise<RecordValue<T> | undefined>;
  need<T = Data>(kind: string, key: string): Promise<RecordValue<T>>;
  list<T = Data>(kind: string): Promise<RecordValue<T>[]>;
  cursor(): Promise<number>;
  events(after?: number, limit?: number): Promise<Event[]>;
}
/** Callbacks contain only awaited repository work. External effects run after commit; no automatic retries. */
export interface RepositoryTransaction extends RepositoryReader {
  put<T extends object>(kind: string, key: string, expected: number, data: T, eventType?: string): Promise<RecordValue<T>>;
  enqueue(topic: string, payload: Json, key?: string): Promise<string>;
  accept(command: Command, apply: (tx: RepositoryTransaction) => Promise<Json>): Promise<Json>;
  savepoint<T>(apply: (tx: RepositoryTransaction) => Promise<T>): Promise<T>;
  setDispatchEnabled(enabled: boolean): Promise<void>;
  claimOutbox(topics: string[], limit?: number): Promise<OutboxClaim[]>;
  finishOutbox(key: string, outcome: 'done' | 'unknown'): Promise<void>;
}
export interface CoordinatorOwnership {
  readonly epoch: number;
  readonly active: boolean;
  /** Resolves on explicit release or ownership connection loss; caller must abort local effects/admission. */
  readonly lost: Promise<void>;
  release(): Promise<void>;
}
/** Cancellation before COMMIT dispatch rolls back. Once dispatched, COMMIT is awaited
 * under database timeouts; cancellation cannot promise rollback or authorize retry. */
export interface TransactionOptions { signal?: AbortSignal }
export interface Repository extends RepositoryReader {
  transaction<T>(owner: CoordinatorOwnership, apply: (tx: RepositoryTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  snapshot(kinds: string[]): Promise<Snapshot>;
  acquireOwnership(): Promise<CoordinatorOwnership>;
  close(): Promise<void>;
}
