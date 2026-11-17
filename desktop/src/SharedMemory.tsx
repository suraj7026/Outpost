import { useEffect, useId, useReducer, useRef, useState } from "react";
import { nativeApp, recordedPreview } from "./api";
import type { ChatGroup } from "./ChatHistory";
import type { Connection } from "./useConnection";
import { text } from "./types";
import { NotebookPen, Plus, X } from "lucide-react";
import { Button, Dialog } from "./Interface";
import { relativeTime, saveServerNote, serverNotePayload, workspaceBlocker } from "./workspace-presentation";
import "./workspace-refinement.css";

type Replica = { id: string; label: string; connection: Connection | undefined };
type Note = { id: string; text: string | null; updatedAt: string; copies: Map<string, string | null> };
type Attempt = { server: string; note: string; value: string | null; status: "sending" | "sent" | "failed" };
const attemptKey = (server: string, note: string) => `${server}:${note}`;
const writable = (connection: Connection | undefined): connection is Connection =>
  !!(connection?.connected && connection.runtime?.sharedMemory && !connection.retired &&
    !connection.busy && connection.info && !connection.info.pending && !connection.info.pendingError);

export function useSharedMemory(groups: ChatGroup[], connections: Record<string, Connection>) {
  const enabled = nativeApp() && !recordedPreview();
  const replicas: Replica[] = groups.flatMap(group =>
    group.id && !group.archived ? [{ id: group.id, label: group.label, connection: connections[group.id] }] : []);
  const notes = new Map<string, Note>();
  for (const { id, connection } of replicas) {
    for (const row of connection?.records ?? []) {
      if (row.kind !== "memory" || row.data.shared !== true || row.data.confirmed !== true) continue;
      const value = row.data.forgotten === true ? null : text(row, "text");
      if (value === "") continue;
      const note = notes.get(row.id) ?? { id: row.id, text: value, updatedAt: row.updatedAt, copies: new Map() };
      // A tombstone wins even if its server is now offline, and even if another
      // installation's clock makes its original copy appear newer.
      if (value === null) note.text = null;
      note.copies.set(id, value);
      if (row.updatedAt > note.updatedAt) note.updatedAt = row.updatedAt;
      notes.set(row.id, note);
    }
  }
  const attempts = useRef(new Map<string, Attempt>());
  const sending = useRef(new Set<string>());
  const previouslyConnected = useRef(new Set<string>());
  const [, update] = useReducer((version: number) => version + 1, 0);
  const live = new Set(replicas.filter(replica => replica.connection?.connected).map(replica => replica.id));
  const isMissing = (note: Note, id: string) => note.copies.get(id) !== note.text;
  const submit = async (replica: Replica, note: string, value: string | null) => {
    const connection = replica.connection;
    if (!writable(connection) || sending.current.has(replica.id)) return false;
    const key = attemptKey(replica.id, note);
    const attempt: Attempt = { server: replica.id, note, value, status: "sending" };
    attempts.current.set(key, attempt);
    sending.current.add(replica.id);
    try {
      const result = await connection.command("memory.shared", note, 0, { text: value });
      const saved = result?.kind === "memory" && result.id === note && result.data.shared === true;
      attempt.status = saved ? "sent" : "failed";
      return saved;
    } finally {
      if (attempt.status === "sending") attempt.status = "failed";
      sending.current.delete(replica.id);
      update();
    }
  };
  useEffect(() => {
    if (!enabled) return;
    for (const [key, attempt] of attempts.current) {
      if (attempt.status === "sending") continue;
      const note = notes.get(attempt.note);
      if (live.has(attempt.server) && !previouslyConnected.current.has(attempt.server) ||
          note && !isMissing(note, attempt.server) || !replicas.some(replica => replica.id === attempt.server)) {
        attempts.current.delete(key);
      }
    }
    previouslyConnected.current = live;
    for (const replica of replicas) {
      if (!writable(replica.connection) || sending.current.has(replica.id)) continue;
      const next = [...notes.values()].find(note => isMissing(note, replica.id) &&
        // A save or deletion must have been observed on a reachable verified
        // server before it can be sent to another one.
        [...note.copies].some(([id, value]) => live.has(id) && value === note.text) &&
        attempts.current.get(attemptKey(replica.id, note.id))?.value !== note.text);
      if (next) void submit(replica, next.id, next.text);
    }
  });
  const save = async (id: string, value: string | null) => {
    const target = replicas.find(replica => writable(replica.connection) && !sending.current.has(replica.id));
    return enabled && !!target && submit(target, id, value);
  };
  const retry = () => {
    for (const [key, attempt] of attempts.current) {
      if (attempt.status !== "sending") attempts.current.delete(key);
    }
    update();
  };
  return { enabled, replicas, notes: [...notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), save,
    ready: enabled && replicas.some(replica => writable(replica.connection) && !sending.current.has(replica.id)),
    failed: [...attempts.current.values()].some(attempt => {
      const note = notes.get(attempt.note);
      return attempt.status === "failed" && note?.text === attempt.value && isMissing(note, attempt.server);
    }), retry };
}

