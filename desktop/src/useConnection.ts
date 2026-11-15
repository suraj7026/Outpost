import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { environmentApi, nativeApp, recordedPreview, type EnvironmentId } from "./api";
import type { Catalogue } from "./agent/types";
import { Channel } from "@tauri-apps/api/core";
import { ollamaCloudModels } from "./models";
import { mergeRecords, overlayLive, type LiveFrame } from "./live";
import type { ConnectionInfo, EventPage, Json, ModelCatalogue, RuntimeInfo, ServerRecord, Snapshot } from "./types";

const transportFailure = (message: string) => /Cannot reach your server\.|Private SSH connection is unavailable|error sending request|error decoding response body|operation timed out/.test(message);

/** One mounted supervisor per owner. Selection never changes this supervisor's identity. */
export function useConnection(environmentId: EnvironmentId = null, route = "", retired = false) {
  const api = useMemo(() => environmentApi(environmentId), [environmentId]);
  const [records, setRecords] = useState<ServerRecord[]>([]), [liveRecords, setLiveRecords] = useState<ServerRecord[]>([]);
  const [info, setInfo] = useState<ConnectionInfo | null>(null), [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [models, setModels] = useState<string[]>([]), [agentCatalogue, setAgentCatalogue] = useState<Catalogue | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false), [streaming, setStreaming] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [lastSync, setLastSync] = useState<Date | null>(null);
  const generation = useRef(0), cursor = useRef(0), catalogueRevision = useRef(0), infoRevision = useRef(0);
  const alive = useRef(false), paused = useRef(false), executing = useRef(false), syncing = useRef(false), streamActive = useRef(false);
  const authority = useRef({ connected, retired, pending: !!info?.pending || !!info?.pendingError });
  authority.current = { connected, retired, pending: !!info?.pending || !!info?.pendingError };
  const lifecycle = useRef(info?.lifecycle); lifecycle.current = info?.lifecycle;
  const current = useCallback((ticket: number) => alive.current && ticket === generation.current, []);
  const refreshInfo = useCallback(async () => {
    const ticket = generation.current, revision = ++infoRevision.current;
    const next = await api.call<ConnectionInfo>("connection_info");
    if (current(ticket) && revision === infoRevision.current) setInfo(next);
    return next;
  }, [api, current]);
  const refreshAgent = useCallback(async (network = false) => {
    const ticket = generation.current, revision = ++catalogueRevision.current;
    try {
      if (retired) throw new Error("Legacy mutations retired. Select the verified environment.");
      const value = await api.agentRequest<Catalogue>({ type: network ? "refresh" : "catalogue" });
      if (value.protocolVersion !== 1) throw new Error("Server provider protocol requires a desktop update.");
      if (current(ticket) && revision === catalogueRevision.current) setAgentCatalogue(value);
      return value;
    } catch {
      if (current(ticket) && revision === catalogueRevision.current) setAgentCatalogue(null);
      throw new Error("Provider catalogue unavailable. Refresh before selecting a model.");
    }
  }, [api, retired, current]);
  const refresh = useCallback(async () => {
    const ticket = generation.current;
    try {
      const snapshot = await api.query<Snapshot>("snapshot");
      if (!current(ticket)) return;
      if (snapshot.cursor >= cursor.current) {
        cursor.current = snapshot.cursor;
        setRecords(snapshot.records);
      }
      setConnected(true); setLastSync(new Date());
      await refreshInfo();
    } catch (error) { if (current(ticket)) setConnected(false); throw error; }
  }, [api, current, refreshInfo]);
  const disconnect = useCallback(async () => {
    paused.current = true; ++generation.current; ++catalogueRevision.current;
    streamActive.current = false; syncing.current = false;
    setConnected(false); setConnecting(false); setStreaming(false); setLiveRecords([]);
    await api.disconnect(true);
    await refreshInfo();
  }, [api, refreshInfo]);
  const connect = useCallback(async (resume = false) => {
    paused.current = false;
    const ticket = ++generation.current;
    // A restored installation may rewind its ledger. Keep stale records visible,
    // but establish this lifecycle's cursor from its first authoritative snapshot.
    cursor.current = 0;
    syncing.current = true; streamActive.current = false; setConnecting(true);
    setConnected(false); setStreaming(false); setLiveRecords([]);
    setModels([]); setRuntime(null); setAgentCatalogue(null); ++catalogueRevision.current;
    try {
      // Await cancellation before starting a successor; obsolete connect attempts never start streams.
      await api.disconnect();
      if (!current(ticket)) return;
      if (resume && environmentId !== null && lifecycle.current) {
        await api.call("connection_policy", { enabled: true });
        if (!current(ticket)) return;
      }
      const nextInfo = await refreshInfo();
      if (!current(ticket)) return;
      if (environmentId === null && !nextInfo.endpoint) {
        paused.current = true;
        setRecords([]); setLastSync(null); setError("");
        return;
      }
      if (nextInfo.lifecycle && nextInfo.lifecycle.state !== "connected") {
        paused.current = nextInfo.lifecycle.state === "paused";
        setError(nextInfo.lifecycle.state === "needs_attention" ? nextInfo.lifecycle.error || "Saved server access needs attention." : "");
        return;
      }
      await refresh();
      if (!current(ticket)) return;
      setError("");
      const runtimeInfo = await api.query<RuntimeInfo>("runtime");
      if (!current(ticket)) return;
      setRuntime(runtimeInfo);
      try {
        if (runtimeInfo.piManagement && !recordedPreview() && !retired) await refreshAgent();
        else {
          const catalogue = await api.query<ModelCatalogue>("models");
          if (current(ticket)) setModels(ollamaCloudModels(catalogue.models));
        }
      } catch (error) { if (current(ticket)) setError(`Server connected, but the model catalogue is unavailable: ${String(error)}`); }
      if (!current(ticket) || !nativeApp() || recordedPreview()) return;
      const channel = new Channel<LiveFrame>();
      channel.onmessage = (frame) => {
        if (!current(ticket)) return;
        streamActive.current = true; setStreaming(true); setConnected(true); setLastSync(new Date());
        if (frame.type === "snapshot") {
          if (frame.cursor < cursor.current) return;
          cursor.current = frame.cursor; setRecords(frame.records); setLiveRecords(frame.live);
        } else if (frame.type === "records") {
          cursor.current = Math.max(cursor.current, frame.cursor);
          setRecords(previous => mergeRecords(previous, frame.records));
        } else if (frame.type === "live") {
          setLiveRecords(previous => [...previous.filter(row => row.id !== frame.record.id || row.kind !== frame.record.kind), frame.record]);
        } else if (frame.type === "settled") {
          setRecords(previous => mergeRecords(previous, [frame.record]));
          setLiveRecords(previous => previous.filter(row => row.id !== frame.record.id || row.kind !== frame.record.kind));
        }
      };
      void api.call("stream_events", { channel }).catch(error => {
        if (current(ticket)) setError(lifecycle.current && transportFailure(String(error)) ? "" : `Live connection interrupted. ${String(error)}`);
      }).finally(() => {
        if (current(ticket)) { streamActive.current = false; setStreaming(false); setConnected(false); setLiveRecords([]); }
      });
    } catch (error) { if (current(ticket)) {
      setConnected(false);
      const message = String(error);
      setError(lifecycle.current && transportFailure(message) ? "" : message);
    } }
    finally { if (current(ticket)) { syncing.current = false; setConnecting(false); } }
  }, [api, current, refresh, refreshInfo, refreshAgent, environmentId, retired]);
  useEffect(() => {
    alive.current = true;
    void connect();
    return () => { alive.current = false; ++generation.current; ++catalogueRevision.current; void api.disconnect().catch(() => {}); };
  }, [connect, api, route]);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (paused.current || syncing.current || executing.current || streamActive.current) return;
      if (!connected) { void connect(); return; }
      const ticket = generation.current;
      syncing.current = true;
      try {
        let page: EventPage;
        do {
          page = await api.query<EventPage>("events", { after: cursor.current });
          if (!current(ticket) || streamActive.current) return;
          cursor.current = page.nextCursor;
          setRecords(previous => mergeRecords(previous, page.events.map(event => event.payload)));
        } while (page.hasMore);
        setLastSync(new Date());
      } catch (error) { if (current(ticket)) { setConnected(false); setError(lifecycle.current && transportFailure(String(error)) ? "" : String(error)); } }
      finally { if (current(ticket)) syncing.current = false; }
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, connect, api, current]);
  const perform = useCallback(async <T,>(operation: () => Promise<T>, recovery = false): Promise<T | undefined> => {
    if (executing.current || !alive.current || authority.current.retired || (!recovery && (!authority.current.connected || authority.current.pending))) return;
    executing.current = true; setBusy(true); setError("");
    const ticket = generation.current;
    try {
      const result = await operation();
      if (!current(ticket)) return result;
      try { await refresh(); } catch (error) {
        if (current(ticket)) setError(`Command accepted. History refresh failed; do not submit it again. ${String(error)}`);
      }
      return result;
    } catch (error) {
      if (current(ticket)) {
        setError(String(error));
        await refreshInfo().catch(() => {});
      }
      return undefined;
    } finally {
      // Reconnect may have observed this operation's pending slot. Discard its old
      // history result, but reconcile native recovery state in the current lifecycle.
      // Failed reads retain the last known blocker; never infer clearance from success.
      if (alive.current && ticket !== generation.current) await refreshInfo().catch(() => {});
      executing.current = false;
      if (alive.current) setBusy(false);
    }
  }, [current, refresh, refreshInfo]);
  const command = useCallback((kind: string, id: string, revision: number, payload: Record<string, Json> = {}) =>
    perform(() => api.send(kind, id, revision, payload)), [api, perform]);
  const combinedRecords = useMemo(() => overlayLive(records, liveRecords), [records, liveRecords]);
  const reconnecting = !!info?.lifecycle && !connected && !["paused", "needs_attention"].includes(info.lifecycle.state);
  const resume = useCallback(() => connect(true), [connect]);
  return useMemo(() => ({ environmentId, api, retired, records: combinedRecords, streaming, info, runtime, models, agentCatalogue,
    refreshAgent, connected, connecting, reconnecting, busy, error, lastSync, connect: resume, disconnect, refresh, perform, command, setError }),
  [environmentId, api, retired, combinedRecords, streaming, info, runtime, models, agentCatalogue, refreshAgent, connected, connecting, reconnecting, busy, error, lastSync, resume, disconnect, refresh, perform, command]);
}
export type Connection = ReturnType<typeof useConnection>;
