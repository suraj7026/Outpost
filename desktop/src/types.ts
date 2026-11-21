export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ServerRecord {
  id: string;
  kind: string;
  revision: number;
  updatedAt: string;
  data: Record<string, Json>;
  deleted?: boolean;
}
export interface Snapshot {
  protocolVersion: number;
  cursor: number;
  records: ServerRecord[];
}
export interface EventPage {
  nextCursor: number;
  hasMore: boolean;
  events: { feedCursor: number; payload: ServerRecord }[];
}
export interface ConnectionInfo {
  endpoint: string;
  deviceId: string;
  publicKey: string;
  pending: boolean;
  pendingError?: string | null;
  nativeSidebar: boolean;
  lifecycle?: { state: "connecting" | "connected" | "retrying" | "paused" | "needs_attention"; error: string | null } | null;
}
export interface RuntimeInfo {
  controlModes?: string[];
  autoPolicyVersion?: number;
  sharedMemory?: boolean;
  piManagement?: boolean;
  defaultTaskMode?: 'auto' | 'full_control';
  configured: boolean;
  model: string | null;
  hostAdministration: boolean;
  browserEngine?: 'camoufox' | null;
  browserDirect?: boolean;
  browserTakeover?: boolean;
  unrestrictedCommands: boolean;
}
export interface ModelCatalogue {
  models: string[];
  defaultModel: string;
}
export const text = (record: ServerRecord, key: string) =>
  typeof record.data[key] === "string" ? (record.data[key] as string) : "";
export const title = (record: ServerRecord) => {
  const line =
    text(record, "goal").split("\n")[0] ||
    text(record, "title") ||
    text(record, "name") ||
    record.kind;
  const firstSentence = line.split(/\.\s+/)[0];
  return (firstSentence.length >= 12 ? firstSentence : line).slice(0, 110);
};
export const object = (value: Json | undefined): Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
export const actionNeedsReview = (record: ServerRecord) => {
  const state = text(record, "state");
  const result = object(record.data.result);
  return state === "unknown" || state === "failed" ||
    (typeof result.exitCode === "number" && result.exitCode !== 0) ||
    result.agent_reported_success === false;
};
export const labelState = (value: string) =>
  value === "verifying" ? "Ready for your review" : value.replaceAll("_", " ");
