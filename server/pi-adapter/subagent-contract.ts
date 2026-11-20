import { z } from 'zod';

export const subagentRecordBytes = 128 * 1024;
const identity = z.string().regex(/^[a-zA-Z0-9_.:|+-]{1,256}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SubagentState = z.enum(['queued', 'running', 'completed', 'failed', 'stopped', 'partial', 'unknown']);
export const SubagentActivity = z.strictObject({
  id: identity, kind: z.enum(['message', 'tool', 'notice']), label: z.string().max(256).optional(),
  text: z.string().max(8192).optional(), tool: z.string().max(128).optional(),
  arguments: z.string().max(4096).optional(), output: z.string().max(8192).optional(),
  state: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']).optional(), startedAt: timestamp.optional(),
});
export const SubagentRun = z.strictObject({
  taskId: z.uuid(), parentSessionId: z.uuid(), parentCallId: identity, parentToolId: z.string().regex(/^[a-f0-9]{64}$/),
  runId: identity.optional(), agent: z.string().max(128).optional(), label: z.string().max(256), model: z.string().max(256).optional(),
  assignment: z.string().max(8192).optional(), executionMode: z.enum(['foreground', 'background', 'unknown']), state: SubagentState,
  startedAt: timestamp.optional(), endedAt: timestamp.optional(), summary: z.string().max(8192).optional(),
  activity: z.array(SubagentActivity).max(128),
  files: z.array(z.strictObject({ path: z.string().max(512), change: z.string().max(128).optional() })).max(64).optional(),
  children: z.array(z.strictObject({ id: identity, agent: z.string().max(128).optional(), model: z.string().max(256).optional(), state: SubagentState })).max(64).optional(),
  incomplete: z.boolean(), truncated: z.boolean(), stopSupported: z.literal(false),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= subagentRecordBytes - 512, 'subagent_record_too_large');
export type SubagentRun = z.infer<typeof SubagentRun>;
export type SubagentActivity = z.infer<typeof SubagentActivity>;
export type SubagentState = z.infer<typeof SubagentState>;

/** Losing observation is not proof that native work stopped. */
export function interruptedSubagent(data: Record<string, unknown>) {
  return { ...data, ...(['queued', 'running', 'unknown'].includes(String(data.state)) ? { state: 'unknown' } : {}),
    incomplete: true, stopSupported: false };
}