export default function SharedMemory({ memory }: { memory: ReturnType<typeof useSharedMemory> }) {
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), noteInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!creating) return;
    dialog.current?.showModal();
    noteInput.current?.focus({ preventScroll: true });
    return () => { dialog.current?.close(); trigger.current?.focus(); };
  }, [creating]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const draftId = useRef<string | null>(null);
  const writing = useRef(false);
  const dismiss = () => { if (!writing.current) setCreating(false); };
  const save = async (id: string, value: string | null) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      if (!await memory.save(id, value)) {
        setError("Couldn’t confirm the change. Try again or check the server’s recovery settings.");
        return;
      }
      setMessage(value === null ? "Note forgotten. The deletion will sync to your other servers." : "Note saved. It will sync to your other servers.");
      if (value === null) setConfirm(null);
      else { setDraft(""); draftId.current = null; setCreating(false); }
    } catch (cause) { setError(`Couldn’t confirm the change. Check server recovery before retrying. ${String(cause)}`); }
    finally { writing.current = false; setBusy(false); }
  };
  const missing = memory.replicas.filter(replica => memory.notes.some(note => note.copies.get(replica.id) !== note.text));
  const waiting = missing.filter(replica => !replica.connection?.connected);
  const unsupported = memory.replicas.filter(replica => replica.connection?.connected && replica.connection.runtime && !replica.connection.runtime.sharedMemory);
  const blocked = missing.filter(replica => replica.connection?.connected && (replica.connection.info?.pending || replica.connection.info?.pendingError));
  return <section className="shared-memory workspace-refinement" aria-label="Shared Memory">
    <div className="section-heading"><h2>Shared Memory</h2><button ref={trigger} className="primary" disabled={!memory.enabled || !memory.ready || busy} onClick={() => { setCreating(true); setError(""); }}><Plus size={14} /> New shared note</button></div>
    <p className="small">Shared notes sync to all verified servers as they connect to this Mac. Notes cannot be edited; forget a shared note and create a replacement.</p>
    {memory.enabled && <>
      {memory.replicas.length === 0 && <p><a href="#settings/servers">Add a verified server</a> to share notes.</p>}
      {creating && <dialog className="workspace-dialog workspace-form-dialog" ref={dialog} aria-labelledby="memory-dialog-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
        <form onSubmit={event => {
          event.preventDefault();
          if (!memory.ready || busy || !draft.trim()) return;
          draftId.current ??= crypto.randomUUID();
          void save(draftId.current, draft.trim());
        }}>
          <header className="ui-dialog-heading"><h2 id="memory-dialog-title">New shared note</h2><Button className="ui-close" variant="ghost" aria-label="Close dialog" title="Close dialog" disabled={busy} onClick={dismiss}><X size={18} aria-hidden="true" /></Button></header>
          <div className="dialog-form-body">
          <p className="small">Saved to a reachable verified server first, then replicated as your other servers connect to this Mac. This is not an edit to an existing note.</p>
          <label className="workspace-note-field" htmlFor="shared-memory-note">Note<textarea ref={noteInput} autoFocus id="shared-memory-note" value={draft} required maxLength={20000} rows={7} disabled={busy}
            onChange={event => { draftId.current = null; setDraft(event.target.value); }} /></label>
          {!memory.ready && <p role="status" className="small">A connected, writable server with Shared Memory enabled is required.</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          </div>
          <footer className="workspace-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button className="primary" disabled={!memory.ready || busy || !draft.trim()}>{busy ? "Saving…" : "Save shared note"}</button></footer>
        </form>
      </dialog>}
      {!!memory.replicas.length && !memory.ready && !busy && <p className="small">A connected server with Shared Memory enabled is needed to save or forget notes.</p>}
      {unsupported.map(replica => <p className="small" key={replica.id}>{replica.label} needs a server update for Shared Memory.</p>)}
      {!!waiting.length && <p className="small">Waiting for {waiting.map(replica => replica.label).join(", ")} to reconnect.</p>}
      {blocked.map(replica => <p className="small" key={replica.id}><a href={`#settings/servers/${replica.id}/recovery`}>Resolve pending work on {replica.label}</a> to continue syncing.</p>)}
      {memory.failed && <p role="status">Some copies couldn’t sync. <button onClick={memory.retry}>Retry sync</button></p>}
      {error && !creating && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="small" role="status">{message}</p>}
    </>}
    {!memory.enabled && <p className="small">Shared notes are read-only in browser previews. Use the desktop app to create or forget a note.</p>}
    <div className="workspace-records">{memory.notes.filter(note => note.text !== null).map(note => <article className="record-row workspace-note-card" key={note.id}>
      <p className="workspace-note">{note.text}</p>
      <p className="small">Shared note · <time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>{relativeTime(note.updatedAt)}</time></p>
      <p className="small">Saved on {memory.replicas.filter(replica => note.copies.get(replica.id) === note.text).length} of {memory.replicas.length} servers: {memory.replicas.filter(replica => note.copies.get(replica.id) === note.text).map(replica => replica.label).join(", ") || "Waiting for confirmation"}</p>
      {memory.enabled && (confirm === note.id ? <div className="button-row">
        <button onClick={() => setConfirm(null)} disabled={busy}>Keep note</button>
        <button onClick={() => void save(note.id, null)} disabled={!memory.ready || busy}>Forget on all servers</button>
      </div> : <button onClick={() => setConfirm(note.id)} disabled={!memory.ready || busy}>Forget shared note…</button>)}
    </article>)}</div>
    {!memory.notes.some(note => note.text !== null) && <p className="small">No shared notes yet.</p>}
    {memory.notes.some(note => note.text === null && memory.replicas.some(replica => !note.copies.has(replica.id) || note.copies.get(replica.id) !== null)) && <p className="small">A deletion is still syncing to your servers.</p>}
  </section>;
}

