import { useEffect, useRef, useState } from "react";
import { ChevronRight, Monitor, Plus, Server } from "lucide-react";
import type { Connection } from "./useConnection";
import { EnvironmentContext } from "./EnvironmentContext";
import { ownerKey, type Metadata, type MutateRegistry } from "./Environments";
import { AppearanceSettings, type Appearance } from "./appearance";
import EnvironmentSettings from "./EnvironmentSettings";
import ConnectionSettings from "./ConnectionSettings";
import ServerSetup from "./ServerSetup";
import RuntimeSettings from "./RuntimeSettings";
import ProviderImport from "./agent/ProviderImport";
import type { ChatGroup } from "./ChatHistory";
import "./settings-workspace.css";

export const settingsLocation = () => window.location.hash.startsWith("#settings") ? window.location.hash.slice(1) : "settings";
const tabs = [{ id: "general", label: "General" }, { id: "setup", label: "Setup & connection" }, { id: "models", label: "Models & providers" }, { id: "runtime", label: "Pi & extensions" }, { id: "devices", label: "Devices & access" }, { id: "recovery", label: "Recovery" }] as const;
export type ServerSettingsTab = typeof tabs[number]["id"];

export default function SettingsWorkspace({ registry, connections, groups, appearance, mutate, refresh }: {
  registry: Metadata; connections: Record<string, Connection>; groups: ChatGroup[]; appearance: Appearance; mutate: MutateRegistry; refresh: () => Promise<void>;
}) {
  const [path, setPath] = useState(settingsLocation);
  const [providerSearch, setProviderSearch] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const update = () => setPath(settingsLocation());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest(".page")?.scrollTo(0, 0); }, [path]);
  const parts = path.split("/"), section = parts[1], id = parts[2];
  const adding = section === "servers" && id === "new";
  const owner = groups.find(group => ownerKey(group.id) === id && !group.archived);
  const connection = id ? connections[id] : undefined;
  const tab = tabs.find(tab => tab.id === parts[3])?.id ?? "general";
  const serverPath = `settings/servers/${id}`;
  const link = (to: string, label: string) => <a href={`#${to}`}>{label}</a>;
  const title = adding ? "Add server" : id ? owner?.label ?? "Server unavailable" : section === "servers" ? "Servers" : section === "appearance" ? "Appearance" : "Settings";
  return <main className="page settings-page settings-workspace">
    <nav className="settings-breadcrumb" aria-label="Settings breadcrumb">
      {path === "settings" ? <span>Preferences</span> : <>{link("settings", "Settings")}<ChevronRight size={13} />{section === "servers" && id ? <>{link("settings/servers", "Servers")}<ChevronRight size={13} /><span>{title}</span></> : <span>{title}</span>}</>}
    </nav>
    <div className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{title}</h1><p>{id && !adding ? "Configuration applies only to this server. Your other chats stay available." : adding ? "Connect an installation or inspect a host over SSH." : section === "servers" ? "Open a server to manage its connection, models and access." : section === "appearance" ? "Preferences for this Mac, independent of your servers." : "Your servers and this Mac, in one place."}</p></div>
      {section === "servers" && !id && <a className="settings-add" href="#settings/servers/new"><Plus size={16} />Add server</a>}
    </div>
    {!section && <div className="settings-link-list">
      <a href="#settings/servers"><Server size={20} /><span><strong>Servers</strong><small>Connections, setup, models and device access</small></span><ChevronRight size={16} /></a>
      <a href="#settings/appearance"><Monitor size={20} /><span><strong>Appearance</strong><small>Window and sidebar preferences for this Mac</small></span><ChevronRight size={16} /></a>
    </div>}
    {section === "appearance" && <AppearanceSettings appearance={appearance} />}
    {section === "servers" && !id && <div className="settings-link-list server-settings-list">
      {groups.filter(group => !group.archived).map(group => <a key={ownerKey(group.id)} href={`#settings/servers/${ownerKey(group.id)}`} data-server-id={ownerKey(group.id)}>
        <Server size={19} /><span><strong>{group.label}</strong><small>{connections[ownerKey(group.id)]?.info?.endpoint || "Connection not configured"}</small></span>
        <span className="server-row-status"><span className={`status-dot ${group.connected ? "online" : ""}`} />{group.connected ? "Connected" : "Offline"}</span><ChevronRight size={16} />
      </a>)}
    </div>}
    {adding && connections.legacy && <EnvironmentSettings key="new" mode="add" registry={registry} connection={connections.legacy} label="New server" mutate={mutate} refresh={refresh} />}
    {id && !adding && (!owner || !connection ? <p role="status">This saved connection is no longer available. Cached chats remain in All chats until the app closes. {link("settings/servers", "Back to servers")}</p> : <EnvironmentContext.Provider value={connection}>
      <nav className="server-settings-tabs" aria-label="Server settings">{tabs.map(item => <a key={item.id} href={`#${serverPath}/${item.id}`} aria-current={tab === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
      <div className="settings-connection-status" role="status"><span>{connection.busy ? "Sending to server…" : connection.connected ? "Server-owned history" : connection.reconnecting ? "Restoring saved SSH access automatically…" : connection.info?.lifecycle?.state === "paused" ? "Connection paused" : "Offline · cached history is read-only"}</span><button aria-label="Reconnect" onClick={() => void connection.connect()}>Refresh connection</button></div>
      <div key={`${id}:${tab}`}>
        {tab !== "general" && connection.info?.pendingError && <p role="alert">Recovery storage requires attention: {connection.info.pendingError}. Mutations are blocked; recovery files are retained.</p>}
        {connection.error && <p className="error-text" role="alert">{connection.error}</p>}
        {connection.info?.pending && <div className="inline-notice pending-notice">This server has a command with an unknown outcome. Retry uses its original operation key.
          <button disabled={connection.busy || connection.retired || !!connection.info?.pendingError} onClick={() => void connection.perform(() => connection.api.call("retry_command"), true)}>Retry same command</button>
        </div>}
        {tab === "general" && <EnvironmentSettings mode="manage" registry={registry} connection={connection} label={owner.label} mutate={mutate} refresh={refresh}
          onDeleted={() => {
            if (settingsLocation().split("/")[2] === id) window.location.hash = "settings/servers";
          }} />}
        {tab === "models" && <ProviderImport connection={connection} registry={registry} onSignIn={setProviderSearch} />}
        {tab === "runtime" && <RuntimeSettings connection={connection} />}
        <ConnectionSettings connection={connection} tab={tab} providerSearch={providerSearch} />
        {tab === "setup" && connection.environmentId && <ServerSetup environmentId={connection.environmentId} registry={registry} mutate={mutate} refresh={refresh} />}
      </div>
    </EnvironmentContext.Provider>)}
  </main>;
}
