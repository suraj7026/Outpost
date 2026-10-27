import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const protocolVersion = 1;
export const Mode = z.enum(['full_control', 'auto', 'ask_permission']);
export const RunState = z.enum(['queued', 'running', 'waiting_for_approval', 'waiting_for_login', 'waiting_for_human', 'waiting_for_payment_auth', 'waiting_for_capacity', 'verifying', 'completed', 'paused', 'cancelled', 'failed', 'interrupted', 'reconciling']);
export const Command = z.strictObject({
  protocolVersion: z.literal(1), commandId: z.uuid(), idempotencyKey: z.string().min(1).max(200),
  deviceId: z.uuid(), type: z.string().min(1).max(80),
  aggregateId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.json()), issuedAt: z.number().int().nonnegative(),
});
export type Command = z.infer<typeof Command>;
export type Json = z.infer<ReturnType<typeof z.json>>;
export type Data = Record<string, Json>;
export interface RecordValue<T = Data> { id: string; kind: string; revision: number; data: T; updatedAt: string }
export interface Event { protocolVersion: 1; eventId: string; feedCursor: number; aggregateId: string; aggregateRevision: number; type: string; occurredAt: string; payload: Json }
export class Fault extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function requireThat(condition: unknown, code: string, message = code): asserts condition {
  if (!condition) throw new Fault(code, message);
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new Fault('invalid_json', 'Only finite JSON values are accepted', 400);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
