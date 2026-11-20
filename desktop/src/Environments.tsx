import { useCallback, useEffect, useRef, useState } from "react";

import { call, nativeApp, recordedPreview, type EnvironmentId } from "./api";
import { useConnection, type Connection } from "./useConnection";
import { EnvironmentContext } from "./EnvironmentContext";
import App from "./App";
import { AllChats, type ChatGroup } from "./ChatHistory";
import SettingsWorkspace from "./SettingsWorkspace";
import SharedMemory, { useSharedMemory } from "./SharedMemory";
import { AutomaticUpdatesProvider } from "./AutomaticUpdates";
import OutpostMenu from "./environment/OutpostMenu";
import { readStartupLocation, resolveStartupLocation, type WorkingLocation } from "./startup-navigation";

export interface SavedEnvironment { environmentId: string; label: string; routes: string[]; activeRoute: string }
export interface Metadata { version: 1; legacyMutationsRetired: boolean; selectedEnvironmentId: EnvironmentId; environments: Record<string, SavedEnvironment> }
export type RegistryMutation = "environment_register" | "environment_select" | "environment_rename" | "environment_remove";
export type MutateRegistry = (command: RegistryMutation, args: Record<string, unknown>) => Promise<void>;
export const ownerKey = (id: EnvironmentId) => id ?? "legacy";
const emptyRegistry: Metadata = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: null, environments: {} };

function serverName(endpoint?: string) {
  if (!endpoint) return "Server not configured";
  try { return new URL(endpoint).hostname; }
  catch { return endpoint; }
}

function Supervisor({ id, route, retired, publish }: { id: EnvironmentId; route: string; retired: boolean; publish: (id: EnvironmentId, connection: Connection) => void }) {
  const connection = useConnection(id, route, retired);
  useEffect(() => publish(id, connection), [id, connection, publish]);
  return null;
}

