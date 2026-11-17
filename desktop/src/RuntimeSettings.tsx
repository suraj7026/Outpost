import { useEffect, useRef, useState } from 'react';
import { Cpu, Puzzle, RefreshCw } from 'lucide-react';
import { call, nativeApp, recordedPreview } from './api';
import { Badge, Button, Dialog, Section, SettingRow } from './Interface';
import type { Connection } from './useConnection';
import { AutomaticUpdatesSection } from './AutomaticUpdates';
import './provider-runtime-parity.css';

type Manifest = { id: string; piVersion: string; sequence: number; extensions: { name: string; version: string }[] };
type Inventory = { piVersion: string; releaseId: string; extensions: Manifest['extensions']; extensionStates?: Record<string, string>; manifest: Manifest | null };
type Review = { reviewId: string; operationId: string; state: string; message: string; available: boolean; installed: Inventory; artifact: { manifest: Manifest; extensionPolicy?: string }; progress?: { stage: string } };
const terminal = ['review', 'complete', 'rolled_back', 'failed', 'cancelled'];
const legacySubagentsNotice = 'Bundled pi-subagents is inactive and is not enabled for managed tasks until approval-aware integration is available. Authorizing this release does not enable it.';
const nativeExtensionsNotice = 'Installed extensions are available to Pi automatically. They and their subagents run with the server worker’s permissions, outside Outpost’s per-action approvals.';
const nativeReleaseNotice = 'Installing this release enables native extensions automatically.';

