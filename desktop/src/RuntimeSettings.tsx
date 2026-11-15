import { useEffect, useRef, useState } from 'react';
import { call, nativeApp, recordedPreview } from './api';
import type { Connection } from './useConnection';

type Manifest = { id: string; piVersion: string; sequence: number; extensions: { name: string; version: string }[] };
type Inventory = { piVersion: string; releaseId: string; extensions: Manifest['extensions']; manifest: Manifest | null };
type Review = { reviewId: string; operationId: string; state: string; message: string; available: boolean; installed: Inventory; artifact: { manifest: Manifest }; progress?: { stage: string } };
const terminal = ['review', 'complete', 'rolled_back', 'failed', 'cancelled'];

export default function RuntimeSettings({ connection }: { connection: Connection }) {
  const [review, setReview] = useState<Review | null>(null), [inventory, setInventory] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [approved, setApproved] = useState(false), [password, setPassword] = useState(true);
  const working = useRef(false);
  const blocked = !nativeApp() || recordedPreview() || connection.retired || !!connection.info?.pendingError || !!connection.info?.pending;
  const environmentId = connection.environmentId;
  const operate = async (action: () => Promise<void>) => {
    if (blocked || working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch { setError('The operation could not be confirmed. Check update status before doing anything else. No update is automatically repeated.'); }
    finally { working.current = false; setBusy(false); }
  };
  useEffect(() => {
    let stopped = false;
    if (!blocked && connection.connected) void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped) setInventory(value); }).catch(() => { if (!stopped) setError('Runtime inventory unavailable. This server may need a compatible maintenance release.'); });
    if (environmentId && !blocked) void call<Review>('environment_update_status', { environmentId }).then(value => { if (!stopped) setReview(value); }).catch(() => {});
    return () => { stopped = true; };
  }, [environmentId, blocked, connection.connected]);
  useEffect(() => {
    if (!review || !['complete', 'rolled_back'].includes(review.state) || blocked) return;
    let stopped = false;
    void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped) setInventory(value); }).catch(() => { if (!stopped) setInventory(null); });
    return () => { stopped = true; };
  }, [review?.state, blocked]);
  useEffect(() => {
    if (!review || terminal.includes(review.state) || blocked) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await call<Review>('environment_update_status', { environmentId }); if (!stopped) { setReview(value); setError(''); } }
      catch { if (!stopped) setError('Progress unavailable. The server may still be updating; no launch will be repeated.'); }
      if (!stopped) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [review?.operationId, review?.state, blocked, environmentId]);
  const current = inventory ?? review?.installed;
  const start = () => void operate(async () => {
    if (!review) return;
    const reviewId = review.reviewId; setReview({ ...review, state: 'unknown' });
    setReview(await call<Review>('environment_update_start', { environmentId, reviewId, approved, password }));
  });
  return <section className="settings-section runtime-settings" aria-label="Pi and extensions">
    <div><h2>Pi & extensions</h2><p>Pi and extensions update together as a qualified Outpost server release. This does not update Pi on your Mac or install arbitrary extension packages.</p><p>Credentials, sessions and task history stay on this server. Its previous compatible release is retained for verified recovery.</p></div>
    <div className="maintenance-body">
      <dl className="runtime-inventory"><dt>Installed Pi</dt><dd>{current?.piVersion ?? connection.agentCatalogue?.piVersion ?? 'Not available'}</dd><dt>Server release</dt><dd><code>{current?.releaseId ?? connection.agentCatalogue?.releaseId ?? 'Not available'}</code></dd>{current?.extensions.map(extension => <div key={extension.name}><dt>{extension.name}</dt><dd>{extension.version}</dd></div>)}</dl>
      {!environmentId ? <p>This legacy connection cannot use native maintenance. Save and qualify the installation first; Outpost will not reinstall it automatically.</p> : <>
        <button disabled={blocked || busy || !connection.connected || !!review && !terminal.includes(review.state)} onClick={() => void operate(async () => { setApproved(false); setReview(await call<Review>('environment_update_check', { environmentId })); })}>Check for compatible update</button>
        {review && <div className="update-review" role="region" aria-label="Server update review">
          {review.state === 'review' ? <>
            <p>{review.message}</p>
            {review.available && <><h3>Review bundled release</h3><dl className="runtime-inventory"><dt>Pi</dt><dd>{review.installed.piVersion} → {review.artifact.manifest.piVersion}</dd><dt>Target release</dt><dd><code>{review.artifact.manifest.id}</code></dd>{review.artifact.manifest.extensions.map(extension => <div key={extension.name}><dt>{extension.name}</dt><dd>{review.installed.extensions.find(e => e.name === extension.name)?.version ?? 'Not installed'} → {extension.version}</dd></div>)}</dl>
              <p>Dependencies stage while the server keeps working. Once staging passes, new work pauses while existing tasks, sign-ins and imports drain. Activation restarts this server. If health checks fail, Outpost attempts a verified rollback; uncertain recovery keeps dispatch paused.</p>
              <label className="administration-check"><input type="checkbox" checked={password} disabled={busy} onChange={e => setPassword(e.target.checked)} />Ask for the remote sudo password in a protected native dialog</label><p>Uncheck only for root or an account with appropriate passwordless sudo. No password enters this page or is saved.</p>
              <label className="administration-check"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)} />I approve this release update and a temporary interruption on this server.</label>
              <button className="primary" disabled={blocked || busy || !approved} onClick={start}>Authorize server update</button></>}
          </> : <><h3>Update {review.state.replaceAll('_', ' ')}</h3><p role="status">{review.progress?.stage ?? (review.state === 'waiting_for_idle' ? 'Waiting for existing work and provider sign-ins to finish. New tasks are blocked.' : 'Check the server receipt to confirm the outcome. Do not repeat an unknown launch.')}</p><p>Operation <code>{review.operationId}</code></p>
            {['authorizing', 'queued', 'staging', 'waiting_for_idle'].includes(review.state) && <div className="button-row"><button disabled={blocked || busy} onClick={() => void operate(async () => { setReview(await call<Review>('environment_update_cancel', { environmentId })); setApproved(false); })}>{review.state === 'waiting_for_idle' ? 'Cancel waiting update' : 'Cancel before activation'}</button></div>}
            {['unknown', 'needs_attention'].includes(review.state) && <p>Do not reinstall or remove retained releases. If status cannot be reconciled, ask the server administrator to inspect <code>/var/lib/outpost-setup/operations/{review.operationId}</code>. Maintenance may remain held.</p>}
          </>}
          <button disabled={blocked || busy} onClick={() => void operate(async () => { setReview(await call<Review>('environment_update_status', { environmentId })); })}>Check update status</button>
        </div>}
      </>}
      {busy && <p role="status">Checking the reviewed server operation…</p>}{error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