export default function Environments() {
  const [registry, setRegistry] = useState<Metadata | null>(null), [error, setError] = useState("");
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [startup] = useState(readStartupLocation);
  const workingLocation = useRef<WorkingLocation>(startup);
  const rememberLocation = useCallback((location: WorkingLocation) => { workingLocation.current = location; }, []);
  const [history, setHistory] = useState(startup.page === "history");
  const [draftOwner, setDraftOwner] = useState<EnvironmentId>();
  const selecting = useRef(false);
  const [knownOwners, setKnownOwners] = useState<Record<string, SavedEnvironment>>({});
  const [archiveSelection, setArchiveSelection] = useState<string | null>(null);
  useEffect(() => {
    if (registry) setKnownOwners(previous => ({ ...previous, ...registry.environments }));
  }, [registry]);
  const [navigation, setNavigation] = useState(0);
  // Metadata has no revision field. Serialize its IPC calls so late replies cannot
  // overwrite a newer selection/registration. This queue never contains provider requests.
  const registryQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = registryQueue.current.then(operation);
    registryQueue.current = result.catch(() => {});
    return result;
  }, []);
  const mutate = useCallback<MutateRegistry>((command, args) => enqueue(async () => {
    setRegistry(await call<Metadata>(command, args));
  }), [enqueue]);
  const refresh = useCallback(async () => {
    if (!nativeApp() || recordedPreview()) { setRegistry(emptyRegistry); return; }
    try {
      await enqueue(async () => {
        const value = await call<{ registry: Metadata }>("environment_list");
        setRegistry(value.registry); setError("");
      });
    } catch (error) { setError(String(error)); }
  }, [enqueue]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!nativeApp() || recordedPreview()) return;
    const wake = () => { void call<void>("connections_wake").catch(() => {}); };
    window.addEventListener("online", wake);
    return () => window.removeEventListener("online", wake);
  }, []);
  const refreshingRoutes = useRef(false);
  useEffect(() => {
    const changed = Object.entries(connections).some(([id, connection]) => connection.info?.lifecycle && registry?.environments[id] && registry.environments[id].activeRoute !== connection.info.endpoint);
    if (!changed || refreshingRoutes.current) return;
    refreshingRoutes.current = true;
    void refresh().finally(() => { refreshingRoutes.current = false; });
  }, [connections, registry, refresh]);
  const publish = useCallback((id: EnvironmentId, connection: Connection) => {
    setConnections(previous => previous[ownerKey(id)] === connection ? previous : { ...previous, [ownerKey(id)]: connection });
  }, []);
  const select = async (id: EnvironmentId, taskId: string | null = null) => {
    if (selecting.current) return;
    selecting.current = true;
    try {
      if (id && !registry?.environments[id]) setArchiveSelection(id);
      else {
        if (nativeApp() && !recordedPreview()) {
          if (registry?.selectedEnvironmentId !== id) await mutate("environment_select", { environmentId: id });
        } else setRegistry(emptyRegistry);
        setArchiveSelection(null);
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      workingLocation.current = taskId ? { page: "task", environmentId: id, taskId } : { page: "home" };
      setNavigation(value => value + 1); setHistory(false); setError("");
    } catch (error) { setError(String(error)); }
    finally { selecting.current = false; }
  };
  const saved = registry?.environments ?? emptyRegistry.environments;
  const legacy = { environmentId: null as EnvironmentId, label: serverName(connections.legacy?.info?.endpoint), activeRoute: "" };
  const supervisors = [legacy, ...Object.values(saved)];
  const owners = supervisors.filter(owner => owner.environmentId !== null || connections.legacy?.info?.endpoint !== "");
  const removed = Object.values(knownOwners).filter(owner => !saved[owner.environmentId]);
  const groups: ChatGroup[] = [...owners, ...removed].map(owner => {
    const state = connections[ownerKey(owner.environmentId)];
    const archived = owner.environmentId !== null && !saved[owner.environmentId];
    return { id: owner.environmentId, label: owner.label, archived, connected: !archived && !!state?.connected, lastSync: state?.lastSync ?? null,
      tasks: (state?.records ?? []).filter(row => row.kind === "task").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  });
  const sharedMemory = useSharedMemory(groups, connections);
  if (!registry) return <main className="page registry-page"><h1>Saved environments</h1><p role="alert">{error || "Loading secure connection registry…"}</p><button onClick={() => void refresh()}>Retry registry</button></main>;
  const restored = navigation === 0 ? resolveStartupLocation(workingLocation.current, Object.keys(registry.environments)) : workingLocation.current;
  const startupOwner = resolveStartupLocation(navigation === 0 ? startup : { page: "home" }, Object.keys(registry.environments));
  const selected = archiveSelection ?? (startupOwner.page === "task" ? startupOwner.environmentId : registry.selectedEnvironmentId), source = connections[ownerKey(selected)];
  // Removed routes have no live supervisor. Keep their cached conversations readable,
  // but fence all commands even if the last published connection was online.
  const connection = source && archiveSelection && !registry.environments[archiveSelection] ? { ...source, connected: false, connecting: false, streaming: false, retired: true,
    connect: async () => {}, command: async () => undefined, perform: async () => undefined } : source;
  const label = groups.find(owner => owner.id === selected)?.label ?? "Unknown server";
  const draftOwners = owners.filter(owner => owner.environmentId !== null || !registry.legacyMutationsRetired);
  const target = draftOwners.find(owner => owner.environmentId === draftOwner) ??
    draftOwners.find(owner => owner.environmentId !== null) ?? draftOwners[0];
  const draftConnection = target && connections[ownerKey(target.environmentId)];
  const draftLabel = target?.label ?? "No server available";
  const openChat = (id: EnvironmentId, task: string) => { void select(id, task); };
  const historyView = <AllChats groups={groups} open={openChat} connections={connections} />;
  return <AutomaticUpdatesProvider registry={registry} connections={connections}>
    {supervisors.map(owner => <Supervisor key={ownerKey(owner.environmentId)} id={owner.environmentId} route={owner.activeRoute} retired={owner.environmentId === null && registry.legacyMutationsRetired} publish={publish} />)}
    {connection && <EnvironmentContext.Provider value={connection}>
      <App key={`${navigation}:${ownerKey(selected)}:${registry.legacyMutationsRetired}`} connection={connection} initialTask={restored.page === "task" && restored.environmentId === selected ? restored.taskId : null} onWorkingLocation={rememberLocation}
        initialPage={restored.page === "task" || restored.page === "history" ? "home" : restored.page}
        initialHash={restored.page === "task" ? undefined : restored.hash} restoringTask={navigation === 0 && restored.page === "task"}
        environmentNavigation={<><OutpostMenu
          owners={owners.map(owner => ({ environmentId: owner.environmentId, label: owner.label, connected: groups.find(group => group.id === owner.environmentId)?.connected ?? false }))}
          selectedId={selected} onSelect={id => void select(id)} />{error && <p role="alert">{error}</p>}</>}
        draftConnection={draftConnection} draftLabel={draftLabel} connections={connections} sharedMemory={<SharedMemory memory={sharedMemory} />}
        newTaskNavigation={<OutpostMenu
          owners={draftOwners.map(owner => ({ environmentId: owner.environmentId, label: owner.label, connected: groups.find(group => group.id === owner.environmentId)?.connected ?? false }))}
          selectedId={target?.environmentId ?? null}
          onSelect={id => setDraftOwner(id)} disabled={!draftConnection} />}
        renderSettings={appearance => <SettingsWorkspace registry={registry} connections={connections} groups={groups} appearance={appearance} mutate={mutate} refresh={refresh} openChat={openChat} />}
        groups={groups} openChat={openChat} showHistory={() => { window.history.replaceState(null, "", window.location.pathname + window.location.search); setHistory(true); }}
        history={history ? historyView : null} dismissHistory={() => setHistory(false)} ownerLabel={label} />
    </EnvironmentContext.Provider>}
  </AutomaticUpdatesProvider>;
}
