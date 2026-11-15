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
        "Read-only recorded preview. Open Outpost to execute actions.",
      );
    return value as T;
  }
  throw new Error(
    "Open the installed Outpost app to connect securely to your servers.",
  );
}
// The immutable owner is captured before any await (including file reads/hashing).
export type EnvironmentId = string | null; // null is the explicit, unbound legacy slot.
type ServerCall = "connection_info" | "query" | "send_command" | "retry_command" |
  "agent_request" | "browser_request" | "enroll_device" | "disconnect" | "connection_policy" | "stream_events" | "artifact" | "save_artifact";
export function environmentApi(environmentId: EnvironmentId) {
  const request = <T>(command: ServerCall, args: Record<string, unknown> = {}) =>
    call<T>(environmentId === null ? command : `environment_${command}`,
      environmentId === null ? args : { ...args, environmentId });
  const send = (kind: string, id: string, revision: number, payload: Record<string, Json> = {}) =>
    request<ServerRecord>("send_command", { kind, id, revision, payload });
  return {
    environmentId,
    call: request,
    query: <T>(kind: string, payload: Record<string, Json> = {}) => request<T>("query", { kind, payload }),
    agentRequest: <T>(payload: Record<string, unknown>) => {
      if (recordedPreview() || !nativeApp()) return Promise.reject(new Error("Provider management requires the connected desktop app."));
      return request<T>("agent_request", { payload });
    },
    browserRequest: <T>(payload: Record<string, unknown>) => {
      if (recordedPreview() || !nativeApp()) return Promise.reject(new Error("Browser control requires the connected desktop app."));
      return request<T>("browser_request", { payload });
    },
    send,
    disconnect: (pause = false) => !nativeApp() || recordedPreview() ? Promise.resolve() : request<void>("disconnect", pause && environmentId !== null ? { pause: true } : {}),
    upload: (file: File, taskId: string) => upload(send, file, taskId),
  };
}
export type EnvironmentApi = ReturnType<typeof environmentApi>;

async function upload(send: EnvironmentApi["send"], file: File, taskId: string) {
  if (file.size > 64 * 1024 * 1024)
    throw new Error("Attachments must be 64 MiB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const entry = await send("artifact.begin", taskId, 0, {
    name: file.name, mime: file.type || "application/octet-stream", size: bytes.length, hash,
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
