import { useRef, useState } from "react";
import { Copy, Laptop, Pause, Play, Plus, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { nativeApp, recordedPreview } from "./api";
import { text, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";
import { Badge, Button, Dialog, Section, SettingRow } from "./Interface";
import RecoveryInvestigation from './RecoveryInvestigation';
import type { OpenChat } from './ChatHistory';

function deviceName(device: ServerRecord) {
  const name = text(device, "name");
  // Devices enrolled before the rename still carry the original default label.
  return name === "Outpost Desktop" ? "Outpost" : name;
}

export default function ConnectionAdministration({ connection, section = "devices", openChat }: { connection: Connection; section?: "devices" | "recovery"; openChat?: OpenChat }) {
  const devices = connection.records.filter(record => record.kind === "device");
  const recovery = connection.records.find(record => record.kind === "recovery" && record.id === "server");
  const self = devices.find(record => record.id === connection.info?.deviceId);
  const tasks = connection.records.filter(record => record.kind === "task");
  const queued = tasks.filter(record => text(record, "state") === "queued");
  const trusted = devices.filter(record => record.data.revoked === false).length;
  const revoked = devices.filter(record => record.data.revoked === true).length;
  const readOnly = recordedPreview() || !nativeApp();
  const [submitting, setSubmitting] = useState(false);
  const busy = connection.busy || submitting;
  const disabled = connection.retired || !!connection.info?.pendingError || readOnly || !connection.connected || busy ||
    !!connection.info?.pending || self?.data.revoked !== false;
  const [adding, setAdding] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = devices.find(device => device.id === detailsId);
  const [revoking, setRevoking] = useState<ServerRecord | null>(null);
  const [revokeApproved, setRevokeApproved] = useState(false);
  const [resuming, setResuming] = useState<ServerRecord | null>(null);
  const [resumeApproved, setResumeApproved] = useState(false);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [verified, setVerified] = useState(false);
  const [notice, setNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false), [refreshing, setRefreshing] = useState(false), [refreshResult, setRefreshResult] = useState('');
  const [investigating, setInvestigating] = useState(false);
  const investigate = () => { setReviewOpen(false); setInvestigating(true); };
  const reading = useRef(false);
  const acknowledgement = useRef<HTMLInputElement>(null);
  const serverPath = `#settings/servers/${connection.environmentId ?? 'legacy'}`;
  const revokeChanged = !!revoking && devices.find(device => device.id === revoking.id)?.revision !== revoking.revision;
  const recoveryChanged = !!resuming && (recovery?.revision !== resuming.revision || recovery?.data.dispatchEnabled !== false);
  const held = recovery?.data.dispatchEnabled === false;
  const enabled = recovery?.data.dispatchEnabled === true;
  const authorityNotice = recordedPreview() ? "Read-only recorded preview. Administration is disabled." :
    !nativeApp() ? "Open Outpost to administer this server." :
    connection.retired ? "Legacy mutations are retired. Select the verified installation to make changes." :
    self?.data.revoked === true ? "This device is revoked. Use another trusted device to manage the server." :
    connection.info?.pendingError ? "Recovery storage requires attention. Mutations are blocked; recovery files are retained." :
    !connection.connected ? "Offline. Showing last received records, not current authority." :
    self?.data.revoked !== false ? "This device’s authority has not been confirmed." :
    connection.info?.pending ? "Resolve the unknown pending command before making changes." : "";

  async function mutate(kind: "device.revoke" | "recovery.resume", record: ServerRecord) {
    if (disabled) return;
    if (kind === "device.revoke" && (!revokeApproved || revokeChanged || record.data.revoked !== false)) return;
    if (kind === "recovery.resume" && (!resumeApproved || recoveryChanged || acknowledgedRevision !== record.revision || !held)) return;
    setSubmitting(true); setNotice("");
    try {
      const result = await connection.command(kind, record.id, record.revision,
        kind === "recovery.resume" ? { acknowledged: true } : {});
      setRevoking(null); setResuming(null); setAcknowledgedRevision(null);
      if (!result) {
        setNotice("Not confirmed. Review the error and refreshed state before confirming again. Unknown commands must use Retry same command.");
        // Never resubmit on a stale revision; fetch current authority for a new review.
        await connection.refresh().catch(() => undefined);
      }
    } finally { setSubmitting(false); }
  }

  async function enroll() {
    if (disabled || !verified || !name.trim() || !deviceId.trim() || !publicKey.trim()) return;
    setSubmitting(true); setNotice("");
    try {
      const result = await connection.perform(() => connection.api.call<ServerRecord>("enroll_device", { deviceId: deviceId.trim(), name: name.trim(), publicKey: publicKey.trim() }));
      setVerified(false);
      if (result) { setName(""); setDeviceId(""); setPublicKey(""); setAdding(false); }
      else setNotice("Enrollment not confirmed. Refresh devices and verify the same ID and public key before trying again. Enrollment is never automatically retried.");
    } finally { setSubmitting(false); }
  }

  async function refreshRecovery() {
    if (readOnly || busy || reading.current || !connection.connected) return;
    reading.current = true; setRefreshing(true); setRefreshResult('');
    try { await connection.refresh(); setRefreshResult('Status refreshed. The latest reported state is shown below.'); }
    catch { setRefreshResult('Couldn’t refresh recovery status. Check this server’s connection, then try again. No commands were retried.'); }
    finally { reading.current = false; setRefreshing(false); }
  }

  async function copy(device: ServerRecord) {
    try { await navigator.clipboard.writeText(`${device.id}\n${text(device, "publicKey")}`); setCopyNotice("Public identity copied. No private key is included."); }
    catch { setCopyNotice("Clipboard unavailable. Select the public identity text to copy it."); }
  }

  return <>
    {section === "devices" && <Section title="Trusted devices" description="Devices allowed to send signed requests to this server." action={<Button variant="primary" disabled={disabled} onClick={() => { setAdding(true); setVerified(false); setNotice(""); }}><Plus size={16} />Add device</Button>}>
      {authorityNotice && <p className="settings-safety-note" role="status">{authorityNotice}</p>}
      {!devices.length && <p className="settings-safety-note">No device records received.</p>}
      {devices.map(device => <article className="settings-device-row" key={device.id} aria-label={deviceName(device) || device.id}>
        <SettingRow title={`${deviceName(device) || "Unnamed device"}${device.id === connection.info?.deviceId ? " (this device)" : ""}`} description={device.id === connection.info?.deviceId ? "Signing key stays in macOS Keychain" : "Paired device"} icon={<Laptop size={18} />}>
          <Badge tone={device.data.revoked === false ? "success" : device.data.revoked === true ? "neutral" : "warning"}>{device.data.revoked === false ? "Trusted" : device.data.revoked === true ? "Revoked" : "Authority unknown"}</Badge>
          <Button onClick={() => { setDetailsId(device.id); setCopyNotice(""); }}>Details</Button>
        </SettingRow>
      </article>)}
      <div className="settings-section-action"><Button variant="ghost" disabled={busy || readOnly || connection.connecting} onClick={() => void connection.connect()}><RefreshCw size={16} />Refresh devices</Button></div>
    </Section>}
    {adding && <Dialog title="Add a trusted device" busy={busy} onClose={() => setAdding(false)}>
      <form className="ui-form" onSubmit={event => { event.preventDefault(); void enroll(); }}>
        <p>Copy the device ID and public pairing key from the other device. Verify them with its owner before granting server access. Never enter a private key.</p>
        <label>Device name<input id="enroll-name" required maxLength={80} disabled={disabled} value={name} onChange={event => { setName(event.target.value); setVerified(false); }} /></label>
        <label>Other device ID<input id="enroll-id" required disabled={disabled} autoComplete="off" spellCheck={false} value={deviceId} onChange={event => { setDeviceId(event.target.value); setVerified(false); }} /></label>
        <label>Other device public pairing key<input id="enroll-key" required disabled={disabled} autoComplete="off" spellCheck={false} value={publicKey} onChange={event => { setPublicKey(event.target.value); setVerified(false); }} /></label>
        <label className="settings-page-check"><input type="checkbox" checked={verified} disabled={disabled} onChange={event => setVerified(event.target.checked)} /><span>I verified this device’s ID and public pairing key with its owner.</span></label>
        <p>Enrollment has no automatic retry. If its outcome is unknown, refresh devices and verify the ID and key before trying again.</p>
        {authorityNotice && <p role="status">{authorityNotice}</p>}
        {connection.error && <p role="alert">{connection.error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="ui-dialog-actions"><Button disabled={busy} onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={disabled || !verified || !name.trim() || !deviceId.trim() || !publicKey.trim()}>Enroll device</Button></div>
      </form>
    </Dialog>}
    {detailsId && <Dialog title="Device details" busy={busy} onClose={() => setDetailsId(null)}>
      {!details ? <p role="status">This device record is no longer available. Refresh devices before reviewing access.</p> : <>
        <SettingRow title={deviceName(details) || "Unnamed device"} description={details.id === connection.info?.deviceId ? "This Mac" : "Paired device"} />
        <dl className="ui-facts"><dt>Device ID</dt><dd><code className="identity-value">{details.id}</code></dd><dt>Public pairing key</dt><dd><code className="identity-value">{text(details, "publicKey") || "Unavailable"}</code></dd><dt>Authority</dt><dd>{details.data.revoked === false ? "Trusted" : details.data.revoked === true ? "Revoked" : "Authority unknown"} · Revision {details.revision}</dd></dl>
        {authorityNotice && <p role="status">{authorityNotice}</p>}
        {copyNotice && <p role="status">{copyNotice}</p>}
        <div className="ui-dialog-actions"><Button variant="ghost" aria-label="Copy device identity" title="Copy device identity" disabled={!text(details, "publicKey")} onClick={() => void copy(details)}><Copy size={18} /></Button><Button variant="danger" disabled={disabled || details.data.revoked !== false} onClick={() => { setRevoking(details); setRevokeApproved(false); setDetailsId(null); }}>Revoke access…</Button><Button disabled={busy} onClick={() => setDetailsId(null)}>Done</Button></div>
      </>}
    </Dialog>}
    {revoking && <Dialog title="Revoke device access?" busy={busy} onClose={() => setRevoking(null)}>
      <p>Revoke {deviceName(revoking) || revoking.id} at revision {revoking.revision}? This device will lose server access. Revocation prevents future signed requests; it does not undo external effects.</p>
      {revoking.id === connection.info?.deviceId && <p className="settings-safety-note">This Mac will lose access. Another trusted device will be needed to administer the server.</p>}
      {revokeChanged && <p role="alert">Device changed. Cancel and review its current revision.</p>}
      {authorityNotice && <p role="status">{authorityNotice}</p>}
      <label className="settings-page-check"><input type="checkbox" disabled={disabled || revokeChanged} checked={revokeApproved} onChange={event => setRevokeApproved(event.target.checked)} /><span>I understand. Revoke this device’s access.</span></label>
      <div className="ui-dialog-actions"><Button disabled={busy} onClick={() => setRevoking(null)}>Cancel</Button><Button variant="danger" disabled={disabled || revokeChanged || !revokeApproved} onClick={() => void mutate("device.revoke", revoking)}>Confirm revocation</Button></div>
    </Dialog>}
    {section === "recovery" && <Section title="Recovery status" description="Check what happened before allowing queued work to run." action={<Button onClick={investigate}>Investigate with Outpost</Button>}>
      <div className={`settings-recovery-state${!enabled || connection.info?.pending || connection.info?.pendingError || !connection.connected ? " settings-recovery-held" : ""}`}>
        {!enabled || connection.info?.pending || connection.info?.pendingError || !connection.connected ? <TriangleAlert size={22} /> : <ShieldCheck size={22} />}
        <div><h3>{connection.info?.pendingError ? "Recovery storage needs attention" : connection.info?.pending ? "One command needs a confirmed outcome" : !connection.connected ? "Recovery state is not current" : held ? "Queued work is paused" : enabled ? "No recovery hold" : "Recovery state not reported"}</h3>
          <p>{connection.info?.pending ? "A command’s outcome is unknown. Do not send a new copy; retry only with its original operation key." : !recovery ? "No Recovery Hold record received. Absence alone is not proof of a fault; investigate the server’s actual dispatch state." : text(recovery, "reason") || "Review the latest recovery record before changing dispatch."}</p>
        </div>
        {enabled && connection.connected && !connection.info?.pending && !connection.info?.pendingError ? <Badge tone="success">No hold</Badge> : <Button className="recovery-review-trigger" aria-haspopup="dialog" onClick={() => { setRefreshResult(''); setReviewOpen(true); }}>Needs review</Button>}
      </div>
      {authorityNotice && <p className="settings-safety-note" role="status">{authorityNotice}</p>}
      <SettingRow title="Trusted devices" description={devices.length ? `${trusted} trusted · ${revoked} revoked · ${devices.length - trusted - revoked} authority unknown${!connection.connected ? " · cached, not current authority" : ""}` : "No device records received; authority is unknown."} icon={<ShieldCheck size={18} />} />
      <SettingRow title="Queued tasks" description={`${queued.length} queued of ${tasks.length} received task records${!connection.connected ? " · cached, not a current queue count" : held ? " · dispatch is held" : enabled ? " · dispatch is enabled" : " · dispatch state unknown"}. This is not a count of all server-side pending work.`} icon={<Pause size={18} />} />
      {queued.length > 0 && <details className="ui-details"><summary>View queued tasks</summary><ul className="settings-queued-tasks">{queued.map(task => <li key={task.id}>{text(task, "goal") || task.id}</li>)}</ul></details>}
      {held && <div className="settings-section-action">
        <label className="settings-page-check"><input ref={acknowledgement} type="checkbox" disabled={disabled} checked={acknowledgedRevision === recovery.revision} onChange={event => setAcknowledgedRevision(event.target.checked ? recovery.revision : null)} /><span>I reviewed device authority, pending work and external effects for revision {recovery.revision}. Enable dispatch.</span></label>
        <Button variant="primary" disabled={disabled || acknowledgedRevision !== recovery.revision} onClick={() => { setResuming(recovery); setResumeApproved(false); }}><Play size={16} />Resume work…</Button>
      </div>}
      <details className="ui-details"><summary>Recovery record & safety details</summary>
        {recovery && <dl className="ui-facts"><dt>Dispatch</dt><dd>{held ? "Dispatch held" : enabled ? "Dispatch enabled" : "Dispatch state unknown"} · Revision {recovery.revision}</dd>{text(recovery, "restoredAt") && <><dt>Restored</dt><dd>{text(recovery, "restoredAt")}</dd></>}{text(recovery, "resumedBy") && <><dt>Resumed by</dt><dd>{text(recovery, "resumedBy")}</dd></>}</dl>}
        <p>Resuming permits queued work to run; it does not reconcile unknown commands or external effects. Missing recovery records are not evidence of a reviewed recovery. If recovery storage cannot be read, mutations remain blocked and recovery files are retained.</p>
      </details>
    </Section>}
    {section === 'recovery' && reviewOpen && <Dialog title="Review recovery" onClose={() => setReviewOpen(false)}>
      <p>{connection.info?.pendingError ? 'Local recovery storage needs attention. Keep the recovery files intact; do not reset pairing or reinstall as a workaround.' : connection.info?.pending ? 'An earlier command has an unknown outcome. Inspect it before retrying, and use only its original operation key.' : !connection.connected ? 'Reconnect to this server before relying on its recovery status.' : !recovery ? 'This server hasn’t sent a Recovery Hold record. Some releases allow normal dispatch without one. Investigate the actual state before attempting a repair; absence alone is not proof of a fault.' : held ? 'The server is holding queued work. Review the trusted devices, pending commands and possible effects before allowing it to run.' : enabled ? 'The server reports no recovery hold. No resume action is needed.' : 'The server’s recovery record does not contain a recognized dispatch state. Refresh it; if it remains unknown, check the server release.'}</p>
      <div className="ui-dialog-actions recovery-review-actions"><Button disabled={readOnly || busy || refreshing || !connection.connected} onClick={() => void refreshRecovery()}><RefreshCw size={16} />{refreshing ? 'Refreshing…' : 'Refresh recovery status'}</Button></div>
      {refreshResult && <p role="status" className="settings-safety-note">{refreshResult}</p>}
      <SettingRow title="Reported recovery state" description={!connection.connected ? 'Offline · cached records are not current' : !recovery ? 'No Recovery Hold record received' : held ? `Work held · revision ${recovery.revision}` : enabled ? `No hold · revision ${recovery.revision}` : `Dispatch state unknown · revision ${recovery.revision}`} />
      <div className="recovery-review-links"><a href={`${serverPath}/setup`}>Open connection settings</a><a href={`${serverPath}/devices`}>Review trusted devices</a>{(!recovery || (!held && !enabled)) && <a href={`${serverPath}/runtime`}>Check Pi &amp; server release</a>}</div>
      <div className="ui-dialog-actions recovery-review-actions"><Button variant="primary" onClick={investigate}>Investigate with Outpost</Button></div>
            <p className="settings-safety-note">Outpost can collect read-only findings, help investigate through an Ask Permission task when dispatch is available, or provide manual commands. It will not fabricate a recovery record or silently enable dispatch.</p>
      {readOnly && <p className="settings-safety-note">Status refresh is unavailable in this browser preview. Use the installed app.</p>}
      <div className="ui-dialog-actions"><Button onClick={() => setReviewOpen(false)}>Done</Button>{held && <Button variant="primary" disabled={disabled} onClick={() => { setReviewOpen(false); requestAnimationFrame(() => acknowledgement.current?.focus()); }}>Review paused work</Button>}{connection.info?.pending && !connection.info.pendingError && <Button disabled={busy} onClick={() => { setReviewOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.pending-notice button')?.focus()); }}>Review pending command</Button>}</div>
    </Dialog>}
    {section === 'recovery' && investigating && <RecoveryInvestigation key={connection.environmentId ?? 'legacy'} connection={connection} onClose={() => setInvestigating(false)} openChat={openChat} />}
    {resuming && <Dialog title="Resume queued work?" busy={busy} onClose={() => setResuming(null)}>
      <p>Queued work becomes eligible to run and may cause external effects. You reviewed recovery revision {resuming.revision}. Resuming does not reconcile earlier effects or unknown commands.</p>
      {recoveryChanged && <p role="alert">Recovery changed. Cancel and review its current revision.</p>}
      {authorityNotice && <p role="status">{authorityNotice}</p>}
      <label className="settings-page-check"><input type="checkbox" disabled={disabled || recoveryChanged} checked={resumeApproved} onChange={event => setResumeApproved(event.target.checked)} /><span>I understand. Allow queued work to run.</span></label>
      <div className="ui-dialog-actions"><Button disabled={busy} onClick={() => setResuming(null)}>Cancel</Button><Button variant="primary" disabled={disabled || recoveryChanged || !resumeApproved || acknowledgedRevision !== resuming.revision} onClick={() => void mutate("recovery.resume", resuming)}>Confirm and resume dispatch</Button></div>
    </Dialog>}
    {notice && !adding && <p role="status">{notice}</p>}
  </>;
}
