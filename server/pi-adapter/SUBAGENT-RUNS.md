# Read-only subagent UI contract

`subagent_run` is a public replaceable snapshot delivered through the existing signed snapshot/events/live transports. It is persisted by `LiveFeed`, including completed history for launches observed after this feature is installed. There is no new endpoint or command. Older launches without a projection have unavailable details; no backfill, demo rows, or filesystem discovery is performed.

## Identity and schema

The authoritative runtime validator is `subagent-contract.ts` (`SubagentRun`). The enclosing record is the existing `{ kind, id, revision, updatedAt, data }`.

- `kind`: `subagent_run`
- `id`: `digest({ kind: 'subagent_run', sessionId, callId })`
- One record per parent `subagent` launch/tool call. Management calls do not create run records. Workflow children stay in `children`, not additional launch cards.
- `parentToolId`: `digest({ sessionId, callId })`, matching the parent `tool_stream` record.
- `parentSessionId`: the parent's logical Pi UUID, never its session filename.
- Optional native `runId` is not the parent tool-call ID, worker run ID, or fleet display key.

```ts
type State = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'partial' | 'unknown';
type SubagentRunData = {
  taskId: string;
  parentSessionId: string;
  parentCallId: string;
  parentToolId: string;
  runId?: string;
  agent?: string;
  label: string;
  model?: string;
  assignment?: string;
  executionMode: 'foreground' | 'background' | 'unknown';
  state: State;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  activity: Array<{
    id: string;
    kind: 'message' | 'tool' | 'notice';
    label?: string;
    text?: string;
    tool?: string;
    arguments?: string;
    output?: string;
    state?: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
    startedAt?: number;
  }>;
  files?: Array<{ path: string; change?: string }>;
  children?: Array<{ id: string; agent?: string; model?: string; state: State }>;
  incomplete: boolean;
  truncated: boolean;
  stopSupported: false;
};
```

The existing gateway adds `streaming: boolean` and, on transport interruption/restart, may add `interrupted: true`. These are transport facts, not native lifecycle proof. Worker projections carry the schema above without those gateway fields. The remote adapter checks task, logical parent session, record digest, and parent tool digest before forwarding a child projection.

Timestamps are epoch milliseconds. `model` retains native provider-qualified IDs when supplied; there is no parent-model fallback presented as a child model. `assignment` is bounded observed caller text, not reconstructed from redacted native prompts. `files` contains only explicitly recorded mutation evidence with safe relative paths; tool names never imply successful file changes.

## Evidence and lifecycle

Sources:

1. Parent SDK `tool_execution_start/update/end` (`details.results`, `progress`, `workflowChildren`).
2. Parent `subagent-notify` custom-message `details.runs` and `bg_wait`/equivalent `details.completions`.
3. A session-local read-only subscription to native async-started/completed, foreground-completed, child-status, control-event, jobs-changed, and process-terminal events. Subscribe before extension bind.
4. Exact launch-linked `status.json` reads during the owning session lifetime only. Directory must match the native temp root and exact observed run ID; the sidecar must repeat that ID and the parent's UUID or exact filename. These are ordinary read-only file reads, not the native status/reconciliation API.
5. Exact child display-transcript paths recorded in those sources, under this parent's `subagent-artifacts` directory. The filename and every JSONL record must match the observed run/agent/index. Canonical sessions are deliberately not read: forked sessions can contain parent history. Project/temp/custom artifact roots and unlinked/nested artifacts are not opened.

Native metadata is observational and does not authorize actions. No status RPC, tool execution, process signaling, stop/resume/steer, native imports, arbitrary path input, or directory enumeration is added. Existing background ownership/drain/recovery and native-extension policy remain unchanged.

An async tool end is only a launch receipt. It remains active until owned native completion/status evidence arrives. Foreground success requires terminal exit code zero or recorded native workflow completion. Interrupted, timed-out, paused, detached, missing, and contradictory failure evidence never becomes inferred success. Process-terminal events alone do not prove successful work. Losing observation produces `unknown` with `incomplete: true`, not stopped/completed. Terminal records can receive later activity enrichment without adding another card.

`incomplete` covers active observation, missing/unsupported artifacts, redacted content, observation failures, incomplete children, and truncation. `truncated` identifies content/array/byte caps or lost transcript ranges. A completed run can still have incomplete details. Current-tool-only metadata is a notice, not a fabricated tool result. Transcript errors expose stable codes, not provider exceptions. No child stopping UI should be enabled.

## Bounds and privacy

- Public record envelope stays below 128 KiB (schema reserves 512 bytes; projector reserves 1024 bytes).
- Up to 128 activity entries, 64 children, 64 files; older activity is dropped when needed with both flags set.
- IDs: 256 characters. Agent/tool: 128. Label/model: 256. Assignment, summary, text/output: 8192. Arguments: 4096. Relative file path: 512.
- Transcript reads: at most 256 KiB per linked file per refresh, incremental complete JSONL lines. Oversize tails/malformed or changed files report unavailable/lost evidence. Sidecars over 256 KiB are not parsed. Refreshes are session-lifetime only; status reads are throttled, and no HTTP query triggers native reconciliation.
- No raw metadata JSON is forwarded. Capability tokens, control routes, session/artifact paths, auth/credential fields, thinking/reasoning blocks, and provider exception bodies are omitted. Absolute paths/URLs and recognizable credentials in permitted text are redacted; direct-runtime credential literals are also removed. Sensitive-tool outputs, and tool outputs lacking observed arguments, are withheld.
- User-visible task/message/tool text remains untrusted content, not HTML or executable instructions. Pattern-based text redaction is not a sandbox against malicious native extensions or arbitrary unlabeled secrets. Native extensions already run with native privileges; this change does not expand them.

Consumers should replace rows by record ID/revision, render optional fields only when present, display incomplete/truncated indicators, and use the existing authenticated public feed. No client-supplied filesystem paths or child-control IDs are accepted.