export function ServerNotes({ server, groups, connections }: { server: string; groups: ChatGroup[]; connections: Record<string, Connection> }) {
  const formId = useId();
  const [creating, setCreating] = useState(false), [draft, setDraft] = useState(""), [project, setProject] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [uncertain, setUncertain] = useState(false);
  const writing = useRef(false), latest = useRef({ groups, connections }); latest.current = { groups, connections };
  const group = groups.find(group => !group.archived && (group.id ?? "legacy") === server), owner = connections[server];
  const blocker = !group ? "Select an available server." : workspaceBlocker(owner, nativeApp(), recordedPreview());
  const notes = owner?.records.filter(row => row.kind === "memory" && row.data.shared !== true && row.data.forgotten !== true) ?? [];
  const submit = async () => {
    if (writing.current || uncertain) return;
    setError("");
    const connection = latest.current.connections[server];
    try {
      if (!latest.current.groups.some(group => !group.archived && (group.id ?? "legacy") === server)) throw new Error("This server was removed. Close this note.");
      const blocked = workspaceBlocker(connection, nativeApp(), recordedPreview());
      if (blocked) throw new Error(blocked);
      serverNotePayload(draft, project);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    writing.current = true; setBusy(true);
    try {
      await saveServerNote(connection, crypto.randomUUID(), draft, project, nativeApp(), recordedPreview());
      setDraft(""); setProject(""); setCreating(false); setNotice(`Note saved on ${group?.label ?? "this server"} only.`);
    } catch (cause) {
      // The server allocates a new ID on every save, so an uncertain result must not be resubmitted.
      setUncertain(true);
      setError(`Save not confirmed. Check this server’s notes and recovery before creating another note; it may already have been saved. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { writing.current = false; setBusy(false); }
  };
  return <section className="workspace-server" aria-label="Server notes">
    <div className="section-heading"><h2>{group?.label ?? "Server notes"}</h2><Button variant="primary" disabled={!!blocker || busy || uncertain} onClick={() => { setCreating(true); setError(""); setNotice(""); }}><Plus size={14} />New server note</Button></div>
    <p className="small">These notes stay on this server, in the project supplied when saved. Existing notes are read-only.</p>
    {blocker && <p className="small" role="status">{blocker}{!owner?.connected && " Previously loaded notes may be out of date."}</p>}
    {(owner?.info?.pending || owner?.info?.pendingError || uncertain) && <p className="small"><a href={`#settings/servers/${server}/recovery`}>Check server recovery</a></p>}
    {notice && <p role="status">{notice}</p>}{error && !creating && <p role="alert" className="error-text">{error}</p>}
    <div className="workspace-records">{notes.map(note => <article key={note.id} className="record-row workspace-note-card">
      <p className="workspace-note">{text(note, "text") || "No note text recorded."}</p>
      <p className="small">Kept on {group?.label ?? "this server"} only · <time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>{relativeTime(note.updatedAt)}</time></p>
      <details className="workspace-sync"><summary>Source and scope</summary><p className="small">Project: {text(note, "project") || "Not supplied"} · Identity: {text(note, "identityId") || "Not supplied"}</p><p className="small">Source: {text(note, "source") || "Not supplied"} · Provenance: {text(note, "provenance") || "Not supplied"}</p></details>
    </article>)}</div>
    {!notes.length && <div className="workspace-empty"><NotebookPen size={24} aria-hidden="true" /><h2>No server notes loaded</h2><p>{owner?.connected ? "Save local paths, downtime windows or other details for this server." : "Connect this server to load its notes."}</p></div>}
    {creating && <Dialog title="New server note" busy={busy} onClose={() => { if (!writing.current) setCreating(false); }} className="workspace-dialog" footer={<>
      <Button disabled={busy} onClick={() => { if (!writing.current) setCreating(false); }}>Cancel</Button><Button type="submit" form={formId} variant="primary" disabled={!!blocker || busy || uncertain || !draft.trim() || !project.trim()}>{busy ? "Saving…" : "Save server note"}</Button>
    </>}>
      <form id={formId} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <fieldset className="workspace-fields" disabled={busy || uncertain}>
          <label>Note<textarea autoFocus required maxLength={20000} rows={6} value={draft} onChange={event => setDraft(event.target.value)} /></label>
          <label>Project<input required value={project} onChange={event => setProject(event.target.value)} placeholder="Exact project name" /></label>
          <p className="small">Save to {group?.label ?? "removed server"} only. The server searches notes by exact project and identity; this note uses identity “owner”, owner provenance, and source “Outpost desktop · server note”. It will not be copied to other servers.</p>
        </fieldset>
        {blocker && <p role="status" className="small">{blocker}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </form>
    </Dialog>}
  </section>;
}
