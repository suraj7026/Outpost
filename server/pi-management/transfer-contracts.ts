import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const TransferProvider = z.strictObject({ id, name: z.string().max(256), method: z.enum(['api_key', 'oauth', 'unsupported']),
  revision: digest, baseUrl: z.string().max(2048), configuration: z.record(z.string(), z.json()).nullable() });
export const TransferSource = z.strictObject({ installationId: z.uuid(), generation: digest, providers: z.array(TransferProvider).max(128) });
export const TransferSelection = z.array(z.strictObject({ provider: TransferProvider, replace: z.boolean() })).min(1).max(16)
  .refine(v => new Set(v.map(p => p.provider.id)).size === v.length);
export const TransferTicket = z.strictObject({ version: z.literal(1), operationId: z.uuid(), owner: z.string().max(128),
  sourceId: z.uuid(), destinationId: z.uuid(), sourceGeneration: digest, destinationGeneration: digest,
  expiresAt: z.number().int(), publicKey: z.string().max(256), selection: TransferSelection });
export const SealedTransfer = z.strictObject({ ticket: TransferTicket, publicKey: z.string().max(256),
  nonce: z.string().max(32), tag: z.string().max(32), ciphertext: z.string().max(800000) });
export const TransferRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('transfer.inventory') }),
  z.strictObject({ type: z.literal('transfer.history') }),
  z.strictObject({ type: z.literal('transfer.prepare'), operationId: z.uuid(), source: TransferSource, destination: TransferSource, selection: TransferSelection }),
  z.strictObject({ type: z.literal('transfer.export'), ticket: TransferTicket }),
  z.strictObject({ type: z.literal('transfer.apply'), sealed: SealedTransfer }),
  z.strictObject({ type: z.literal('transfer.status'), operationId: z.uuid() }),
  z.strictObject({ type: z.literal('transfer.cancel'), operationId: z.uuid() }),
]);
export type TransferRequest = z.infer<typeof TransferRequest>;
export type TransferTicket = z.infer<typeof TransferTicket>;
export type TransferProvider = z.infer<typeof TransferProvider>;
export type TransferResult = { operationId: string; state: string; providers: { id: string; state: string }[] };
