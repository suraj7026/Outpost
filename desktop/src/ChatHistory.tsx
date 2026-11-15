import { useState } from "react";
import { ChevronDown, MessageSquare, Server } from "lucide-react";
import type { EnvironmentId } from "./api";
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

export function AllChats({ groups, open }: { groups: ChatGroup[]; open: OpenChat }) {
  const [search, setSearch] = useState("");
  return <main className="page all-chats-page">
    <div className="page-heading"><div><h1>All chats</h1><p>Conversations from every server, kept with the server that owns them.</p></div></div>
    <label className="history-search">Search all chats<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <p className="small">Offline and removed connections show read-only history cached during this app session. Remote history stays on its server.</p>
    {groups.map(group => <section className="recent" key={key(group.id)} aria-label={`${group.label} history`}>
      <h2>{group.label}</h2><p>{group.connected ? "Connected" : group.archived ? "Removed · cached / read-only" : "Offline · stale / read-only"} · {group.lastSync ? `Last synced ${group.lastSync.toLocaleString()}` : "Not yet synced"}</p>
      <div className="session-list">{group.tasks.filter(task => title(task).toLowerCase().includes(search.toLowerCase())).map(task =>
        <button className="session-row" key={task.id} onClick={() => open(group.id, task.id)}>
          <MessageSquare size={16} /><span className="session-title"><strong>{title(task)}</strong><span>{labelState(text(task, "state"))} · {task.id}</span></span>
        </button>)}{!group.tasks.length && <p className="empty-line">{group.lastSync ? "No chats yet." : "Connect this server to load its history."}</p>}</div>
    </section>)}
  </main>;
}