export default function RuntimeSettings({ connection }: { connection: Connection }) {
  const [review, setReview] = useState<Review | null>(null), [inventory, setInventory] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [approved, setApproved] = useState(false), [password, setPassword] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false), [checking, setChecking] = useState(false);
  const working = useRef(false);
  const reviewVersion = useRef(0), inventoryVersion = useRef(0);
  const blocked = !nativeApp() || recordedPreview() || connection.retired || !!connection.info?.pendingError || !!connection.info?.pending;
  const environmentId = connection.environmentId;
  const operate = async (action: () => Promise<void>, kind: 'check' | 'operation' = 'operation') => {
    if (blocked || working.current) return;
    // Older passive status reads must not overwrite this explicit operation.
    reviewVersion.current += 1;
    working.current = true; setBusy(true); setChecking(kind === 'check'); setError('');
    try { await action(); } catch { setError(kind === 'check' ? 'Couldn’t check the bundled release. No update was started. Check your connection and try again.' : 'The operation could not be confirmed. Check update status before doing anything else. No update is automatically repeated.'); }
    finally { working.current = false; setBusy(false); setChecking(false); }
  };
  useEffect(() => {
    let stopped = false;
    const version = reviewVersion.current;
    const inventoryRequest = ++inventoryVersion.current;
    if (!blocked && connection.connected) void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped && inventoryRequest === inventoryVersion.current) setInventory(value); }).catch(() => { if (!stopped && inventoryRequest === inventoryVersion.current) setError('Runtime inventory unavailable. This server may need a compatible maintenance release.'); });
    if (environmentId && !blocked) void call<Review>('environment_update_status', { environmentId }).then(value => { if (!stopped && version === reviewVersion.current) setReview(value); }).catch(() => {});
    return () => { stopped = true; };
  }, [environmentId, blocked, connection.connected]);
  useEffect(() => {
    if (!review || !['complete', 'rolled_back'].includes(review.state) || blocked || !connection.connected) return;
    let stopped = false;
    // A pre-update read must not replace the refreshed completion or rollback inventory.
    const version = ++inventoryVersion.current;
    void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped && version === inventoryVersion.current) setInventory(value); }).catch(() => { if (!stopped && version === inventoryVersion.current) setInventory(null); });
    return () => { stopped = true; };
  }, [review?.state, review?.operationId, environmentId, blocked, connection.connected]);
  useEffect(() => {
    if (!review || terminal.includes(review.state) || blocked) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (working.current) { if (!stopped) timer = setTimeout(() => void poll(), 1000); return; }
      const version = reviewVersion.current;
      try { const value = await call<Review>('environment_update_status', { environmentId }); if (!stopped && version === reviewVersion.current) { setReview(value); setError(''); } }
      catch { if (!stopped && version === reviewVersion.current) setError('Progress unavailable. The server may still be updating; no launch will be repeated.'); }
      if (!stopped) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [review?.operationId, review?.state, blocked, environmentId]);
  const current = inventory ?? review?.installed;
  const updating = !!review && !terminal.includes(review.state);
  const uncertain = !!review && ['unknown', 'needs_attention'].includes(review.state);
  const observed = !!current && connection.connected && !connection.retired;
  const camoufox = connection.runtime?.browserDirect && connection.runtime.browserEngine === 'camoufox';
  const start = () => void operate(async () => {
    if (!review || review.state !== 'review' || !review.available || !approved) return;
    const reviewId = review.reviewId; setReview({ ...review, state: 'unknown' });
    setReview(await call<Review>('environment_update_start', { environmentId, reviewId, approved, password }));
  });
  const status = <Button disabled={blocked || busy} onClick={() => void operate(async () => { setReview(await call<Review>('environment_update_status', { environmentId })); })}>Check update status</Button>;
  return <div className="runtime-settings provider-runtime-stack" aria-label="Pi and extensions">
    <AutomaticUpdatesSection />
    <Section title="Pi runtime" description="Pi runs tasks on this server, not on your Mac.">
      <SettingRow title={`Pi ${current?.piVersion ?? connection.agentCatalogue?.piVersion ?? 'version unavailable'}`} description={current?.releaseId ?? connection.agentCatalogue?.releaseId ?? 'Server release not reported'} icon={<Cpu size={18} />}>
        <Badge tone={updating ? 'warning' : observed ? 'success' : 'neutral'}>{uncertain ? 'Needs attention' : updating ? 'Updating' : connection.retired ? 'Unavailable' : !connection.connected ? 'Disconnected' : observed ? 'Connected' : 'Status unknown'}</Badge>
      </SettingRow>
      <div className="provider-runtime-footer"><Button className="runtime-update-check" aria-label="Check Pi + bundled extensions" aria-busy={checking} title="Compare Pi and bundled extensions with the qualified server release bundled in this app" disabled={!environmentId || blocked || busy || !connection.connected || updating} onClick={() => void operate(async () => { setApproved(false); setReview(await call<Review>('environment_update_check', { environmentId })); }, 'check')}><RefreshCw size={16} aria-hidden="true" /><span className="runtime-check-label" aria-hidden="true"><span style={{ visibility: checking ? 'hidden' : 'visible' }}>Check Pi + bundled extensions</span>{checking && <span>Checking…</span>}</span></Button>{checking && <span className="sr-only" role="status">Checking Pi and bundled extensions…</span>}</div>
      {!environmentId && <p className="provider-runtime-note">This legacy connection cannot use native maintenance. Save and qualify the installation first; Outpost will not reinstall it automatically.</p>}
      {review && <div className="provider-runtime-callout" role="status">
        <div><strong>{review.state === 'review' ? review.available ? 'Bundled release available' : 'No newer bundled release' : `Update ${review.state.replaceAll('_', ' ')}`}</strong>
          {review.state === 'review' && review.available && <small>Pi {review.installed.piVersion === review.artifact.manifest.piVersion ? `${review.installed.piVersion} unchanged` : `${review.installed.piVersion} → ${review.artifact.manifest.piVersion}`} · Review bundled extensions</small>}
          {review.state !== 'review' && <small>{review.progress?.stage ?? 'Check the original operation receipt before taking further action.'}</small>}
          {review.state === 'review' && !review.available && <details className="ui-details"><summary>Release check details</summary><p>{review.message}</p></details>}
        </div>
        {(review.state !== 'review' || review.available) && <Button onClick={() => { setApproved(false); setReviewOpen(true); }}>{review.state === 'review' ? 'Review update…' : 'View update status'}</Button>}
      </div>}
      {error && <p role="alert" className="provider-runtime-note">{error}</p>}
      {busy && !checking && <p role="status" className="provider-runtime-note">Checking the reviewed server operation…</p>}
      <details className="ui-details provider-runtime-note"><summary>Release & recovery details</summary><p>Pi and extensions update together as a qualified Outpost server release. This does not update Pi on your Mac or install arbitrary extension packages.</p><p>Credentials, sessions and task history stay on this server. Its previous compatible release is retained for verified recovery. A standalone runtime restart is not offered here.</p>{environmentId && status}</details>
    </Section>
    <Section title="Extensions & browser tools" description="Managed with the Outpost server release.">
      {current ? current.extensions.length ? current.extensions.map(extension => {
        const state = current.extensionStates?.[extension.name];
        return <SettingRow key={extension.name} title={extension.name} description={extension.version} icon={<Puzzle size={18} />}><Badge tone={observed && state === 'enabled' ? 'success' : 'neutral'}>{observed && state === 'enabled' ? 'Enabled' : `${observed ? 'Installed' : 'Last reported'} · ${state || 'status unknown'}`}</Badge></SettingRow>;
      }) : <p className="provider-runtime-note">No bundled extensions reported.</p> : <p className="provider-runtime-note">Extension inventory unavailable.</p>}
      {observed && current?.extensions.some(extension => current.extensionStates?.[extension.name] === 'enabled') && <p className="provider-runtime-note">{nativeExtensionsNotice}</p>}
      {current?.extensions.some(extension => current.extensionStates?.[extension.name] === 'inactive') && <p className="provider-runtime-note">{observed ? 'This server reports inactive extensions.' : 'The last inventory reported inactive extensions.'} A server update is required to activate them.</p>}
      {camoufox && <SettingRow title="Camoufox" description="Browser tools · uses the task’s selected model" icon={<Puzzle size={18} />}><Badge>{connection.connected ? 'Managed tool' : 'Last reported'}</Badge></SettingRow>}
      <details className="ui-details provider-runtime-note"><summary>Extension management details</summary><p>General extension installation and independent Pi upgrades are not offered here. Pi and qualified extensions update as one compatible server release. Camoufox uses the task’s selected model; it has no separate model or credential setting.</p></details>
    </Section>
    {reviewOpen && review && <Dialog title={review.state === 'review' ? 'Review bundled release' : `Update ${review.state.replaceAll('_', ' ')}`} onClose={() => { setReviewOpen(false); setApproved(false); }} className="provider-runtime-dialog runtime-update-dialog">
      {review.state === 'review' ? <>
        <p>{review.message}</p>
        {review.available && <><dl className="ui-facts"><dt>Pi</dt><dd>{review.installed.piVersion} → {review.artifact.manifest.piVersion}</dd><dt>Target release</dt><dd><code>{review.artifact.manifest.id}</code></dd>{review.artifact.manifest.extensions.map(extension => <div key={extension.name}><dt>{extension.name}</dt><dd>{review.installed.extensions.find(e => e.name === extension.name)?.version ?? 'Not installed'} → {extension.version}</dd></div>)}</dl>
          {review.artifact.extensionPolicy === 'native-installed' ? <p className="provider-runtime-note">{nativeReleaseNotice} {nativeExtensionsNotice}</p> : review.artifact.manifest.extensions.some(extension => extension.name === 'pi-subagents') && <p className="provider-runtime-note">{legacySubagentsNotice}</p>}
          <p>Dependencies stage while the server keeps working. Once staging passes, new work pauses while existing tasks, sign-ins and imports drain. Activation restarts this server. If health checks fail, Outpost attempts a verified rollback; uncertain recovery keeps dispatch paused.</p>
          <label className="provider-runtime-check"><input type="checkbox" checked={password} disabled={busy} onChange={e => setPassword(e.target.checked)} />Ask for the remote sudo password in a protected native dialog</label><p>Uncheck only for root or an account with appropriate passwordless sudo. No password enters this page or is saved.</p>
          <label className="provider-runtime-check"><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)} />I approve this release update and a temporary interruption on this server.</label>
        </>}
      </> : <><p role="status">{review.progress?.stage ?? (review.state === 'waiting_for_idle' ? 'Waiting for existing work and provider sign-ins to finish. New tasks are blocked.' : 'Check the server receipt to confirm the outcome. Do not repeat an unknown launch.')}</p><p>Operation <code>{review.operationId}</code></p>
        {review.state === 'unknown' && <p>The server only permits cancellation of this device’s pending operation while staging or draining. It will refuse if activation has started or maintenance is held. Cancellation is not confirmed until server status verifies it.</p>}

        {['unknown', 'needs_attention'].includes(review.state) && <p>Do not reinstall or remove retained releases. If status cannot be reconciled, ask the server administrator to inspect <code>/var/lib/outpost-setup/operations/{review.operationId}</code>. Maintenance may remain held.</p>}
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog-actions runtime-update-actions">
        {['authorizing', 'queued', 'staging', 'waiting_for_idle', 'unknown'].includes(review.state) && <Button disabled={blocked || busy} onClick={() => void operate(async () => { setReview(await call<Review>('environment_update_cancel', { environmentId })); setApproved(false); })}>{review.state === 'unknown' ? 'Cancel pending update' : review.state === 'waiting_for_idle' ? 'Cancel waiting update' : 'Cancel before activation'}</Button>}
        <div className="runtime-update-actions-end">
          {updating && status}
          <Button onClick={() => { setReviewOpen(false); setApproved(false); }}>{review.state === 'review' ? 'Back' : 'Done'}</Button>
          {review.state === 'review' && review.available && <Button variant="primary" disabled={blocked || busy || !approved} onClick={start}>Authorize server update</Button>}
        </div>
      </div>
    </Dialog>}
  </div>;
}
