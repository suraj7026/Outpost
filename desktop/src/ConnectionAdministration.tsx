import { useState } from "react";
import { call, nativeApp, recordedPreview } from "./api";
import { text, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";

export default function ConnectionAdministration({ connection }: { connection: Connection }) {
  const devices = connection.records.filter((record) => record.kind === "device");
  const recovery = connection.records.find((record) => record.kind === "recovery" && record.id === "server");
  const self = devices.find((record) => record.id === connection.info?.deviceId);
  const readOnly = recordedPreview() || !nativeApp();
  const disabled = readOnly || !connection.connected || connection.busy ||
    !!connection.info?.pending || self?.data.revoked !== false;
  const [revoking, setRevoking] = useState<ServerRecord | null>(null);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [notice, setNotice] = useState("");
  const revokeChanged = revoking && devices.find((device) => device.id === revoking.id)?.revision !== revoking.revision;

  async function mutate(kind: "device.revoke" | "recovery.resume", record: ServerRecord) {
    if (disabled) return;
    setNotice("");
    const result = await connection.command(kind, record.id, record.revision,
      kind === "recovery.resume" ? { acknowledged: true } : {});
    setRevoking(null);
    setAcknowledgedRevision(null);
    if (!result) {
      setNotice("Not confirmed. Review the error and refreshed state before confirming again. Unknown commands must use Retry same command.");
      // Never resubmit on a stale revision; fetch current authority for a new review.
      await connection.refresh().catch(() => undefined);
    }
  }

  return <>
    <section className="settings-section">
      <div>
        <h2>Trusted devices</h2>
        <p>Device authority from authenticated server snapshots. Revocation prevents future signed requests; it does not undo external effects.</p>
        <p role="status">{recordedPreview() ? "Read-only recorded preview. Administration is disabled." :
          !nativeApp() ? "Open Outpost Desktop to administer this server." :
          self?.data.revoked === true ? "This device is revoked. Use another trusted device to manage the server." :
          !connection.connected ? "Offline. Showing last received records, not current authority." :
          self?.data.revoked !== false ? "This device’s authority has not been confirmed." :
          connection.info?.pending ? "Resolve the unknown pending command before making changes." : "Connected with a trusted device."}</p>
        <button disabled={connection.busy || readOnly} onClick={() => void connection.connect()}>Refresh authority</button>
      </div>
      <div className="administration-list">
        {!devices.length && <p>No device records received.</p>}
        {devices.map((device) => <article className="administration-record" key={device.id} aria-label={text(device, "name") || device.id}>
          <h3>{text(device, "name") || "Unnamed device"}{device.id === connection.info?.deviceId ? " (this device)" : ""}</h3>
          <p>{device.data.revoked === true ? "Revoked" : device.data.revoked === false ? "Trusted" : "Authority unknown"} · Revision {device.revision}</p>
          <code className="identity-value">{device.id}</code>
          <details><summary>Public pairing key</summary><code className="identity-value">{text(device, "publicKey") || "Unavailable"}</code></details>
          <button disabled={disabled || device.data.revoked !== false} onClick={() => setRevoking(device)}>Revoke {text(device, "name") || "device"}…</button>
          {revoking?.id === device.id && <div className="administration-confirmation" role="group" aria-label="Confirm device revocation">
            <p>Revoke {text(revoking, "name") || revoking.id} at revision {revoking.revision}?{revoking.id === connection.info?.deviceId ? " This Mac will lose access. Another trusted device will be needed to administer the server." : " This device will lose server access."}</p>
            {revokeChanged && <p role="alert">Device changed. Cancel and review its current revision.</p>}
            <button onClick={() => setRevoking(null)}>Cancel</button>{" "}
            <button disabled={disabled || !!revokeChanged} onClick={() => void mutate("device.revoke", revoking)}>Confirm revocation</button>
          </div>}
        </article>)}
      </div>
    </section>
    <section className="settings-section">
      <div>
        <h2>Enroll another device</h2>
        <p>Copy the device ID and public pairing key from the other device. Verify them with its owner before granting server access. Never enter a private key.</p>
        <p>Enrollment has no automatic retry. If its outcome is unknown, refresh the device list and verify the ID and key before trying again.</p>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        setNotice("");
        void connection.perform(() => call<ServerRecord>("enroll_device", { deviceId: deviceId.trim(), name: name.trim(), publicKey: publicKey.trim() })).then((result) => {
          if (result) { setName(""); setDeviceId(""); setPublicKey(""); }
        });
      }}>
        <label htmlFor="enroll-name">Device name</label>
        <input id="enroll-name" required maxLength={80} disabled={disabled} value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="enroll-id">Other device ID</label>
        <input id="enroll-id" required disabled={disabled} autoComplete="off" spellCheck={false} value={deviceId} onChange={(event) => setDeviceId(event.target.value)} />
        <label htmlFor="enroll-key">Other device public pairing key</label>
        <input id="enroll-key" required disabled={disabled} autoComplete="off" spellCheck={false} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} />
        <button disabled={disabled || !name.trim() || !deviceId.trim() || !publicKey.trim()}>Enroll device</button>
      </form>
    </section>
    <section className="settings-section">
      <div>
        <h2>Recovery Hold</h2>
        <p>Before enabling dispatch, review device authority, pending work and unknown external effects. Resuming permits queued work to run; it does not reconcile those effects.</p>
      </div>
      <div>
        {!recovery ? <p>No Recovery Hold record received. This is not evidence that recovery has been reviewed.</p> : <>
          <p>{recovery.data.dispatchEnabled === false ? "Dispatch held" : recovery.data.dispatchEnabled === true ? "Dispatch enabled" : "Dispatch state unknown"} · Revision {recovery.revision}</p>
          <p>{text(recovery, "reason")}</p>
          {text(recovery, "restoredAt") && <p>Restored: {text(recovery, "restoredAt")}</p>}
          {text(recovery, "resumedBy") && <p>Resumed by: {text(recovery, "resumedBy")}</p>}
          {recovery.data.dispatchEnabled === false && <>
            <label className="administration-check">
              <input type="checkbox" disabled={disabled} checked={acknowledgedRevision === recovery.revision} onChange={(event) => setAcknowledgedRevision(event.target.checked ? recovery.revision : null)} />
              I reviewed device authority, pending work and external effects for revision {recovery.revision}. Enable dispatch.
            </label>
            <button disabled={disabled || acknowledgedRevision !== recovery.revision} onClick={() => void mutate("recovery.resume", recovery)}>Confirm and resume dispatch</button>
          </>}
        </>}
      </div>
    </section>
    {notice && <p role="status">{notice}</p>}
  </>;
}
