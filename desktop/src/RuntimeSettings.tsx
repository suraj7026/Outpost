import { useEffect, useRef, useState } from 'react';
import { Cpu, Puzzle, RefreshCw } from 'lucide-react';
import { call, nativeApp, recordedPreview } from './api';
import { Badge, Button, Dialog, Section, SettingRow } from './Interface';
import type { Connection } from './useConnection';
import { ServerUpdateIcon, useAutomaticUpdates } from './AutomaticUpdates';
import { automaticUpdatesPending } from './automatic-updates';
import './provider-runtime-parity.css';

type Manifest = { id: string; piVersion: string; sequence: number; extensions: { name: string; version: string }[] };
type Inventory = { piVersion: string; releaseId: string; extensions: Manifest['extensions']; extensionStates?: Record<string, string>; manifest: Manifest | null };
type Review = { reviewId: string; operationId: string; state: string; message: string; available: boolean; checkOutcome?: 'update_available' | 'up_to_date' | 'blocked'; installed: Inventory; artifact: { manifest: Manifest; extensionPolicy?: string }; progress?: { stage: string } };
const completedReceipt = (environmentId: Connection['environmentId'], review: Review | null) => review && ['complete', 'rolled_back'].includes(review.state) ? JSON.stringify([environmentId, review.operationId, review.state]) : null;
const terminal = ['review', 'complete', 'rolled_back', 'failed', 'cancelled'];
const legacySubagentsNotice = 'Bundled pi-subagents is inactive for managed tasks in this legacy release. Authorizing this release does not enable it.';
const nativeExtensionsNotice = 'In Full control, installed native extensions and subagents run with the server worker’s permissions, without individual action approvals. Compatible Auto servers disable them for Auto tasks.';
const nativeReleaseNotice = 'Installing this release makes native extensions available to Full control tasks.';

