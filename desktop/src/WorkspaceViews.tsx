import { useRef, useState, type ReactNode } from "react";
import type { ChatGroup } from "./ChatHistory";
import { EnvironmentContext } from "./EnvironmentContext";
import { Action } from "./TaskAction";
import Automations from "./Automations";
import { ServerNotes } from "./SharedMemory";
import { nativeApp, recordedPreview } from "./api";
import { Badge, Button, Dialog } from "./Interface";
import { actionSummary, exactValue, workspaceBlocker } from "./workspace-presentation";
import { ShieldCheck } from "lucide-react";
import "./workspace-refinement.css";
import Artifact from "./image-viewer/Artifact";
import { ImageViewerProvider } from "./image-viewer/ImageViewer";
import { text, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";

export type WorkspaceSection = "decisions" | "outputs" | "automations" | "memory";
export const isWorkspaceSection = (section: string): section is WorkspaceSection =>
  section === "decisions" || section === "outputs" || section === "automations" || section === "memory";

export function isApproval(record: ServerRecord) {
  return record.kind === "action" && ["pending", "authorized"].includes(text(record, "state"));
}
const serverKey = (group: ChatGroup) => group.id ?? "legacy";
type WorkspaceProps = { groups: ChatGroup[]; connections: Record<string, Connection>; sharedMemory: ReactNode };
type Review = { server: string; record: ServerRecord };

function ApprovalFacts({ record }: { record: ServerRecord }) {
  return <dl className="workspace-facts">
    <div><dt>Exact target</dt><dd>{exactValue(record.data.target)}</dd></div>
    <div><dt>Declared effects</dt><dd>{exactValue(record.data.effects)}</dd></div>
    <div><dt>Tool</dt><dd>{exactValue(record.data.tool)}</dd></div>
  </dl>;
}

function ApprovalReview({ review, groups, connections, close }: { review: Review; groups: ChatGroup[]; connections: Record<string, Connection>; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const writing = useRef(false), latest = useRef({ groups, connections }); latest.current = { groups, connections };
  const owner = connections[review.server];
  const present = groups.some(group => !group.archived && serverKey(group) === review.server);
  const current = owner?.records.find(row => row.kind === "action" && row.id === review.record.id);
  const unchanged = (row: ServerRecord | undefined) => !!row && row.revision === review.record.revision &&
    text(row, "state") === text(review.record, "state") && text(row, "nonce") === text(review.record, "nonce") && text(row, "actionDigest") === text(review.record, "actionDigest");
  const stale = !present || !unchanged(current);
  const blocker = workspaceBlocker(owner, nativeApp(), recordedPreview());
  const command: Connection["command"] = async (kind, id, revision, payload) => {
    if (writing.current) return undefined;
    const live = latest.current.connections[review.server];
    const row = live?.records.find(row => row.kind === "action" && row.id === review.record.id);
    const blocked = workspaceBlocker(live, nativeApp(), recordedPreview());
    if (!latest.current.groups.some(group => !group.archived && serverKey(group) === review.server) || !unchanged(row) || id !== review.record.id || revision !== review.record.revision) {
      setError("This action changed. Close and reopen Review before deciding."); return undefined;
    }
    if (blocked || !live) { setError(blocked); return undefined; }
    if (kind !== "approval.decide" && kind !== "action.dispatch") return undefined;
    writing.current = true; setBusy(true); setError("");
    try {
      const result = await live.command(kind, id, revision, payload);
      if (result?.kind === "action" && result.id === id && result.revision > revision) close();
      else setError("Couldn’t confirm the outcome. Check the action and server recovery before trying again.");
      return result;
    } catch (cause) { setError(`Couldn’t confirm the outcome. Check server recovery before retrying. ${String(cause)}`); return undefined; }
    finally { writing.current = false; setBusy(false); }
  };
  return <Dialog title="Review this action" busy={busy} onClose={() => { if (!writing.current) close(); }} className="workspace-dialog">
    <p>{actionSummary(review.record)}</p>
    <p className="small">Server: {groups.find(group => serverKey(group) === review.server)?.label ?? "Removed server"}</p>
    <ApprovalFacts record={review.record} />
    <p className="small">Approval authorizes this exact action. It does not prove the action ran or succeeded. Review the exact arguments below; declared effects are not a guarantee of all possible effects.</p>
    {stale && <p className="error-text" role="alert">This action changed or is no longer available. Close and reopen Review before deciding.</p>}
    {blocker && <p role="status" className="small">{blocker}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {owner && <fieldset className="workspace-approval-list" disabled={stale || !!blocker || busy || !!error}>
      <Action record={review.record} connection={{ ...owner, busy: owner.busy || busy || stale || !!blocker || !!error, command }} />
    </fieldset>}
    <div className="workspace-dialog-actions"><Button disabled={busy} onClick={close}>Close review</Button></div>
  </Dialog>;
}

function MemoryView({ groups, connections, sharedMemory }: WorkspaceProps) {
  const [scope, setScope] = useState<"shared" | "server">("shared");
  const [selection, setSelection] = useState("");
  const available = groups.filter(group => !group.archived);
  const server = selection || (available[0] ? serverKey(available[0]) : "");
  return <main className="page workspace-view workspace-refinement">
    <div className="page-heading"><div><h1>Memory</h1><p>Keep notes for every server or just one.</p></div></div>
    <div className="workspace-toolbar workspace-scope-row">
      <div className="workspace-scope" role="group" aria-label="Where the note is kept">
        <Button aria-pressed={scope === "shared"} onClick={() => setScope("shared")}>All servers</Button>
        <Button aria-pressed={scope === "server"} onClick={() => setScope("server")}>One server</Button>
      </div>
      {scope === "server" && <label>Server<select aria-label="Server" value={server} onChange={event => setSelection(event.target.value)}>
        {!available.some(group => serverKey(group) === server) && <option value={server}>Select a server</option>}
        {available.map(group => <option key={serverKey(group)} value={serverKey(group)}>{group.label}{connections[serverKey(group)]?.connected ? "" : " · Offline"}</option>)}
      </select></label>}
    </div>
    {scope === "shared" ? sharedMemory : <ServerNotes key={server} server={server} groups={groups} connections={connections} />}
  </main>;
}

export default function WorkspaceView({ section, groups, connections, sharedMemory }: WorkspaceProps & { section: WorkspaceSection }) {
  const [review, setReview] = useState<Review | null>(null);
  if (section === "automations") return <Automations groups={groups} connections={connections} />;
  if (section === "memory") return <MemoryView groups={groups} connections={connections} sharedMemory={sharedMemory} />;
  const decisions = section === "decisions";
  const servers = groups.flatMap(group => {
    if (group.archived) return [];
    const key = serverKey(group), connection = connections[key];
    const rows = connection?.records.filter(row => decisions ? isApproval(row) : row.kind === "artifact") ?? [];
    return rows.length && connection ? [{ key, group, connection, rows }] : [];
  });
  const unavailable = groups.filter(group => !connections[serverKey(group)]?.connected && !group.archived);
  return <main className="page workspace-view workspace-refinement">
    <div className="page-heading"><div><h1>{decisions ? "Approvals" : "Library"}</h1><p>{decisions ? "Actions waiting for review or dispatch across your servers." : "Files, screenshots and results from all your servers."}</p></div></div>
    {!!unavailable.length && <p className="small">Offline: {unavailable.map(group => group.label).join(", ")}. Previously loaded records may be out of date.</p>}
    {servers.map(({ key, group, connection: owner, rows }) => <section className="workspace-server" key={key} data-server-id={key} aria-label={`${group.label} ${decisions ? "approvals" : "library"}`}>
      <div className="section-heading"><h2>{group.label}</h2><span>{owner.connected ? "Connected" : "Offline · read-only"}</span></div>
      {decisions ? <>
        {owner.error && <p className="error-text" role="alert">{owner.error}</p>}
        {(owner.info?.pending || owner.info?.pendingError) && <p className="small"><a href={`#settings/servers/${key}/recovery`}>Resolve pending work on {group.label}</a></p>}
        <div className="workspace-list">{rows.map(record => <article className="workspace-item workspace-approval" key={record.id}>
          <ShieldCheck size={19} aria-hidden="true" /><div className="workspace-item-body">
            <div className="workspace-item-heading"><h3>{actionSummary(record)}</h3><Badge tone={owner.connected ? "warning" : "neutral"}>{!owner.connected ? "Last known: " : ""}{text(record, "state") === "authorized" ? "Authorized · not yet dispatched" : "Waiting for review"}</Badge></div>
            <ApprovalFacts record={record} />
            <details className="workspace-exact"><summary>Exact arguments</summary><pre>{exactValue(record.data.arguments)}</pre></details>
          </div><Button onClick={() => setReview({ server: key, record })}>Review this action</Button>
        </article>)}</div>
      </> : <EnvironmentContext.Provider value={owner}><ImageViewerProvider records={owner.records}>
        <div className="outputs-grid">{rows.map(record => <Artifact key={record.id} record={record} />)}</div>
      </ImageViewerProvider></EnvironmentContext.Provider>}
    </section>)}
    {!servers.length && (decisions ? <div className="workspace-empty">
      <ShieldCheck size={24} aria-hidden="true" /><h2>Nothing needs your approval</h2>
      <p>When a task needs your decision, its real action appears here with the exact target and effects to review before approval or dispatch.</p>
      <p className="small">Ask permission holds proposed actions for review. Auto review may also need your decision. Offline servers can have actions not loaded here yet.</p>
      <p className="small">Open All chats in the sidebar to follow a task’s progress.</p>
    </div> : <p className="empty-line">{unavailable.length ? "No records from the servers loaded so far." : "No outputs yet."}</p>)}
    {decisions && review && <ApprovalReview review={review} groups={groups} connections={connections} close={() => setReview(null)} />}
  </main>;
}
