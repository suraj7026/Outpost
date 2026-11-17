import type { ServerRecord } from "./types";

export interface ChatAttention {
  pending: number;
  authorized: number;
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
  const actions = [...latest.values()].filter(record => record.data.taskId === taskId &&
    (record.data.state === "pending" || record.data.state === "authorized"));
  const pending = actions.filter(record => record.data.state === "pending").length;
  const authorized = actions.length - pending;
  const label = [pending ? `${pending} ${pending === 1 ? "approval" : "approvals"} needed` : "",
    authorized ? `${authorized} ready to run` : ""].filter(Boolean).join(" · ");
  return { pending, authorized, total: actions.length, label, records: actions,
    first: actions.find(record => record.data.state === "pending") ?? actions[0] };
}