export default function RuntimeSettings({ connection, startRequested = false }: { connection: Connection; startRequested?: boolean }) {
  const [review, setReview] = useState<Review | null>(null), [inventory, setInventory] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [approved, setApproved] = useState(false), [password, setPassword] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false), [checking, setChecking] = useState(false);
  const working = useRef(false);
  const reviewVersion = useRef(0), inventoryVersion = useRef(0);
  const inventoryReceipt = useRef<string | null>(null), automaticCompletion = useRef<string | null>(null);
  const automatic = useAutomaticUpdates();
  const blocked = !nativeApp() || recordedPreview() || connection.retired || !!connection.info?.pendingError || !!connection.info?.pending;
  const environmentId = connection.environmentId;
  const automaticStatus = automatic?.available ? automatic.status : null;
  const automaticServer = automaticStatus?.servers.find(server => server.environmentId === environmentId);
  // The supervisor also reserves adopted manual receipts; it is not cancellation authority.
  const automaticOwnsServer = !!automaticStatus && automaticUpdatesPending({ ...automaticStatus,
    activeEnvironmentId: automaticStatus.activeEnvironmentId === environmentId ? environmentId : null,
    servers: automaticServer ? [automaticServer] : [],
  });
  const automaticCheckBlocked = automaticOwnsServer || !!(automatic?.available && automatic.uncertain && !automaticStatus?.activeEnvironmentId && (!automaticStatus || automaticStatus.targets.includes(environmentId ?? '') || automaticServer));
  const automaticStartBlocked = !!(automatic?.available && (automatic.busy || automatic.uncertain || automaticUpdatesPending(automaticStatus)));
  const completion = automaticServer?.state === 'complete' && !automatic?.uncertain && !automaticOwnsServer
    ? JSON.stringify([environmentId, automaticServer.releaseId ?? null]) : null;
  const failedUpdate = automaticServer?.state === 'failed';
  const activeUpdate = automaticOwnsServer && !['failed', 'rolled_back', 'needs_attention', 'blocked'].includes(automaticServer?.state ?? '');
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [stopNotice, setStopNotice] = useState('');
  const updating = !!review && !terminal.includes(review.state);
  const updateAvailable = !!review?.available && (!review.checkOutcome || review.checkOutcome === 'update_available');
  const operate = async (action: (current: () => boolean) => Promise<void>, kind: 'check' | 'start' | 'operation' = 'operation') => {
    if (blocked || working.current || (kind === 'check' && (!connection.connected || updating || automaticCheckBlocked)) || (kind === 'start' && (!connection.connected || automaticStartBlocked))) return;
    // Older passive status reads must not overwrite this explicit operation.
    const version = ++reviewVersion.current;
    const current = () => version === reviewVersion.current;
    working.current = true; setBusy(true); setChecking(kind === 'check'); setError('');
    try { await action(current); } catch { if (current()) setError(kind === 'check' ? 'Couldn’t check the bundled release. No update was started. Check your connection and try again.' : 'The operation could not be confirmed. Check update status before doing anything else. No update is automatically repeated.'); }
    finally { working.current = false; setBusy(false); setChecking(false); }
  };
  useEffect(() => {
    let stopped = false;
    const inventoryRequest = ++inventoryVersion.current;
    // A newly observed automatic completion performs both reads below, including after reconnect.
    const automaticRefreshPending = connection.connected && completion && completion !== automaticCompletion.current;
    if (!blocked && connection.connected && !automaticRefreshPending) void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped && inventoryRequest === inventoryVersion.current) setInventory(value); }).catch(() => { if (!stopped && inventoryRequest === inventoryVersion.current) setError('Runtime inventory unavailable. This server may need a compatible maintenance release.'); });
    return () => { stopped = true; reviewVersion.current += 1; inventoryVersion.current += 1; };
  }, [environmentId, blocked, connection.connected]);
  useEffect(() => {
    // Fence old checks before reading the reserved operation, including on initial mount.
    if (automaticCheckBlocked) { reviewVersion.current += 1; setApproved(false); }
    const automaticRefreshPending = connection.connected && completion && completion !== automaticCompletion.current;
    if (!environmentId || blocked || automaticRefreshPending || (working.current && !automaticCheckBlocked)) return;
    let stopped = false;
    const version = reviewVersion.current;
    void call<Review>('environment_update_status', { environmentId }).then(value => { if (!stopped && version === reviewVersion.current) setReview(value); }).catch(() => {});
    return () => { stopped = true; };
  }, [environmentId, blocked, connection.connected, automaticCheckBlocked]);
  useEffect(() => {
    const receipt = completedReceipt(environmentId, review);
    if (!receipt || receipt === inventoryReceipt.current || blocked || !connection.connected) return;
    inventoryReceipt.current = receipt;
    let stopped = false;
    // A pre-update read must not replace the refreshed completion or rollback inventory.
    const version = ++inventoryVersion.current;
    void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => { if (!stopped && version === inventoryVersion.current) setInventory(value); }).catch(() => { if (!stopped && version === inventoryVersion.current) setInventory(null); });
    return () => { stopped = true; };
  }, [review?.state, review?.operationId, environmentId, blocked, connection.connected]);

  useEffect(() => {
    if (!completion || completion === automaticCompletion.current || blocked || !connection.connected || busy) return;
    automaticCompletion.current = completion;
    setApproved(false);
    const version = ++reviewVersion.current, inventoryRequest = ++inventoryVersion.current;
    // The base effect fences both requests on disconnect/unmount; manual actions fence status.
    void call<Review>('environment_update_status', { environmentId }).then(value => {
      if (version !== reviewVersion.current) return;
      inventoryReceipt.current = completedReceipt(environmentId, value);
      setReview(value);
    }).catch(() => {});
    void connection.api.agentRequest<Inventory>({ type: 'runtime.inventory' }).then(value => {
      if (inventoryRequest === inventoryVersion.current) setInventory(value);
    }).catch(() => { if (inventoryRequest === inventoryVersion.current) setInventory(null); });
  }, [completion, environmentId, blocked, connection.connected, busy]);
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
  const requested = useRef(false);
  useEffect(() => {
    if (!startRequested || requested.current || !environmentId || blocked || !connection.connected || !automatic?.status || automatic.busy) return;
    requested.current = true;
    if (automatic.status.enabled && automatic.status.targets.includes(environmentId)) {
      void automatic.updateServer(environmentId);
    } else {
      void operate(async current => {
        const value = await call<Review>('environment_update_check', { environmentId });
        if (current()) { setReview(value); setReviewOpen(true); }
      }, 'check');
    }
  }, [startRequested, environmentId, blocked, connection.connected, automatic?.status, automatic?.busy]);
  const current = inventory ?? review?.installed;
  const uncertain = !!review && ['unknown', 'needs_attention'].includes(review.state);
  const observed = !!current && connection.connected && !connection.retired;
  const camoufox = connection.runtime?.browserDirect && connection.runtime.browserEngine === 'camoufox';
  const start = () => void operate(async current => {
    if (!review || review.state !== 'review' || !updateAvailable || !approved) return;
    const reviewId = review.reviewId; setReview({ ...review, state: 'unknown' });
    const value = await call<Review>('environment_update_start', { environmentId, reviewId, approved, password });
    if (current()) setReview(value);
  }, 'start');
  const status = <Button disabled={blocked || busy} onClick={() => void operate(async current => {
    const value = await call<Review>('environment_update_status', { environmentId });
    if (current()) setReview(value);
  })}>Check update status</Button>;
  return <div className="runtime-settings provider-runtime-stack" aria-label="Server updates">
    <Section title="Server update">
      <div className="server-update-summary"><ServerUpdateIcon size={25} aria-hidden="true" /><div><h2>{automatic?.uncertain ? 'Update status unavailable' : automaticServer?.state === 'complete' ? 'Your server is up to date' : automaticServer && ['failed', 'needs_attention', 'unknown', 'rolled_back'].includes(automaticServer.state) ? 'Update needs attention' : automaticOwnsServer ? 'Updating server…' : automaticServer?.state === 'checked' ? 'Update available' : 'Check for updates'}</h2><p>{failedUpdate ? 'The previous release is still running.' : activeUpdate ? 'Checking the existing update before continuing.' : automaticServer?.state === 'complete' ? 'You have the latest verified release.' : 'Keep this server up to date.'}</p></div><Button disabled={blocked || busy || automatic?.busy || !connection.connected} onClick={() => {
        if (failedUpdate) { setRecoverOpen(true); return; }
        if (environmentId && automaticStatus?.enabled && automaticStatus.targets.includes(environmentId)) void automatic?.updateServer(environmentId);
        else void operate(async current => { const value = await call<Review>('environment_update_check', { environmentId }); if (current()) { setReview(value); setReviewOpen(true); } }, 'check');
      }}>{failedUpdate ? 'Inspect & recover' : activeUpdate ? 'Check progress' : 'Update server'}</Button>
      {(activeUpdate || updating) && <Button variant="danger" disabled={blocked || busy || automatic?.busy || !connection.connected || !!review && ['activating', 'recovering', 'verifying'].includes(review.state)} title="Stop before activation. The server verifies whether cancellation is still possible." onClick={() => void operate(async current => {
        setStopNotice('Requesting update stop…');
        try {
          const value = await call<Review>('environment_update_cancel', { environmentId });
          if (current()) {
            setReview(value); setApproved(false);
            setStopNotice(value.state === 'cancelled' ? 'Update stopped.' : 'Stop requested. Waiting for the server to confirm; the update may still be running.');
          }
        } catch {
          if (current()) setStopNotice('Stop could not be confirmed. Activation may have started, or the server is unavailable. Check progress before trying again.');
        }
        await automatic?.refresh();
      })}>Stop update</Button>}
      </div>
      {stopNotice && <p role="status" aria-live="polite" className="provider-runtime-note">{stopNotice}</p>}
      <SettingRow title="Automatic updates" description="Update when this server connects."><Badge>{automaticStatus?.enabled && automaticStatus.targets.includes(environmentId ?? '') ? 'On' : 'Off'}</Badge></SettingRow>
      {automaticServer && ['failed', 'needs_attention', 'unknown', 'rolled_back', 'blocked'].includes(automaticServer.state) && <p role="status" className="provider-runtime-note">{automaticServer.message}</p>}
      {automatic?.error && <p role="alert">{automatic.error}</p>}
      {activeUpdate && <progress aria-label="Server update in progress" />}
    </Section>
    <details className="ui-details"><summary>Details & update recovery</summary>
    <Section title="Outpost server release" description="Checks compare this server with the qualified release bundled in this app, not the latest release online.">
      <SettingRow title="Installed release" description={<><code>{current?.releaseId ?? connection.agentCatalogue?.releaseId ?? 'Server release not reported'}</code> · {current?.manifest?.sequence != null ? `Sequence ${current.manifest.sequence}` : 'Sequence unavailable'}</>} icon={<Cpu size={18} />}>
        <Badge tone={updating ? 'warning' : observed ? 'success' : 'neutral'}>{uncertain ? 'Needs attention' : updating ? 'Updating' : connection.retired ? 'Unavailable' : !connection.connected ? 'Disconnected' : observed ? 'Connected' : 'Status unknown'}</Badge>
      </SettingRow>
      <div className="provider-runtime-footer"><Button className="runtime-update-check" aria-label="Check for server updates" aria-busy={checking} title="Compare the installed Outpost server release with the qualified release bundled in this app" disabled={!environmentId || blocked || busy || !connection.connected || updating || automaticCheckBlocked} onClick={() => void operate(async current => { setApproved(false); const value = await call<Review>('environment_update_check', { environmentId }); if (current()) setReview(value); }, 'check')}><RefreshCw size={16} aria-hidden="true" /><span className="runtime-check-label" aria-hidden="true"><span style={{ visibility: checking ? 'hidden' : 'visible' }}>Check for server updates</span>{checking && <span>Checking…</span>}</span></Button>{checking && <span className="sr-only" role="status">Checking the bundled server release…</span>}</div>
      {!environmentId && <p className="provider-runtime-note">This legacy connection cannot use native maintenance. Save and qualify the installation first; Outpost will not reinstall it automatically.</p>}
      {review && <div className="provider-runtime-callout" role="status">
        <div><strong>{review.state === 'review' ? review.checkOutcome === 'blocked' ? 'Update blocked' : review.checkOutcome === 'up_to_date' ? 'Up to date with this app' : updateAvailable ? 'Server update available' : 'No update available' : `Update ${review.state.replaceAll('_', ' ')}`}</strong>
          {review.state === 'review' && updateAvailable && <><small>Server release <code>{review.installed.releaseId}</code> → <code>{review.artifact.manifest.id}</code> · Sequence {review.installed.manifest?.sequence ?? 'unknown'} → {review.artifact.manifest.sequence}</small><small>Pi {review.installed.piVersion === review.artifact.manifest.piVersion ? `${review.installed.piVersion} unchanged` : `${review.installed.piVersion} → ${review.artifact.manifest.piVersion}`} · Review bundled extensions</small></>}
          {review.state !== 'review' && <small>{review.progress?.stage ?? 'Check the original operation receipt before taking further action.'}</small>}
          {review.state === 'review' && review.checkOutcome === 'blocked' && <p>{review.message}</p>}
          {review.state === 'review' && !updateAvailable && review.checkOutcome !== 'blocked' && <details className="ui-details"><summary>Release check details</summary><p>{review.message}</p></details>}
        </div>
        {(review.state !== 'review' || updateAvailable) && <Button onClick={() => { setApproved(false); setReviewOpen(true); }}>{review.state === 'review' ? 'Review update…' : 'View update status'}</Button>}
      </div>}
      {automaticCheckBlocked && <p role="status" className="provider-runtime-note">This server has an update pending or an uncertain supervisor outcome. Check supervisor status before starting another update.</p>}
      {error && <p role="alert" className="provider-runtime-note">{error}</p>}
      {busy && !checking && <p role="status" className="provider-runtime-note">Checking the reviewed server operation…</p>}
      <details className="ui-details provider-runtime-note"><summary>Release & recovery details</summary><p>The coordinator, Pi and bundled extensions update together as a qualified Outpost server release. A newer server release can keep the same Pi version. Checks use the release bundled with this app, not a remote latest-release feed. This does not update Pi on your Mac or install arbitrary extension packages.</p><p>Credentials, sessions and task history stay on this server. Its previous compatible release is retained for verified recovery. A standalone runtime restart is not offered here.</p>{environmentId && status}</details>
    </Section>
    <Section title="Pi runtime" description="Pi runs tasks on this server, not on your Mac.">
      <SettingRow title={`Pi ${current?.piVersion ?? connection.agentCatalogue?.piVersion ?? 'version unavailable'}`} description="Included in the Outpost server release." icon={<Cpu size={18} />} />
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
    </details>
    {recoverOpen && <Dialog title="Recover failed update" onClose={() => setRecoverOpen(false)} busy={automatic?.busy}>
      <p>Inspect the stopped update and verify that the previous release is still active. If it is safe, Outpost will retain the failed receipt, release the stale queue reservation and start a fresh update check.</p>
      <p>Running tasks stay running. Uncertain operations and active maintenance holds cannot be cleared here.</p>
      {connection.records.some(record => record.kind === 'task' && ['running', 'queued'].includes(String(record.data.state))) && <p role="status">This server has active tasks. Finish or pause them before restarting the update to avoid another idle timeout.</p>}
      <label className="provider-runtime-check"><input type="checkbox" checked={password} onChange={event => setPassword(event.target.checked)} disabled={automatic?.busy} />Use a protected sudo password dialog for host inspection</label>
      {automatic?.error && <p role="alert">{automatic.error}</p>}
      <div className="ui-dialog-actions"><Button disabled={automatic?.busy} onClick={() => setRecoverOpen(false)}>Back</Button><Button variant="primary" disabled={blocked || automatic?.busy || !connection.connected} onClick={() => {
        if (!environmentId) return;
        void automatic?.recoverServer(environmentId, true, password).then(async recovered => {
          if (!recovered) return;
          setRecoverOpen(false);
          await automatic.updateServer(environmentId);
        });
      }}>Inspect and restart update</Button></div>
    </Dialog>}
    {reviewOpen && review && <Dialog title={review.state === 'review' ? 'Review bundled release' : `Update ${review.state.replaceAll('_', ' ')}`} onClose={() => { setReviewOpen(false); setApproved(false); }} className="provider-runtime-dialog runtime-update-dialog">
      {review.state === 'review' ? <>
        <p>{review.message}</p>
        {updateAvailable && <><dl className="ui-facts"><dt>Installed release</dt><dd><code>{review.installed.releaseId}</code></dd><dt>Target release</dt><dd><code>{review.artifact.manifest.id}</code></dd><dt>Release sequence</dt><dd>{review.installed.manifest?.sequence ?? 'Unknown'} → {review.artifact.manifest.sequence}</dd><dt>Pi</dt><dd>{review.installed.piVersion} → {review.artifact.manifest.piVersion}</dd>{review.artifact.manifest.extensions.map(extension => <div key={extension.name}><dt>{extension.name}</dt><dd>{review.installed.extensions.find(e => e.name === extension.name)?.version ?? 'Not installed'} → {extension.version}</dd></div>)}</dl>
          {review.artifact.extensionPolicy === 'native-installed' ? <p className="provider-runtime-note">{nativeReleaseNotice} {nativeExtensionsNotice}</p> : review.artifact.manifest.extensions.some(extension => extension.name === 'pi-subagents') && <p className="provider-runtime-note">{legacySubagentsNotice}</p>}
          <p>Dependencies stage while the server keeps working. Once staging passes, new work pauses while existing tasks, sign-ins and imports drain. Activation restarts this server. If health checks fail, Outpost attempts a verified rollback; uncertain recovery keeps dispatch paused.</p>
          <label className="provider-runtime-check"><input type="checkbox" checked={password} disabled={busy || automaticStartBlocked} onChange={e => setPassword(e.target.checked)} />Ask for the remote sudo password in a protected native dialog</label><p>Uncheck only for root or an account with appropriate passwordless sudo. No password enters this page or is saved.</p>
          <label className="provider-runtime-check"><input type="checkbox" checked={approved} disabled={busy || automaticStartBlocked} onChange={e => setApproved(e.target.checked)} />I approve this release update and a temporary interruption on this server.</label>
        </>}
      </> : <><p role="status">{review.progress?.stage ?? (review.state === 'waiting_for_idle' ? 'Waiting for existing work and provider sign-ins to finish. New tasks are blocked.' : 'Check the server receipt to confirm the outcome. Do not repeat an unknown launch.')}</p><p>Operation <code>{review.operationId}</code></p>
        {review.state === 'unknown' && <p>The server only permits cancellation of this device’s pending operation while staging or draining. It will refuse if activation has started or maintenance is held. Cancellation is not confirmed until server status verifies it.</p>}

        {['unknown', 'needs_attention'].includes(review.state) && <p>Do not reinstall or remove retained releases. If status cannot be reconciled, ask the server administrator to inspect <code>/var/lib/outpost-setup/operations/{review.operationId}</code>. Maintenance may remain held.</p>}
      </>}
      {review.state === 'review' && automaticStartBlocked && <p role="status">Automatic update work is pending or supervisor status is uncertain. Check supervisor status before authorizing a manual update.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog-actions runtime-update-actions">
        {['authorizing', 'queued', 'staging', 'waiting_for_idle', 'unknown'].includes(review.state) && <Button disabled={blocked || busy} onClick={() => void operate(async current => { const value = await call<Review>('environment_update_cancel', { environmentId }); if (current()) { setReview(value); setApproved(false); } })}>{review.state === 'unknown' ? 'Cancel pending update' : review.state === 'waiting_for_idle' ? 'Cancel waiting update' : 'Cancel before activation'}</Button>}
        <div className="runtime-update-actions-end">
          {updating && status}
          <Button onClick={() => { setReviewOpen(false); setApproved(false); }}>{review.state === 'review' ? 'Back' : 'Done'}</Button>
          {review.state === 'review' && updateAvailable && <Button variant="primary" disabled={blocked || busy || !connection.connected || automaticStartBlocked || !approved} onClick={start}>Authorize server update</Button>}
        </div>
      </div>
    </Dialog>}
  </div>;
}
