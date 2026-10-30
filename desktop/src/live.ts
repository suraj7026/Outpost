import type { ServerRecord } from "./types";

export type LiveFrame =
  | {
      type: "snapshot";
      records: ServerRecord[];
      live: ServerRecord[];
      cursor: number;
    }
  | { type: "records"; records: ServerRecord[]; cursor: number }
  | { type: "live" | "settled"; record: ServerRecord }
  | { type: "heartbeat" };

export function mergeRecords(
  previous: ServerRecord[],
  incoming: ServerRecord[],
) {
  const rows = new Map(
    previous.map((record) => [`${record.kind}:${record.id}`, record]),
  );
  for (const record of incoming) {
    const key = `${record.kind}:${record.id}`;
    if (!rows.has(key) || rows.get(key)!.revision < record.revision)
      rows.set(key, record);
  }
  return [...rows.values()];
}

export function overlayLive(records: ServerRecord[], live: ServerRecord[]) {
  const rows = new Map(
    records.map((record) => [`${record.kind}:${record.id}`, record]),
  );
  for (const record of live) {
    const key = `${record.kind}:${record.id}`,
      saved = rows.get(key);
    // Final durable messages win even if an older live IPC frame arrives late.
    if (!saved || saved.data.streaming === true) rows.set(key, record);
  }
  return [...rows.values()];
}
