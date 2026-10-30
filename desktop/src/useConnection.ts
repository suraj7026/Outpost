import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call, query, send, nativeApp, recordedPreview } from "./api";
import { Channel } from "@tauri-apps/api/core";
import { mergeRecords, overlayLive, type LiveFrame } from "./live";
import type {
  ConnectionInfo,
  EventPage,
  Json,
  ModelCatalogue,
  RuntimeInfo,
  ServerRecord,
  Snapshot,
} from "./types";

export function useConnection() {
  const [records, setRecords] = useState<ServerRecord[]>([]);
  const [liveRecords, setLiveRecords] = useState<ServerRecord[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamActive = useRef(false);
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const cursor = useRef(0),
    syncing = useRef(false),
    executing = useRef(false);
  const refresh = useCallback(async () => {
    const snapshot = await query<Snapshot>("snapshot").catch((error) => {
      setConnected(false);
      throw error;
    });
    cursor.current = snapshot.cursor;
    setRecords((previous) =>
      streamActive.current
        ? mergeRecords(previous, snapshot.records)
        : snapshot.records,
    );
    setConnected(true);
    setLastSync(new Date());
    setInfo(await call<ConnectionInfo>("connection_info"));
  }, []);
  const connect = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      setInfo(await call<ConnectionInfo>("connection_info"));
      await refresh();
      setError("");
      setRuntime(await query<RuntimeInfo>("runtime"));
      try {
        const catalogue = await query<ModelCatalogue>("models");
        setModels(catalogue.models);
      } catch (error) {
        setError(
          `Server connected, but the model catalogue is unavailable: ${String(error)}`,
        );
      }
    } catch (error) {
      setConnected(false);
      setError(String(error));
    } finally {
      syncing.current = false;
    }
  }, [refresh]);
  useEffect(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (!connected || !nativeApp() || recordedPreview()) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      const channel = new Channel<LiveFrame>();
      channel.onmessage = (frame) => {
        if (!active) return;
        streamActive.current = true;
        setStreaming(true);
        setLastSync(new Date());
        if (frame.type === "snapshot") {
          cursor.current = frame.cursor;
          setRecords(frame.records);
          setLiveRecords(frame.live);
          setError((previous) =>
            previous.startsWith("Live connection interrupted;") ? "" : previous,
          );
        } else if (frame.type === "records") {
          cursor.current = Math.max(cursor.current, frame.cursor);
          setRecords((previous) => mergeRecords(previous, frame.records));
        } else if (frame.type === "live") {
          setLiveRecords((previous) => [
            ...previous.filter(
              (record) =>
                record.id !== frame.record.id ||
                record.kind !== frame.record.kind,
            ),
            frame.record,
          ]);
        } else if (frame.type === "settled") {
          setRecords((previous) => mergeRecords(previous, [frame.record]));
          setLiveRecords((previous) =>
            previous.filter(
              (record) =>
                record.id !== frame.record.id ||
                record.kind !== frame.record.kind,
            ),
          );
        }
      };
      try {
        await call("stream_events", { channel });
      } catch (error) {
        if (active)
          setError(
            `Live connection interrupted; reconnecting. ${String(error)}`,
          );
      } finally {
        if (active) {
          streamActive.current = false;
          setStreaming(false);
          retry = setTimeout(() => void start(), 1000);
        }
      }
    };
    void start();
    return () => {
      active = false;
      clearTimeout(retry);
      streamActive.current = false;
      setStreaming(false);
    };
  }, [connected]);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (syncing.current || executing.current || streamActive.current) return;
      if (!connected) {
        void connect();
        return;
      }
      syncing.current = true;
      try {
        let page: EventPage;
        do {
          page = await query<EventPage>("events", { after: cursor.current });
          if (streamActive.current) return;
          cursor.current = page.nextCursor;
          if (page.events.length)
            setRecords((previous) => {
              const rows = new Map(
                previous.map((record) => [
                  `${record.kind}:${record.id}`,
                  record,
                ]),
              );
              for (const event of page.events) {
                const row = event.payload,
                  key = `${row.kind}:${row.id}`;
                if (!rows.has(key) || rows.get(key)!.revision < row.revision)
                  rows.set(key, row);
              }
              return [...rows.values()];
            });
        } while (page.hasMore);
        setLastSync(new Date());
      } catch (error) {
        setConnected(false);
        setError(String(error));
      } finally {
        syncing.current = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, connect]);
  const perform = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      if (executing.current) return;
      executing.current = true;
      setBusy(true);
      setError("");
      try {
        const result = await operation();
        try {
          await refresh();
        } catch (error) {
          setConnected(false);
          setError(
            `Command accepted. History refresh failed; do not submit it again. ${String(error)}`,
          );
        }
        return result;
      } catch (error) {
        setError(String(error));
        setInfo(
          await call<ConnectionInfo>("connection_info").catch(() => null),
        );
        return undefined;
      } finally {
        executing.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  const command = useCallback(
    (
      kind: string,
      id: string,
      revision: number,
      payload: Record<string, Json> = {},
    ) =>
      perform(async () => {
        const record = await send(kind, id, revision, payload);
        if (record.id && record.kind)
          setRecords((previous) => {
            const existing = previous.find(
              (row) => row.kind === record.kind && row.id === record.id,
            );
            if (existing && existing.revision >= record.revision)
              return previous;
            return [
              ...previous.filter(
                (row) => row.kind !== record.kind || row.id !== record.id,
              ),
              record,
            ];
          });
        return record;
      }),
    [perform],
  );
  const combinedRecords = useMemo(
    () => overlayLive(records, liveRecords),
    [records, liveRecords],
  );
  return {
    records: combinedRecords,
    streaming,
    info,
    runtime,
    models,
    connected,
    busy,
    error,
    lastSync,
    connect,
    refresh,
    perform,
    command,
    setError,
  };
}
export type Connection = ReturnType<typeof useConnection>;
