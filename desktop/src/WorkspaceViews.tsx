import type { ReactNode } from "react";
import type { ChatGroup } from "./ChatHistory";
import { EnvironmentContext } from "./EnvironmentContext";
import { Action } from "./TaskView";
import Artifact from "./image-viewer/Artifact";
import { ImageViewerProvider } from "./image-viewer/ImageViewer";
import { text, title, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";

export type WorkspaceSection = "decisions" | "outputs" | "automations" | "memory";
export const isWorkspaceSection = (section: string): section is WorkspaceSection =>
  section === "decisions" || section === "outputs" || section === "automations" || section === "memory";

export function isApproval(record: ServerRecord) {
  return record.kind === "action" && ["pending", "authorized"].includes(text(record, "state"));
}

const sections = {
  decisions: { title: "Approvals", description: "Actions waiting for review or dispatch across your servers.", empty: "No actions are waiting for approval or dispatch.", matches: isApproval },
  outputs: { title: "Library", description: "Files, screenshots and results from all your servers.", empty: "No outputs yet.", matches: (row: ServerRecord) => row.kind === "artifact" },
  automations: { title: "Automations", description: "Schedules across your servers. Each schedule runs on the server listed below.", empty: "No automations yet.", matches: (row: ServerRecord) => row.kind === "automation" },
  memory: { title: "Memory", description: "Shared notes and notes kept on individual servers.", empty: "No server notes yet.", matches: (row: ServerRecord) => row.kind === "memory" && row.data.shared !== true && row.data.forgotten !== true },
};

export default function WorkspaceView({ section, groups, connections, sharedMemory }: {
  section: WorkspaceSection; groups: ChatGroup[]; connections: Record<string, Connection>; sharedMemory: ReactNode;
}) {
  const view = sections[section];
  const servers = groups.flatMap(group => {
    if (group.archived) return [];
    const key = group.id ?? "legacy", connection = connections[key];
    const rows = connection?.records.filter(view.matches) ?? [];
    return rows.length && connection ? [{ key, group, connection, rows }] : [];
  });
  const unavailable = groups.filter(group => !group.connected && !group.archived);
  return <main className="page workspace-view">
    <div className="page-heading"><div><h1>{view.title}</h1><p>{view.description}</p></div></div>
    {section === "memory" && sharedMemory}
    {!!unavailable.length && <p className="small">Offline: {unavailable.map(group => group.label).join(", ")}. Previously loaded records may be out of date.</p>}
    {servers.map(({ key, group, connection: owner, rows }) => {
      return <section className="workspace-server" key={key} data-server-id={key} aria-label={`${group.label} ${view.title.toLowerCase()}`}>
        <div className="section-heading"><h2>{group.label}</h2><span>{owner.connected ? "Connected" : "Offline · read-only"}</span></div>
        {section === "decisions" && <>
          {owner.error && <p className="error-text" role="alert">{owner.error}</p>}
          {(owner.info?.pending || owner.info?.pendingError) && <p className="small"><a href={`#settings/servers/${key}/recovery`}>Resolve pending work on {group.label}</a></p>}
          {rows.map(record => <Action key={record.id} record={record} connection={owner} />)}
        </>}
        {section === "outputs" && <EnvironmentContext.Provider value={owner}>
          <ImageViewerProvider records={owner.records}>
            <div className="outputs-grid">{rows.map(record => <Artifact key={record.id} record={record} />)}</div>
          </ImageViewerProvider>
        </EnvironmentContext.Provider>}
        {(section === "automations" || section === "memory") && <div className="workspace-records">{rows.map(record => <article className="record-row" key={record.id}>
          <h2>{title(record)}</h2>
          {section === "memory" && text(record, "text") ? <p className="memory-text">{text(record, "text")}</p> : <pre>{JSON.stringify(record.data, null, 2)}</pre>}
        </article>)}</div>}
      </section>;
    })}
    {!servers.length && <p className="empty-line">{unavailable.length ? "No records from the servers loaded so far." : view.empty}</p>}
  </main>;
}
