import type { ServerRecord } from "./types";

export interface ChatAttention {
  pending: number;
  total: number;
  label: string;
  records: ServerRecord[];
  first: ServerRecord | undefined;
}

/** Records must come from one owning connection, never a cross-environment aggregate. */
export function chatAttention(records: readonly ServerRecord[] | undefined, taskId: string): ChatAttention {
  const latest = new Map<string, ServerRecord>();
  for (const record of records ?? []) {
    if (record.kind !== "action") continue;
    const previous = latest.get(record.id);
    if (!previous || record.revision > previous.revision) latest.set(record.id, record);
  }
  // Legacy servers may still report pending approvals; authorized actions dispatch automatically.
  const actions = [...latest.values()].filter(record => record.data.taskId === taskId && record.data.state === "pending");
  const pending = actions.length;
  const label = pending ? `${pending} ${pending === 1 ? "approval" : "approvals"} needed` : "";
  return { pending, total: pending, label, records: actions, first: actions[0] };
}
