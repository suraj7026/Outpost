import { z } from 'zod';
export const ReleaseManifest = z.strictObject({ schema: z.literal(2), id: z.string().regex(/^host-[a-f0-9]{20}$/),
  protocolVersion: z.literal(2), layoutVersion: z.literal(1), compatibility: z.literal('native-v1'), sequence: z.number().int().positive(),
  piVersion: z.string().min(1).max(64), extensions: z.array(z.strictObject({ name: z.string().min(1).max(128), version: z.string().min(1).max(64) })).max(64),
  rollback: z.literal(true) });
export const UpdateRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('runtime.inventory') }),
  z.strictObject({ type: z.literal('maintenance.stage'), operationId: z.uuid(), expectedRelease: z.string().max(128), target: ReleaseManifest, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('maintenance.prepare'), operationId: z.uuid(), expectedRelease: z.string().max(128), target: ReleaseManifest, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('maintenance.status') }),
  z.strictObject({ type: z.literal('maintenance.cancel'), operationId: z.uuid() }),
  z.strictObject({ type: z.literal('maintenance.hold'), operationId: z.uuid() }),
  z.strictObject({ type: z.literal('maintenance.release'), operationId: z.uuid() }),
]);
export function compatibleUpdate(current: z.infer<typeof ReleaseManifest>, target: z.infer<typeof ReleaseManifest>) {
  return current.id !== target.id && target.sequence > current.sequence && current.compatibility === target.compatibility;
}
