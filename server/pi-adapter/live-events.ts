import { z } from 'zod';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { digest } from '../core/contracts.js';
import type { Data, RecordValue } from '../core/contracts.js';
import type { SubagentRuns } from './subagent-runs.js';
import { SubagentPrivacy } from './subagent-privacy.js';

export interface LiveSink {
  publish(kind: string, id: string, data: Data): void;
  finish(kind: string, id: string, data: Data): unknown;
  snapshot(): RecordValue[];
}

const json = (value: unknown) => z.json().safeParse(value).data ?? null;
const limit = 128*1024;
/** Publish provider-visible content only. Opaque/redacted reasoning signatures never leave Pi. */
export function liveEvents(feed: LiveSink, taskId: string, sessionId: string, model: string, subagents?: SubagentRuns) {
  const privacy = new SubagentPrivacy();
  const args = (value: unknown) => subagents ? subagents.toolArguments(value) : privacy.arguments(value);
  const text = (value: unknown) => subagents ? subagents.toolOutput(value) : privacy.text(value, 16000);
  const toolKey = (callId: string) => digest({ sessionId,callId });
  return (event: AgentSessionEvent) => {
    try { subagents?.observe(event); } catch { subagents?.observationFailed(); }
    if ((event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const message = event.message;
      const key = digest({ sessionId,timestamp: message.timestamp });
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const thinking = message.content.filter(block => block.type === 'thinking' && !block.redacted).map(block => block.type === 'thinking' ? block.thinking : '').join('\n');
      const data = { taskId,startedAt: message.timestamp,author: 'assistant',text: text.slice(0,limit),thinking: thinking.slice(0,limit),model: message.model || model,provider: message.provider,usageCost: null,outputTruncated: text.length > limit || thinking.length > limit,stopReason: message.stopReason,error: message.errorMessage ?? null };
      if (event.type === 'message_end') feed.finish('message',key,data);
      else feed.publish('message',key,data);
      for (const call of message.content.filter(block => block.type === 'toolCall')) {
        feed.publish('tool_stream',toolKey(call.id),{ taskId,callId: call.id,name: call.name,arguments: ['subagent', 'bg_wait'].includes(call.name) ? args(call.arguments) ?? null : json(call.arguments),state: 'preparing',output: '' });
      }
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const native = ['subagent', 'bg_wait'].includes(event.toolName) || event.type === 'tool_execution_end' && z.object({ details: z.object({ completions: z.array(z.unknown()) }) }).safeParse(event.result).success;
      const key = toolKey(event.toolCallId);
      const previous = feed.snapshot().find(record => record.id === key)?.data ?? {};
      const data = { ...previous,taskId,callId: event.toolCallId,name: event.toolName,state: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'finished') : 'running' };
      if (event.type === 'tool_execution_end') {
        const parsed = z.object({ content: z.array(z.object({ type: z.string(),text: z.string().optional() })).optional(),details: z.unknown().optional() }).safeParse(event.result);
        const action = parsed.success ? z.object({ actionId: z.string() }).safeParse(parsed.data.details) : null;
        const rawOutput = parsed.success ? parsed.data.content?.map(block => block.text ?? '').join('\n') ?? '' : '';
        const output = native ? event.isError ? 'subagent_execution_failed' : text(rawOutput) ?? '' : rawOutput;
        feed.finish('tool_stream',key,{ ...data,output: output.slice(0,16000),outputTruncated: output.length > 16000,actionId: action?.success ? action.data.actionId : null,durationMs: event.durationMs ?? null });
      } else {
        const partial = event.type === 'tool_execution_update' ? z.object({ details: z.object({ actionId: z.string() }) }).safeParse(event.partialResult) : null;
        feed.publish('tool_stream',key,{ ...data,arguments: native ? args(event.args) ?? null : json(event.args),...(partial?.success ? { actionId: partial.data.details.actionId } : {}),...(event.type === 'tool_execution_update' ? { output: native ? 'Child activity recorded in subagent run details.' : JSON.stringify(json(event.partialResult)).slice(0,16000) } : {}) });
      }
    }
  };
}
