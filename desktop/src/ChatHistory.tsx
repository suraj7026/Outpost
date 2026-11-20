import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Server, ShieldCheck } from "lucide-react";
import { Badge } from "./Interface";
import type { Connection } from "./useConnection";
import { chatStatus, loadedMessageCount, relativeTime } from "./workspace-presentation";
import type { EnvironmentId } from "./api";
import "./workspace-refinement.css";
import { chatAttention } from "./chat-attention";
import "./chat-attention.css";
import { labelState, text, title, type ServerRecord } from "./types";

export interface ChatGroup {
  id: EnvironmentId;
  label: string;
  connected: boolean;
  lastSync: Date | null;
  tasks: ServerRecord[];
  archived?: boolean;
}
export type OpenChat = (server: EnvironmentId, task: string) => void;
const key = (id: EnvironmentId) => id ?? "legacy";
export const chatTitle = (task: ServerRecord) => title(task) === "task" ? "Untitled conversation" : title(task);

export function SidebarHistory({ groups, selectedServer, selectedTask, search, open, connections }: {
  groups: ChatGroup[]; selectedServer: EnvironmentId; selectedTask?: string; search: string; open: OpenChat;
  connections?: Record<string, Connection>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return <div className="sidebar-sessions grouped-chats">
    {groups.map(group => {
      const id = key(group.id), expanded = !!search || !collapsed.has(id);
      const tasks = group.tasks.filter(task => title(task).toLowerCase().includes(search.toLowerCase()));
      if (search && !tasks.length) return null;
      return <section className="chat-server-group" key={id} aria-label={`${group.label} chats`} data-server-id={id}>
        <button className="chat-server-heading" aria-expanded={expanded} aria-controls={`chats-${id}`} onClick={() => setCollapsed(previous => {
          const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
        })}>
          <ChevronDown size={13} className={expanded ? "" : "collapsed"} /><Server size={13} />
          <span>{group.label}</span><span className={`status-dot ${group.connected ? "online" : ""}`} title={group.connected ? "Connected" : group.archived ? "Removed · cached history" : "Offline · cached history"} />
        </button>
        <div className="chat-server-threads" id={`chats-${id}`} hidden={!expanded}>
          {tasks.map(task => {
            const attention = chatAttention(connections?.[id]?.records, task.id);
            const cached = !group.connected || !!group.archived;
            const status = `${cached ? "Last known: " : ""}${attention.label || labelState(text(task, "state"))}`;
            const label = `${title(task)} · ${status}${cached ? ` · ${group.archived ? "Removed" : "Offline"} · cached / read-only` : ""}`;
            return <button key={task.id} data-task-id={task.id} title={label} aria-label={label}
              aria-current={group.id === selectedServer && task.id === selectedTask ? "page" : undefined} onClick={() => open(group.id, task.id)}>
              <MessageSquare size={13} aria-hidden="true" /><span className="chat-history-title">{title(task)}</span>
              {attention.total > 0 && <span className="chat-attention-count" data-cached={cached} title={status} aria-label={status}>
                <ShieldCheck size={11} aria-hidden="true" /><b aria-hidden="true">{attention.total}</b>
              </span>}
            </button>;
          })}
          {!tasks.length && <p>{group.lastSync ? "No chats yet" : "History not loaded"}</p>}
        </div>
      </section>;
    })}
  </div>;
}

export function AllChats({ groups, open, connections }: { groups: ChatGroup[]; open: OpenChat; connections?: Record<string, Connection> }) {
  const [search, setSearch] = useState(""), [server, setServer] = useState("all");
  const [needsAttention, setNeedsAttention] = useState(false);
  const needle = search.trim().toLowerCase();
  const total = groups.reduce((count, group) => count + group.tasks.length, 0);
  const matching = groups.flatMap(group => group.tasks.map(task => ({ group, task,
    attention: chatAttention(connections?.[key(group.id)]?.records, task.id) }))).filter(({ group, task, attention }) =>
    (server === "all" || key(group.id) === server) && `${chatTitle(task)} ${group.label} ${chatStatus(text(task, "state")).label} ${labelState(text(task, "state"))} ${attention.label}`.toLowerCase().includes(needle));
  const attentionCount = matching.filter(({ attention }) => attention.total > 0).length;
  const results = matching.filter(({ attention }) => !needsAttention || attention.total > 0)
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const filtered = !!search || server !== "all" || needsAttention;
  return <main className="page all-chats-page workspace-refinement">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><MessageSquare size={20} /></span><div><h1>All chats</h1><p>Every conversation, kept with the server that owns it.</p></div></div>
    <div className="workspace-toolbar">
      <label>Search chats<input type="search" placeholder="Search by title, server or status" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Server<select value={server} onChange={event => setServer(event.target.value)}><option value="all">All servers</option>{groups.map(group => <option key={key(group.id)} value={key(group.id)}>{group.label}{group.archived ? " · Removed" : ""}</option>)}</select></label>
      <button type="button" className="chat-attention-filter" aria-pressed={needsAttention} onClick={() => setNeedsAttention(value => !value)} title="Filter chats with pending approvals; offline counts are last known">
        <ShieldCheck size={16} aria-hidden="true" /><span>Needs attention</span><b>{attentionCount}</b>
      </button>
    </div>
    <section aria-label="Conversations">
      <div className="section-heading"><h2>Conversations</h2><span role="status">{results.length} of {total} chats</span></div>
      <div className="workspace-list">{results.map(({ group, task, attention }) => {
        const status = chatStatus(text(task, "state")), cached = !group.connected || group.archived;
        const count = loadedMessageCount(connections?.[key(group.id)]?.records, task.id);
        return <button type="button" className="workspace-chat" data-attention={attention.total > 0} data-cached={!!cached} data-server-id={key(group.id)} data-task-id={task.id} key={`${key(group.id)}:${task.id}`} onClick={() => open(group.id, task.id)}>
          <MessageSquare size={16} aria-hidden="true" /><span className="workspace-item-body"><strong>{chatTitle(task)}</strong><span className="small">{group.label}{count !== undefined && ` · ${count} loaded ${count === 1 ? "message" : "messages"}`} · <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>{relativeTime(task.updatedAt)}</time></span>{cached && <span className="small">{group.archived ? "Removed" : "Offline"} · cached / read-only</span>}</span>
          <Badge tone={cached ? "neutral" : attention.total ? "warning" : status.tone}>{cached ? "Last known: " : ""}{attention.label || status.label}</Badge><ChevronRight size={16} className="workspace-chat-chevron" aria-hidden="true" />
        </button>;
      })}</div>
      {!results.length && <div className="workspace-empty"><MessageSquare size={24} aria-hidden="true" /><h2>{!total ? "No conversations loaded yet" : needsAttention ? "No chats need attention in this view" : "No chats match your search"}</h2><p>{!total ? "Connect a server to load its history, or start a new chat from the sidebar." : needsAttention ? "No pending approvals match these filters. Clear filters to see all chats." : "Try a shorter search or switch back to all servers."}</p>{filtered && <button type="button" onClick={() => { setSearch(""); setServer("all"); setNeedsAttention(false); }}>Clear search and filters</button>}</div>}
    </section>
    <p className="small">Offline and removed connections show read-only history cached during this app session. Remote history stays on its server.</p>
    <details className="workspace-sync"><summary>Server history availability</summary>{groups.map(group => <p className="small" key={key(group.id)}>{group.label}: {group.lastSync ? `Last synced ${group.lastSync.toLocaleString()}` : "Not yet synced"}{!group.tasks.length ? " · No chats loaded" : ""}</p>)}</details>
  </main>;
}
