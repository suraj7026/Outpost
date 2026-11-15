import { useState } from "react";
import ServerSetup from './ServerSetup';
import { call, nativeApp, recordedPreview } from "./api";
import type { Connection } from "./useConnection";
import type { Metadata, MutateRegistry } from "./Environments";

interface Descriptor { descriptorVersion: 1; environmentId: string; label: string; protocolVersion: 2; recordProtocolVersion: 1 }
export default function EnvironmentSettings({ registry, connection, label, mutate, refresh, mode, onDeleted }: {
  registry: Metadata; connection: Connection; label: string; mutate: MutateRegistry; refresh: () => Promise<void>; mode: "add" | "manage"; onDeleted?: () => void;
}) {
  const [endpoint, setEndpoint] = useState(""), [expected, setExpected] = useState(""), [name, setName] = useState("");
  const [preview, setPreview] = useState<Descriptor | null>(null), [token, setToken] = useState("");
  const [bootstrap, setBootstrap] = useState(false), [retire, setRetire] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [rename, setRename] = useState(label), [route, setRoute] = useState("");
  const [remove, setRemove] = useState(false);
  const disabled = busy || !nativeApp() || recordedPreview();
  const saved = connection.environmentId ? registry.environments[connection.environmentId] : null;
  const operate = async (action: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const registerRoute = (endpoint: string) => operate(async () => {
    await mutate("environment_register", { environmentId: connection.environmentId, endpoint, label });
  });
  const deleteConnection = () => operate(async () => {
    if (saved) await mutate("environment_remove", { environmentId: saved.environmentId });
    else {
      await call("clear_legacy_endpoint");
      await connection.connect();
    }
    onDeleted?.();
  });
  return <div className="environment-settings">
    {mode === "manage" && <section className="settings-section"><div><h2>Connection & installation</h2><p>{label}</p><code>{connection.environmentId ?? "Unbound legacy v1 connection"}</code>
      <p>{connection.connected ? "Connected" : "Offline · cached history is stale and read-only"}. {connection.lastSync ? `Last synced ${connection.lastSync.toLocaleString()}.` : "Not yet synced."}</p>
      {connection.retired && <p>Legacy mutations are retired. Reads and history remain available. Select the verified installation to make changes.</p>}
      {connection.info?.pendingError && <p role="alert">Recovery storage requires attention: {connection.info.pendingError}. Mutations are blocked; recovery files are retained.</p>}
    </div><div className="environment-connection-controls">
      <div className="environment-connection-state">
      <button disabled={disabled} onClick={() => void operate(connection.connected || connection.connecting || connection.reconnecting ? connection.disconnect : connection.connect)}>{connection.info?.lifecycle ? connection.connected || connection.connecting || connection.reconnecting ? "Pause connection" : "Resume connection" : connection.connected || connection.connecting ? "Disconnect environment" : "Reconnect environment"}</button>
      {connection.info?.lifecycle && <p>Trusted SSH access reconnects automatically after launch or a dropped connection. Pausing stays in effect until you resume; no installation or pairing is repeated.</p>}
      </div>
      {saved && <div className="environment-connection-fields">
        <form onSubmit={event => { event.preventDefault(); void operate(async () => mutate("environment_rename", { environmentId: saved.environmentId, label: rename })); }}>
          <label htmlFor="environment-name">Environment label</label><input id="environment-name" required maxLength={80} value={rename} onChange={event => setRename(event.target.value)} /><button disabled={disabled}>Rename environment</button>
        </form>
        <div className="environment-route-settings">
        <label htmlFor="verified-route">Verified routes</label><select id="verified-route" value={saved.activeRoute} disabled={disabled} onChange={event => void registerRoute(event.target.value)}>{saved.routes.map(value => <option key={value}>{value}</option>)}</select>
        <form onSubmit={event => { event.preventDefault(); void registerRoute(route); }}><label htmlFor="new-route">Additional route URL</label><input id="new-route" required type="url" value={route} onChange={event => setRoute(event.target.value)} /><button disabled={disabled}>Verify and use route</button></form>
        <p>Every route is authenticated against this installation ID before use. Matching IDs do not replace HTTPS or SSH trust.</p>
        </div>
      </div>}
    </div></section>}
    {mode === "manage" && (saved || connection.info?.endpoint) && <section className="settings-section">
      <div><h2>Delete connection</h2><p>Remove this server from Outpost on this Mac. The server keeps running and retains its data.</p></div>
      <div>
        {remove ? <div role="group" aria-label="Confirm server deletion">
          <p>Delete the saved connection to {label}?</p>
          <div className="button-row">
            <button disabled={busy} onClick={() => setRemove(false)}>Keep connection</button>
            <button className="delete-server" disabled={disabled} onClick={() => void deleteConnection()}>Delete connection</button>
          </div>
        </div> : <button className="delete-server" disabled={disabled} onClick={() => setRemove(true)}>Delete server…</button>}
      </div>
    </section>}
    {mode === "add" && <ServerSetup registry={registry} mutate={mutate} refresh={refresh} autoOpen>
    <section className="settings-section"><div><h2>Connect an existing server</h2><p>Connect to an already installed server. This does not install or upgrade servers. Legacy deployed servers remain available in v1 mode.</p><p>Discovery is an untrusted preview. Compare the expected installation UUID through a trusted channel; saving requires authenticated confirmation.</p></div>
      <div><form onSubmit={event => { event.preventDefault(); void operate(async () => { const value = await call<Descriptor>("environment_discover", { endpoint }); setPreview(value); }); }}>
        <label htmlFor="add-url">Environment URL</label><input id="add-url" type="url" required value={endpoint} onChange={event => { setEndpoint(event.target.value); setPreview(null); }} placeholder="https://server.example" />
        <button disabled={disabled}>Discover environment</button></form>
        {preview && <p>Untrusted preview: {preview.label} · <code>{preview.environmentId}</code> · API {preview.protocolVersion}</p>}
        <form autoComplete="off" onSubmit={event => {
          event.preventDefault();
          void operate(async () => {
            if (!preview || preview.environmentId !== expected.trim()) throw new Error("Expected installation ID does not match discovery.");
            const bootstrapToken = token; setToken("");
            const args = { environmentId: expected.trim(), endpoint, label: name.trim(), ...(retire ? { retireLegacyMutations: true } : {}), ...(bootstrap ? { bootstrapToken } : {}) };
            try { await mutate("environment_register", args); setPreview(null); setExpected(""); setName(""); setRetire(false); setBootstrap(false); }
            catch (error) { throw new Error(`${String(error)}${bootstrap ? " Pairing may already have succeeded. Verify/adopt existing enrollment before any further bootstrap attempt." : ""}`); }
          });
        }}>
          <label htmlFor="expected-environment">Expected installation UUID</label><input id="expected-environment" required value={expected} onChange={event => setExpected(event.target.value)} spellCheck={false} />
          <label htmlFor="add-label">New environment label</label><input id="add-label" required maxLength={80} value={name} onChange={event => setName(event.target.value)} />
          <fieldset className="enrollment-choices"><legend>Enrollment</legend>
            <label><input type="radio" name="enrollment" value="adopt" checked={!bootstrap} disabled={disabled} onChange={() => { setBootstrap(false); setToken(""); }} /><span>I already have access<small>Verify this Mac’s existing enrollment. No pairing token needed.</small></span></label>
            <label><input type="radio" name="enrollment" value="bootstrap" checked={bootstrap} disabled={disabled} onChange={() => { setBootstrap(true); setToken(""); }} /><span>Pair a new installation<small>Enroll the first device using the new server’s bootstrap token.</small></span></label>
          </fieldset>
          {bootstrap && <><label htmlFor="environment-bootstrap">New installation bootstrap token</label><input id="environment-bootstrap" required type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></>}
        {preview && connection.info?.endpoint !== "" && !registry.legacyMutationsRetired && <><p>Resolve unbound legacy pending work using its original Retry same command control before adoption. Exact-route adoption retires legacy mutations automatically. For an ambiguous alternate route, explicit confirmation is required.</p><label className="administration-check"><input type="checkbox" disabled={disabled} checked={retire} onChange={event => setRetire(event.target.checked)} />Retire legacy mutations even if this is a different installation. The old legacy connection will become read-only: commands, pairing, enrollment, endpoint and provider changes will be disabled; reads remain available.</label></>}
          <button disabled={disabled || !preview || expected.trim() !== preview.environmentId}>{bootstrap ? "Pair and verify installation" : "Verify and adopt enrollment"}</button>
        </form>
        <button disabled={disabled} onClick={() => void operate(refresh)}>Refresh saved environments</button>
      </div>{error && <p role="alert">{error}</p>}</section></ServerSetup>}
    {mode === "manage" && error && <p role="alert">{error}</p>}
  </div>;
}
