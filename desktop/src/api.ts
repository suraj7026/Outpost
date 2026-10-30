import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  ConnectionInfo,
  Json,
  ModelCatalogue,
  RuntimeInfo,
  ServerRecord,
  Snapshot,
} from "./types";

declare global {
  interface Window {
    __OUTPOST_RECORDED_PREVIEW__?: {
      snapshot: Snapshot;
      runtime: RuntimeInfo;
      models: ModelCatalogue;
    };
  }
}
export const recordedPreview = () => !!window.__OUTPOST_RECORDED_PREVIEW__;
export const nativeApp = () => isTauri();
export async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (isTauri()) return invoke<T>(command, args);
  const preview = window.__OUTPOST_RECORDED_PREVIEW__;
  if (preview) {
    let value: unknown;
    if (command === "connection_info")
      value = {
        endpoint: "Recorded server snapshot",
        deviceId: "",
        publicKey: "",
        pending: false,
        nativeSidebar: false,
      } satisfies ConnectionInfo;
    else if (command === "query" && args.kind === "snapshot")
      value = preview.snapshot;
    else if (command === "query" && args.kind === "runtime")
      value = preview.runtime;
    else if (command === "query" && args.kind === "models")
      value = preview.models;
    else if (command === "query" && args.kind === "events")
      value = {
        events: [],
        nextCursor: preview.snapshot.cursor,
        hasMore: false,
      };
    else
      throw new Error(
        "Read-only recorded preview. Open Outpost Desktop to execute actions.",
      );
    return value as T;
  }
  throw new Error(
    "Open the installed Outpost Desktop app to connect securely to your servers.",
  );
}
export const query = <T>(kind: string, payload: Record<string, Json> = {}) =>
  call<T>("query", { kind, payload });
export const send = (
  kind: string,
  id: string,
  revision: number,
  payload: Record<string, Json> = {},
) => call<ServerRecord>("send_command", { kind, id, revision, payload });

export async function upload(file: File, taskId: string) {
  if (file.size > 64 * 1024 * 1024)
    throw new Error("Attachments must be 64 MiB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const entry = await send("artifact.begin", taskId, 0, {
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: bytes.length,
    hash,
  });
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
    const chunk = bytes.subarray(offset, offset + 512 * 1024);
    let binary = "";
    for (let i = 0; i < chunk.length; i += 16384)
      binary += String.fromCharCode(...chunk.subarray(i, i + 16384));
    await send("artifact.chunk", entry.id, 0, { offset, base64: btoa(binary) });
  }
  await send("artifact.complete", entry.id, 0);
}
