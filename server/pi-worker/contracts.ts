import { z } from 'zod';
import { ManagementRequest, ModelRef } from '../pi-management/contracts.js';
import { SubagentRun } from '../pi-adapter/subagent-contract.js';
import { Mode } from '../core/contracts.js';

export const RunStart = z.strictObject({
  type: z.literal('run.start'), runId: z.uuid(), taskId: z.uuid(), model: ModelRef, mode: Mode.default('full_control'),
  prompt: z.string().min(1).max(20000), systemPrompt: z.string().min(1).max(65536),
  sessionFile: z.string().regex(/^[a-zA-Z0-9_.-]+\.jsonl$/).optional(),
});
export type RunStart = z.infer<typeof RunStart>;
export const WorkerRequest = z.discriminatedUnion('type',[
  z.strictObject({ type: z.literal('management'), owner: z.uuid(), request: ManagementRequest }),
  RunStart,
  z.strictObject({ type: z.literal('run.poll'), runId: z.uuid(), after: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('run.abort'), runId: z.uuid() }),
  z.strictObject({ type: z.literal('run.steer'), runId: z.uuid(), text: z.string().min(1).max(20000) }),
  z.strictObject({ type: z.literal('run.action-result'), runId: z.uuid(), callId: z.uuid(), result: z.json(), failed: z.boolean() }),
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;
export const Projection = z.strictObject({
  sequence: z.number().int().positive(), final: z.boolean(), kind: z.enum(['message','tool_stream','subagent_run']),
  id: z.string().regex(/^[a-f0-9]{64}$/), data: z.record(z.string(), z.json()),
}).superRefine((value, ctx) => {
  if (value.kind === 'subagent_run' && !SubagentRun.safeParse(value.data).success)
    ctx.addIssue({ code: 'custom', message: 'invalid_subagent_projection', path: ['data'] });
});
export type Projection = z.infer<typeof Projection>;
export const ActionFailure = z.strictObject({ code: z.enum(['invalid_tool_arguments','unavailable_tool','coordinator_action_failed']) });
export function actionFailureMessage(result: unknown) {
  const parsed = ActionFailure.safeParse(result);
  switch (parsed.success ? parsed.data.code : 'coordinator_action_failed') {
    case 'invalid_tool_arguments': return 'invalid_tool_arguments: No action was executed. Use the exact inputSchema in the available tools catalogue. command.run needs argv, browser.open needs url, artifact.read_text needs artifactId; workspace paths use file.read.';
    case 'unavailable_tool': return 'unavailable_tool: No action was executed. Choose a tool from the available tools catalogue.';
    default: return 'coordinator_action_failed: Inspect action evidence before retrying; do not assume execution was safe to repeat.';
  }
}
export const ActionRequest = z.strictObject({ callId: z.uuid(), tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.json()) });
export type ActionRequest = z.infer<typeof ActionRequest>;
export const RunPoll = z.strictObject({
  runId: z.uuid(), taskId: z.uuid(), state: z.enum(['starting','running','finished','failed','cancelled']),
    settled: z.boolean().optional(), needsAttention: z.boolean().optional(),
  session: z.strictObject({ id: z.string(), file: z.string() }).nullable(),
  model: ModelRef, cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(), projections: z.array(Projection).max(64), actions: z.array(ActionRequest).max(32), error: z.string().nullable(),
});
export type RunPoll = z.infer<typeof RunPoll>;
