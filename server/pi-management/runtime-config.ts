import { z } from 'zod';
import { Mode } from '../core/contracts.js';
import type { Ledger } from '../core/ledger.js';

export const ExtensionName = z.enum(['pi-ollama-cloud', 'pi-subagents']);
export const ExtensionOverrides = z.partialRecord(ExtensionName, z.boolean());
export const RuntimeConfig = z.strictObject({
  defaultTaskMode: Mode.default('auto'),
  extensions: z.strictObject({ enabled: ExtensionOverrides }).default({ enabled: {} }),
});
export const RuntimeConfigRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('runtime.set_extension_enabled'), name: ExtensionName, enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('runtime.set_default_task_mode'), mode: Mode, expectedRevision: z.number().int().nonnegative() }),
]);

export function runtimeConfig(db: Ledger) {
  const row = db.get('runtime_config', 'server');
  return { revision: row?.revision ?? 0, ...RuntimeConfig.parse(row?.data ?? {}) };
}

export function updateRuntimeConfig(db: Ledger, request: z.infer<typeof RuntimeConfigRequest>) {
  return db.transaction(() => {
    const { revision: _, ...current } = runtimeConfig(db);
    const next = request.type === 'runtime.set_extension_enabled'
      ? { ...current, extensions: { enabled: { ...current.extensions.enabled, [request.name]: request.enabled } } }
      : { ...current, defaultTaskMode: request.mode };
    const row = db.put('runtime_config', 'server', request.expectedRevision, next);
    return { revision: row.revision, ...next };
  });
}
