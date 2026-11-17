import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Badge, Button, Dialog, Section, SettingRow } from "./Interface";
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
  const [error, setError] = useState(""), [rename, setRename] = useState(label);
  const [remove, setRemove] = useState(false), [removalApproved, setRemovalApproved] = useState(false);
  const disabled = busy || !nativeApp() || recordedPreview();
  const saved = connection.environmentId ? registry.environments[connection.environmentId] : null;
  const operate = async (action: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const deleteConnection = () => operate(async () => {
    if (!removalApproved || connection.info?.pending || connection.info?.pendingError) return;
    if (saved) await mutate("environment_remove", { environmentId: saved.environmentId });
    else {
      await call("clear_legacy_endpoint");
      await connection.connect();
    }
    onDeleted?.();
  });
  return <div className="environment-settings">
    {mode === "manage" && <>
      <Section title="Server details" description="Name and connection details for this Mac.">
        {saved && <form className="ui-form settings-name-form" onSubmit={event => { event.preventDefault(); void operate(async () => mutate("environment_rename", { environmentId: saved.environmentId, label: rename.trim() })); }}>
          <label>Server name<input id="environment-name" required maxLength={80} disabled={disabled} value={rename} onChange={event => setRename(event.target.value)} /></label>
          <Button type="submit" disabled={disabled || !rename.trim() || rename.trim() === label}>Save name</Button>
        </form>}
        <SettingRow title="Connection" description={`${connection.info?.endpoint || "No route configured"} · ${connection.lastSync ? `Last synced ${connection.lastSync.toLocaleString()}` : "Not yet synced"}`} icon={<ShieldCheck size={18} />}>
          <Badge tone={connection.connected ? "success" : "warning"}>{connection.connected ? "Connected" : connection.info?.lifecycle?.state === "paused" ? "Paused" : "Offline"}</Badge>
        </SettingRow>
        <SettingRow title="Data stays on your server" description="Tasks, history, provider credentials and runtime configuration live on this server." />
        {!connection.connected && <p className="settings-safety-note" role="status">Offline · cached history is stale and read-only.</p>}
        <details className="ui-details"><summary>Installation details</summary><dl className="ui-facts"><dt>Installation</dt><dd><code>{connection.environmentId ?? "Unbound legacy v1 connection"}</code></dd><dt>Endpoint</dt><dd>{connection.info?.endpoint || "Not configured"}</dd></dl></details>
        {connection.retired && <p className="settings-safety-note">Legacy mutations are retired. Reads and history remain available. Select the verified installation to make changes.</p>}
      </Section>
      {(saved || connection.info?.endpoint) && <Section title="Remove connection" description="Forget this server on this Mac. This does not uninstall Outpost or delete server data.">
        <div className="settings-section-action"><Button variant="danger" disabled={disabled || !!connection.info?.pending || !!connection.info?.pendingError} onClick={() => { setRemovalApproved(false); setError(""); setRemove(true); }}>Remove connection…</Button></div>
      </Section>}
      {remove && <Dialog title="Remove this saved connection?" busy={busy} onClose={() => setRemove(false)}>
        <p>This Mac will lose its saved route to <strong>{label}</strong>. The server keeps running, and its tasks, credentials and history remain on the server. Other devices are unaffected.</p>
        {(connection.info?.pending || connection.info?.pendingError) && <p role="alert">Resolve pending recovery before removing this connection.</p>}
        {error && <p role="alert">{error}</p>}
        <label className="settings-page-check"><input type="checkbox" disabled={busy} checked={removalApproved} onChange={event => setRemovalApproved(event.target.checked)} /><span>I understand. Remove only this Mac’s saved connection.</span></label>
        <div className="ui-dialog-actions"><Button disabled={busy} onClick={() => setRemove(false)}>Keep connection</Button><Button variant="danger" disabled={disabled || !removalApproved || !!connection.info?.pending || !!connection.info?.pendingError} onClick={() => void deleteConnection()}>Remove connection</Button></div>
      </Dialog>}
    </>}
    {mode === "add" && <ServerSetup registry={registry} mutate={mutate} refresh={refresh} autoOpen>
    <section className="settings-section"><div><h2>Connect an existing server</h2><p>Connect to an already installed server. This does not install or upgrade servers. Legacy deployed servers remain available in v1 mode.</p><p>Discovery is an untrusted preview. Compare the expected installation UUID through a trusted channel; saving requires authenticated confirmation.</p></div>
      <div><form className="ui-form" onSubmit={event => { event.preventDefault(); void operate(async () => { const value = await call<Descriptor>("environment_discover", { endpoint }); setPreview(value); }); }}>
        <label>Environment URL<input id="add-url" type="url" required disabled={disabled} value={endpoint} onChange={event => { setEndpoint(event.target.value); setPreview(null); }} placeholder="https://server.example" /></label>
        <Button type="submit" disabled={disabled}>Discover environment</Button></form>
        {preview && <p>Untrusted preview: {preview.label} · <code>{preview.environmentId}</code> · API {preview.protocolVersion}</p>}
        <form className="ui-form" autoComplete="off" onSubmit={event => {
          event.preventDefault();
          void operate(async () => {
            if (!preview || preview.environmentId !== expected.trim()) throw new Error("Expected installation ID does not match discovery.");
            const bootstrapToken = token; setToken("");
            const args = { environmentId: expected.trim(), endpoint, label: name.trim(), ...(retire ? { retireLegacyMutations: true } : {}), ...(bootstrap ? { bootstrapToken } : {}) };
            try { await mutate("environment_register", args); setPreview(null); setExpected(""); setName(""); setRetire(false); setBootstrap(false); }
            catch (error) { throw new Error(`${String(error)}${bootstrap ? " Pairing may already have succeeded. Verify/adopt existing enrollment before any further bootstrap attempt." : ""}`); }
          });
        }}>
          <label>Expected installation UUID<input id="expected-environment" required disabled={disabled} value={expected} onChange={event => setExpected(event.target.value)} spellCheck={false} /></label>
          <label>New environment label<input id="add-label" required disabled={disabled} maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
          <fieldset className="enrollment-choices"><legend>Enrollment</legend>
            <label><input type="radio" name="enrollment" value="adopt" checked={!bootstrap} disabled={disabled} onChange={() => { setBootstrap(false); setToken(""); }} /><span>I already have access<small>Verify this Mac’s existing enrollment. No pairing token needed.</small></span></label>
            <label><input type="radio" name="enrollment" value="bootstrap" checked={bootstrap} disabled={disabled} onChange={() => { setBootstrap(true); setToken(""); }} /><span>Pair a new installation<small>Enroll the first device using the new server’s bootstrap token.</small></span></label>
          </fieldset>
          {bootstrap && <label>New installation bootstrap token<input id="environment-bootstrap" required disabled={disabled} type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>}
        {preview && connection.info?.endpoint !== "" && !registry.legacyMutationsRetired && <><p>Resolve unbound legacy pending work using its original Retry same command control before adoption. Exact-route adoption retires legacy mutations automatically. For an ambiguous alternate route, explicit confirmation is required.</p><label className="administration-check"><input type="checkbox" disabled={disabled} checked={retire} onChange={event => setRetire(event.target.checked)} />Retire legacy mutations even if this is a different installation. The old legacy connection will become read-only: commands, pairing, enrollment, endpoint and provider changes will be disabled; reads remain available.</label></>}
          <Button type="submit" disabled={disabled || !preview || expected.trim() !== preview.environmentId}>{bootstrap ? "Pair and verify installation" : "Verify and adopt enrollment"}</Button>
        </form>
        <Button disabled={disabled} onClick={() => void operate(refresh)}>Refresh saved environments</Button>
      </div>{error && <p role="alert">{error}</p>}</section></ServerSetup>}
    {mode === "manage" && !remove && error && <p role="alert">{error}</p>}
  </div>;
}
