import { useEffect, useState } from "react";
import { Copy, KeyRound, Pause, Play, Plus, RefreshCw, Server } from "lucide-react";
import { call, nativeApp, recordedPreview } from "./api";
import type { Connection } from "./useConnection";
import type { Metadata, MutateRegistry } from "./Environments";
import { Badge, Button, Dialog, Section, SettingRow } from "./Interface";
import ConnectionAdministration from "./ConnectionAdministration";
import ProviderSettings from "./agent/ProviderSettings";
import type { ServerSettingsTab } from "./SettingsWorkspace";
import type { OpenChat } from './ChatHistory';

export default function ConnectionSettings({ connection, tab, providerRequest, registry, mutate, openChat }: {
  connection: Connection; tab: ServerSettingsTab; providerRequest?: { id: string }; registry: Metadata; mutate: MutateRegistry; openChat?: OpenChat;
}) {
  const [endpoint, setEndpoint] = useState(""), [token, setToken] = useState("");
  const [addingRoute, setAddingRoute] = useState(false), [route, setRoute] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  useEffect(() => { if (connection.info) setEndpoint(connection.info.endpoint); }, [connection.info?.endpoint]);
  const readOnly = recordedPreview() || !nativeApp() || connection.retired || !!connection.info?.pendingError;
  const toggleDisabled = readOnly || connection.busy || busy;
  const disabled = toggleDisabled || !!connection.info?.pending;
  const saved = connection.environmentId ? registry.environments[connection.environmentId] : undefined;
  const active = connection.connected || connection.connecting || connection.reconnecting;
  const registerRoute = async (value: string) => {
    if (disabled || !saved || !value.trim()) return;
    setBusy(true); setError("");
    try {
      // Registration authenticates the route against the saved installation before persisting it.
      await mutate("environment_register", { environmentId: saved.environmentId, endpoint: value.trim(), label: saved.label });
      setAddingRoute(false); setRoute("");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const toggleConnection = async () => {
    if (toggleDisabled) return;
    setBusy(true); setError("");
    try { if (active) await connection.disconnect(); else await connection.connect(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const copyIdentity = async () => {
    if (!connection.info?.deviceId || !connection.info.publicKey) return;
    try { await navigator.clipboard.writeText(`${connection.info.deviceId}\n${connection.info.publicKey}`); setCopyNotice("Public pairing details copied. No private key is included."); }
    catch { setCopyNotice("Clipboard unavailable. Select the public identity text to copy it."); }
  };
  return <>
    {tab === "models" && <ProviderSettings connection={connection} requestedProvider={providerRequest} />}
    {tab === "setup" && <>
      <Section title="Connection" description="Pause access without removing this server.">
        <SettingRow title={connection.connected ? "Connected to server" : connection.info?.lifecycle?.state === "paused" ? "Connection paused" : connection.reconnecting || connection.connecting ? "Connecting to server" : "Server offline"}
          description={connection.info?.lifecycle ? "Trusted SSH access reconnects automatically. Pausing lasts until you resume." : "Connect or disconnect this saved server without removing its data."} icon={<Server size={18} />}>
          <Badge tone={connection.connected ? "success" : "warning"}>{connection.connected ? "Connected" : connection.info?.lifecycle?.state === "paused" ? "Paused" : "Offline"}</Badge>
          <Button disabled={toggleDisabled} onClick={() => void toggleConnection()}>{active ? <Pause size={16} /> : <Play size={16} />}{connection.info?.lifecycle ? active ? "Pause connection" : "Resume connection" : active ? "Disconnect environment" : "Reconnect environment"}</Button>
        </SettingRow>
        <div className="ui-form settings-route-form">
          <label>Connection route{saved ? <select id="verified-route" aria-label="Connection route" value={saved.activeRoute} disabled={disabled} onChange={event => void registerRoute(event.target.value)}>{saved.routes.map(value => <option key={value} value={value}>{value}</option>)}</select> : <input value={connection.info?.endpoint || "Not configured"} readOnly />}</label>
          <Button disabled={readOnly || busy || connection.busy || connection.connecting || connection.reconnecting || connection.info?.lifecycle?.state === "paused"} onClick={() => void connection.connect()}><RefreshCw size={16} />Check connection</Button>
        </div>
        {saved && <div className="settings-section-action"><Button variant="ghost" disabled={disabled} onClick={() => { setError(""); setAddingRoute(true); }}><Plus size={16} />Add route</Button></div>}
      </Section>
      <Section title="Trust & credentials">
        <SettingRow title="Credential storage" description="This Mac’s signing key stays in macOS Keychain. Provider credentials stay on the server." icon={<KeyRound size={18} />} />
        <details className="ui-details"><summary>How routes are verified</summary><p>Every route is authenticated against this installation ID before use. Matching IDs do not replace HTTPS certificate or SSH host-key verification. Discovery alone is not trusted enrollment.</p>{saved && <dl className="ui-facts"><dt>Saved installation</dt><dd><code>{saved.environmentId}</code></dd></dl>}</details>
      </Section>
      {addingRoute && <Dialog title="Add a route" busy={busy} onClose={() => setAddingRoute(false)}><form className="ui-form" onSubmit={event => { event.preventDefault(); void registerRoute(route); }}>
        <p>The route must authenticate as this saved installation before it is saved. Verify HTTPS certificates or SSH host keys through a trusted channel.</p>
        <label>Route URL<input id="new-route" required type="url" autoComplete="off" disabled={disabled} value={route} onChange={event => setRoute(event.target.value)} placeholder="https://server.example" /></label>
        {error && <p role="alert">{error}</p>}
        <div className="ui-dialog-actions"><Button disabled={busy} onClick={() => setAddingRoute(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={disabled || !route.trim() || saved?.routes.includes(route.trim())}>Verify and use route</Button></div>
      </form></Dialog>}
      {!addingRoute && error && <p role="alert">{error}</p>}
    </>}
    {tab === "setup" && connection.environmentId === null && <details className="ui-details settings-legacy-connection"><summary>Legacy connection & first-device pairing</summary>
      <Section title="Legacy private server" description="Localhost connects through the SSH tunnel to your cluster. Remote endpoints must use HTTPS.">
        <form className="ui-form" onSubmit={event => {
          event.preventDefault(); if (disabled) return;
          void call("set_endpoint", { endpoint }).then(() => window.location.reload()).catch(error => connection.setError(String(error)));
        }}>
          <label>Server URL<input id="server-url" required disabled={disabled} value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:4318" /></label>
          <Button type="submit" variant="primary" disabled={disabled}>Save and connect</Button>
        </form>
      </Section>
      <Section title="First-device pairing" description="Only needed for a new server. Existing paired devices reconnect without a token.">
        <form className="ui-form" onSubmit={event => {
          event.preventDefault(); if (disabled) return;
          void connection.perform(async () => { const bootstrapToken = token; setToken("");
                        try { await call("pair", { token: bootstrapToken }); }
                        catch (error) { throw new Error(`${String(error)} Pairing may already have succeeded. Verify existing enrollment before any further bootstrap attempt.`); } }, true);
        }}>
          <label>Bootstrap token<input id="pair-token" disabled={disabled} type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
          <Button type="submit" disabled={disabled || !token}>Pair device</Button>
        </form>
      </Section>
    </details>}
    {(tab === "devices" || tab === "recovery") && <ConnectionAdministration connection={connection} section={tab} openChat={openChat} />}
    {tab === "devices" && <Section title="Your device identity" description="Share only the device ID and public pairing key. Never share a private key.">
      <details className="ui-details"><summary>View this Mac’s pairing details</summary>
        <dl className="ui-facts"><dt>Device ID</dt><dd><code className="identity-value">{connection.info?.deviceId || "Waiting for Keychain access"}</code></dd><dt>Public pairing key</dt><dd><code className="identity-value">{connection.info?.publicKey || "Unavailable"}</code></dd></dl>
        <Button variant="ghost" disabled={!connection.info?.deviceId || !connection.info.publicKey} onClick={() => void copyIdentity()}><Copy size={16} />Copy pairing details</Button>
        {copyNotice && <p role="status">{copyNotice}</p>}
      </details>
    </Section>}
    {tab === "models" && connection.runtime && !connection.runtime.piManagement && <Section title="Legacy Ollama models" description="Only cloud models advertised by your connected Ollama server are listed. Local-only models are hidden. Task, tool and page context is sent to Ollama Cloud when a cloud model runs.">
      <div className="model-list">{!connection.models.length && <p className="empty-line">No cloud models available from this Ollama server.</p>}{connection.models.map(model => <div key={model}><span>{model}</span>{model === connection.runtime?.model && <Badge>Default</Badge>}</div>)}</div>
          </Section>}
        </>;
      }
