import type { EnvironmentId } from "./api";
import { readStartupPage } from "./appearance";

export type WorkingPage = "home" | "outputs" | "automations" | "memory" | "machines" | "connection" | "history";
export type WorkingLocation = { page: WorkingPage; hash?: string } | { page: "task"; environmentId: EnvironmentId; taskId: string };
const storageKey = "outpost.last-location.v1";
const pages: WorkingPage[] = ["home", "outputs", "automations", "memory", "machines", "connection", "history"];
const settingsHash = /^#settings(?:\/(?:appearance|servers(?:\/[a-zA-Z0-9_-]+(?:\/(?:general|setup|models|runtime|devices|recovery))?)?))?$/;

export function readStartupLocation(): WorkingLocation {
  // Explicit settings links take precedence over a saved launch preference.
  if (window.location.hash || readStartupPage() !== "last") return { page: "home" };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!value || typeof value !== "object") return { page: "home" };
    if (value.page === "task" && (value.environmentId === null || typeof value.environmentId === "string" && value.environmentId.length > 0) &&
      typeof value.taskId === "string" && value.taskId.length > 0 && value.taskId.length <= 512) {
      return { page: "task", environmentId: value.environmentId, taskId: value.taskId };
    }
    if (value.page === "decisions") return { page: "history" };
    if (pages.includes(value.page)) {
      if (value.page === "connection" || value.page === "machines") {
        if (typeof value.hash !== "string" || !(value.hash === "#machines" || settingsHash.test(value.hash))) return { page: "home" };
        return { page: value.page, hash: value.hash };
      }
      return { page: value.page };
    }
  } catch { /* An unavailable or malformed local preference must not block startup. */ }
  return { page: "home" };
}

export function resolveStartupLocation(location: WorkingLocation, environmentIds: string[]): WorkingLocation {
  if (location.page === "task" && location.environmentId !== null && !environmentIds.includes(location.environmentId)) return { page: "home" };
  if (location.page !== "task" && location.hash?.startsWith("#settings/servers/")) {
    const owner = location.hash.split("/")[2];
    if (owner !== "legacy" && owner !== "new" && !environmentIds.includes(owner)) return { page: "home" };
  }
  return location;
}

export function rememberWorkingLocation(location: WorkingLocation) {
  try { localStorage.setItem(storageKey, JSON.stringify(location)); }
  catch { /* Navigation remains usable when local storage is blocked. */ }
}
