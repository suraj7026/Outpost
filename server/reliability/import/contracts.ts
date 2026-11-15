export class SourceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SourceError'; }
}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new SourceError(code);
}
export const limits = { database: 128 * 1024 * 1024, archive: 200 * 1024 * 1024, decoded: 128 * 1024 * 1024, file: 64 * 1024 * 1024, files: 10000, rows: 1000000, json: 1024 * 1024 } as const;
export type Source =
  | { type: 'sqlite'; database: string; artifactRoot: string; frozen: true }
  | { type: 'outpost1'; archive: string; key: Buffer };
export interface TableInventory { count: number; rawHash: string; canonicalHash: string }
export interface FileInventory { nameHash: string; size: number; hash: string; role: 'published' | 'partial' | 'unexpected' }
export interface SourceManifest {
  format: 'outpost-source-inventory'; version: 1; tool: 'source-only-v1'; sourceType: Source['type'];
  source: { hash: string; size: number }; database: { hash: string; size: number };
  schema: { version: 1; hash: string; derivedMemoryIndex: boolean };
  tables: Record<string, TableInventory>;
  recordsByKind: { kindHash: string; count: number }[];
  events: { min: number; max: number; count: number; watermark: number };
  outboxStates: Record<string, number>;
  tombstones: { count: number; hash: string };
  files: FileInventory[]; artifactInventoryHash: string;
  uploads: { count: number; hash: string };
  blockers: string[]; exclusions: string[]; applySupported: false;
}
