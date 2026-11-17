import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Server } from "lucide-react";
import { Badge } from "./Interface";
import type { Connection } from "./useConnection";
import { chatStatus, loadedMessageCount, relativeTime } from "./workspace-presentation";
import type { EnvironmentId } from "./api";
import "./workspace-refinement.css";
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

export function SidebarHistory({ groups, selectedServer, selectedTask, search, open }: {
  groups: ChatGroup[]; selectedServer: EnvironmentId; selectedTask?: string; search: string; open: OpenChat;
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
          {tasks.map(task => <button key={task.id} data-task-id={task.id} title={`${title(task)} · ${labelState(text(task, "state"))}`} aria-label={`${title(task)} · ${labelState(text(task, "state"))}`}
            aria-current={group.id === selectedServer && task.id === selectedTask ? "page" : undefined} onClick={() => open(group.id, task.id)}>
            <MessageSquare size={13} /><span>{title(task)}</span>
          </button>)}
          {!tasks.length && <p>{group.lastSync ? "No chats yet" : "History not loaded"}</p>}
        </div>
      </section>;
    })}
  </div>;
}

export function AllChats({ groups, open, connections }: { groups: ChatGroup[]; open: OpenChat; connections?: Record<string, Connection> }) {
  const [search, setSearch] = useState(""), [server, setServer] = useState("all");
  const needle = search.trim().toLowerCase();
  const total = groups.reduce((count, group) => count + group.tasks.length, 0);
  const results = groups.flatMap(group => group.tasks.map(task => ({ group, task }))).filter(({ group, task }) =>
    (server === "all" || key(group.id) === server) && `${chatTitle(task)} ${group.label} ${chatStatus(text(task, "state")).label} ${labelState(text(task, "state"))}`.toLowerCase().includes(needle))
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  return <main className="page all-chats-page workspace-refinement">
    <div className="page-heading"><div><h1>All chats</h1><p>Every conversation, kept with the server that owns it.</p></div></div>
    <div className="workspace-toolbar">
      <label>Search chats<input type="search" placeholder="Search by title, server or status" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Server<select value={server} onChange={event => setServer(event.target.value)}><option value="all">All servers</option>{groups.map(group => <option key={key(group.id)} value={key(group.id)}>{group.label}{group.archived ? " · Removed" : ""}</option>)}</select></label>
    </div>
    <section aria-label="Conversations">
      <div className="section-heading"><h2>Conversations</h2><span role="status">{results.length} of {total} chats</span></div>
      <div className="workspace-list">{results.map(({ group, task }) => {
        const status = chatStatus(text(task, "state")), cached = !group.connected || group.archived;
        const count = loadedMessageCount(connections?.[key(group.id)]?.records, task.id);
        return <button type="button" className="workspace-chat" data-server-id={key(group.id)} data-task-id={task.id} key={`${key(group.id)}:${task.id}`} onClick={() => open(group.id, task.id)}>
          <MessageSquare size={16} aria-hidden="true" /><span className="workspace-item-body"><strong>{chatTitle(task)}</strong><span className="small">{group.label}{count !== undefined && ` · ${count} loaded ${count === 1 ? "message" : "messages"}`} · <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>{relativeTime(task.updatedAt)}</time></span>{cached && <span className="small">{group.archived ? "Removed" : "Offline"} · cached / read-only</span>}</span>
          <Badge tone={cached ? "neutral" : status.tone}>{cached ? "Last known: " : ""}{status.label}</Badge><ChevronRight size={16} className="workspace-chat-chevron" aria-hidden="true" />
        </button>;
      })}</div>
      {!results.length && <div className="workspace-empty"><MessageSquare size={24} aria-hidden="true" /><h2>{total ? "No chats match your search" : "No conversations loaded yet"}</h2><p>{total ? "Try a shorter search or switch back to all servers." : "Connect a server to load its history, or start a new chat from the sidebar."}</p>{(search || server !== "all") && <button onClick={() => { setSearch(""); setServer("all"); }}>Clear search and filters</button>}</div>}
    </section>
    <p className="small">Offline and removed connections show read-only history cached during this app session. Remote history stays on its server.</p>
    <details className="workspace-sync"><summary>Server history availability</summary>{groups.map(group => <p className="small" key={key(group.id)}>{group.label}: {group.lastSync ? `Last synced ${group.lastSync.toLocaleString()}` : "Not yet synced"}{!group.tasks.length ? " · No chats loaded" : ""}</p>)}</details>
  </main>;
}
