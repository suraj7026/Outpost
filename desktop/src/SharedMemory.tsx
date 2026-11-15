import { useEffect, useReducer, useRef, useState } from "react";
import { nativeApp, recordedPreview } from "./api";
import type { ChatGroup } from "./ChatHistory";
import type { Connection } from "./useConnection";
import { text } from "./types";

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
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const draftId = useRef<string | null>(null);
  const writing = useRef(false);
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
      else { setDraft(""); draftId.current = null; }
    } finally { writing.current = false; setBusy(false); }
  };
  const missing = memory.replicas.filter(replica => memory.notes.some(note => note.copies.get(replica.id) !== note.text));
  const waiting = missing.filter(replica => !replica.connection?.connected);
  const unsupported = memory.replicas.filter(replica => replica.connection?.connected && replica.connection.runtime && !replica.connection.runtime.sharedMemory);
  const blocked = missing.filter(replica => replica.connection?.connected && (replica.connection.info?.pending || replica.connection.info?.pendingError));
  return <section className="shared-memory" aria-label="Shared Memory">
    <div className="section-heading"><h2>Shared Memory</h2></div>
    <p className="small">Shared notes sync to all verified servers as they connect to this Mac. Server notes stay where they were saved.</p>
    {memory.enabled && <>
      {memory.replicas.length === 0 ? <p><a href="#settings/servers">Add a verified server</a> to share notes.</p> : <form className="shared-memory-form" onSubmit={event => {
        event.preventDefault();
        if (!memory.ready || !draft.trim()) return;
        draftId.current ??= crypto.randomUUID();
        void save(draftId.current, draft.trim());
      }}>
        <label htmlFor="shared-memory-note">New shared note</label>
        <textarea id="shared-memory-note" value={draft} required maxLength={20000} rows={3} disabled={busy}
          onChange={event => { draftId.current = null; setDraft(event.target.value); }} />
        <button className="primary" disabled={!memory.ready || busy || !draft.trim()}>Save to all servers</button>
      </form>}
      {!!memory.replicas.length && !memory.ready && !busy && <p className="small">A connected server with Shared Memory enabled is needed to save or forget notes.</p>}
      {unsupported.map(replica => <p className="small" key={replica.id}>{replica.label} needs a server update for Shared Memory.</p>)}
      {!!waiting.length && <p className="small">Waiting for {waiting.map(replica => replica.label).join(", ")} to reconnect.</p>}
      {blocked.map(replica => <p className="small" key={replica.id}><a href={`#settings/servers/${replica.id}/recovery`}>Resolve pending work on {replica.label}</a> to continue syncing.</p>)}
      {memory.failed && <p role="status">Some copies couldn’t sync. <button onClick={memory.retry}>Retry sync</button></p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="small" role="status">{message}</p>}
    </>}
    <div className="workspace-records">{memory.notes.filter(note => note.text !== null).map(note => <article className="record-row" key={note.id}>
      <p className="memory-text">{note.text}</p>
      <p className="small">Saved on {memory.replicas.filter(replica => note.copies.get(replica.id) === note.text).length} of {memory.replicas.length} servers</p>
      {memory.enabled && (confirm === note.id ? <div className="button-row">
        <button onClick={() => setConfirm(null)} disabled={busy}>Keep note</button>
        <button onClick={() => void save(note.id, null)} disabled={!memory.ready || busy}>Forget on all servers</button>
      </div> : <button onClick={() => setConfirm(note.id)} disabled={!memory.ready || busy}>Forget shared note…</button>)}
    </article>)}</div>
    {!memory.notes.some(note => note.text !== null) && <p className="small">No shared notes yet.</p>}
    {memory.notes.some(note => note.text === null && memory.replicas.some(replica => !note.copies.has(replica.id) || note.copies.get(replica.id) !== null)) && <p className="small">A deletion is still syncing to your servers.</p>}
  </section>;
}
