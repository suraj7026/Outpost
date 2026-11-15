import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, KeyRound, Link, LockKeyhole, Plus, Server, X } from 'lucide-react';
import { call, nativeApp, recordedPreview } from './api';
import type { Metadata, MutateRegistry } from './Environments';
import ServerInstall from './ServerInstall';
import ServerSetupPane, { setupEntryStatus } from './ServerSetupPane';
import { mergeSetupEntry, setupArchiveBlocker, setupStore, useServerSetup, type Entry, type Scan, type ServerSetupState } from './server-setup-state';
import { isDraftEdited, sameSetupTarget, setupDrafts, targetForDraft, useSetupDrafts, type Draft, type DraftPatch } from './server-setup-drafts';
import './server-setup.css';
import './server-setup-lifecycle.css';
import './server-restart.css';
import { restartHeld, setupRestarts, useSetupRestarts } from './server-restart';

export type { Entry } from './server-setup-state';
function InlineConfirmation({ title, children, confirmLabel, disabled, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; disabled?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const id = useId(), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return <div className="setup-lifecycle-confirm" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <h3 id={`${id}-title`}>{title}</h3><div id={`${id}-description`}>{children}</div>
    <div className="setup-lifecycle-actions"><button ref={cancel} onClick={onCancel}>Keep setup</button>
      <button className="danger" onClick={onConfirm} disabled={disabled}>{confirmLabel}</button></div>
  </div>;
}

function DraftPane({ draft, active, busy, error, committing, uncertainTrust, onTrusted, reconcileTrust, onClose, onDiscard }: {
  draft: Draft; active: boolean; busy: string; error: string; committing: boolean; uncertainTrust: boolean;
  onTrusted: (draftId: string, entry: Entry) => void; reconcileTrust: () => Promise<boolean>;
  onClose: () => void; onDiscard: (id: string) => void;
}) {
  const id = useId(), step = draft.scan ? 1 : 0;
  const [confirmDiscard, setConfirmDiscard] = useState(false), [rechecking, setRechecking] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const discardButton = useRef<HTMLButtonElement>(null), mounted = useRef(true);
  const restartButton = useRef<HTMLButtonElement>(null), restartCancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmRestart) restartCancel.current?.focus(); }, [confirmRestart]);
  const returnToDraft = () => { setConfirmRestart(false); requestAnimationFrame(() => restartButton.current?.focus()); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!active) { setConfirmDiscard(false); setConfirmRestart(false); } }, [active]);
  const update = setupDrafts.update;
  const change = (patch: DraftPatch) => update(draft.id, { ...patch, scan: null, confirmed: false });
  const scan = () => void setupDrafts.operate(draft.id, 'Checking connection', async request => {
    const target = targetForDraft(draft);
    const result = await call<Scan>('setup_scan', { target });
    if (!request.current()) return;
    if (!result.id || !result.fingerprint || !sameSetupTarget(result.target, target))
      throw new Error('The SSH scan returned a different target. Nothing was trusted.');
    request.update({ scan: result, confirmed: false });
  });
  const chooseIdentity = () => void setupDrafts.operate(draft.id, 'Selecting SSH key', async request => {
    const path = await call<string>('setup_choose_identity');
    if (path) request.update({ identityFile: path, auth: 'file', scan: null, confirmed: false });
  });
  const trust = () => void setupDrafts.operate(draft.id, 'Trusting host', async request => {
    if (!draft.scan || !draft.confirmed || !sameSetupTarget(draft.scan.target, targetForDraft(draft)))
      throw new Error('Verify this server’s fingerprint first.');
    try {
      const response = await call<Entry>('setup_trust', { id: draft.scan.id, fingerprint: draft.scan.fingerprint, label: draft.label.trim() });
      const entry = mergeSetupEntry(undefined, response, draft.scan.id);
      if (!sameSetupTarget(entry.target, draft.scan.target) || entry.fingerprint !== draft.scan.fingerprint)
        throw new Error('The trusted response does not match the reviewed SSH identity. Inspect the setup journal before continuing.');
      // Trust is durable. Keep its result even if this pane closed or unmounted during IPC.
      onTrusted(draft.id, entry);
    } catch (failure) {
      if (!await reconcileTrust()) request.keepTrustPending();
      throw failure;
    }
  }, true);
  const recheckTrust = async () => {
    if (rechecking) return;
    setRechecking(true);
    try { if (await reconcileTrust()) setupDrafts.resolveUncertainTrust(draft.id); }
    finally { if (mounted.current) setRechecking(false); }
  };
  const discard = <button ref={discardButton} className="text-button danger" disabled={committing}
    title={committing ? 'Wait until host trust has been reconciled.' : undefined}
    onClick={() => isDraftEdited(draft) ? setConfirmDiscard(true) : onDiscard(draft.id)}>Discard setup</button>;
  if (confirmRestart) return <ServerSetupPane label={draft.label || 'New server'} target={draft.scan?.target}
    status={{ label: 'Unsaved setup', tone: 'warning' }} step={step} active={active} logs={[]} note="Only this unsaved form is cleared. No remote changes."
    footer={<><button ref={restartCancel} className="text-button" onClick={returnToDraft}>Keep setup</button><button className="danger" disabled={committing}
      onClick={() => { if (setupDrafts.restart(draft.id)) returnToDraft(); }}>Clear form & restart</button></>}>
    <div className="stage-intro"><h2 className="stage-title">Restart this unsaved setup?</h2><p>Your entered connection details and unconfirmed fingerprint will be cleared. Saved host trust, installations and other setups are unchanged. No server command will run.</p></div>
  </ServerSetupPane>;
  return <ServerSetupPane label={draft.label || 'New server'} target={draft.scan?.target}
    status={{ label: busy || (draft.scan ? 'Verify host' : 'Not connected'), tone: busy ? 'running' : draft.scan ? 'warning' : 'muted' }}
    step={step} active={active} onStep={busy ? undefined : index => { if (index === 0) change({}); }} furthest={step}
    onRestart={() => setConfirmRestart(true)} restartRef={restartButton} restartDisabled={committing}
    error={error} logs={draft.scan ? ['SSH host key received. Waiting for independent fingerprint verification. No installation changes made.'] : []}
    fingerprint={draft.scan?.fingerprint} note="No installation changes have been made to this server."
    footer={step === 0 ? <>{discard}<button className="text-button" onClick={onClose}>Close</button><button className="primary" type="submit" form={`${id}-connection`} disabled={!!busy}>{busy || 'Check connection'}<ArrowRight className="icon" aria-hidden="true" /></button></>
      : <>{discard}<button className="text-button" disabled={!!busy} onClick={() => change({})}>Back</button><button className="primary" disabled={!!busy || !draft.confirmed} onClick={trust}>{busy || 'Trust & inspect'}<ArrowRight className="icon" aria-hidden="true" /></button></>}>
    {confirmDiscard && <InlineConfirmation title="Discard this unsaved setup?" confirmLabel="Discard setup" disabled={committing}
      onConfirm={() => onDiscard(draft.id)} onCancel={() => { setConfirmDiscard(false); discardButton.current?.focus(); }}>
      <p>Only this unsaved form will be removed. Saved connections, host trust and installations are unchanged.</p>
    </InlineConfirmation>}
    {committing && <div className="setup-lifecycle-note" role={active ? 'status' : undefined}><p>{uncertainTrust
      ? 'The trust result could not be reconciled with the local journal. This form is protected until its saved state can be checked.'
      : 'Host trust is being saved. You can close setup; the saved result will be kept.'}</p>
      {uncertainTrust && <button disabled={rechecking} onClick={() => void recheckTrust()}>{rechecking ? 'Checking saved trust…' : 'Check saved trust'}</button>}
    </div>}
    {step === 0 ? <>
      <div className="stage-intro"><h2 className="stage-title">Let’s connect your server.</h2><p>Start with SSH. We’ll check what’s there before changing anything.</p></div>
      <div className="form-grid"><form id={`${id}-connection`} className="form-stack" onSubmit={event => { event.preventDefault(); scan(); }}>
        <div className="field"><label htmlFor={`${id}-name`}>Server name</label><input id={`${id}-name`} required maxLength={80} placeholder="New server" value={draft.label} disabled={!!busy} onChange={event => update(draft.id, { label: event.target.value })} autoComplete="off" /><small>A name you’ll recognize in your workspace.</small></div>
        <div className="field"><label htmlFor={`${id}-host`}>Server address</label><input id={`${id}-host`} required value={draft.host} disabled={!!busy} onChange={event => change({ host: event.target.value })} placeholder="hostname or 192.168.1.20" spellCheck={false} autoComplete="off" /></div>
        <div className="field-row"><div className="field"><label htmlFor={`${id}-user`}>SSH username</label><input id={`${id}-user`} required value={draft.user} disabled={!!busy} onChange={event => change({ user: event.target.value })} placeholder="Your server login" spellCheck={false} autoComplete="off" /></div><div className="field"><label htmlFor={`${id}-port`}>SSH port</label><input id={`${id}-port`} type="number" min={1} max={65535} required value={draft.port} disabled={!!busy} onChange={event => change({ port: event.target.value })} /></div></div>
        <fieldset disabled={!!busy}><legend>Sign in with</legend><label className="radio-row"><input type="radio" name={`${id}-auth`} checked={draft.auth === 'agent'} onChange={() => change({ auth: 'agent' })} />SSH agent <span className="muted">(recommended)</span></label><label className="radio-row"><input type="radio" name={`${id}-auth`} checked={draft.auth === 'file'} onChange={() => change({ auth: 'file' })} />A private key on this Mac</label>
          {draft.auth === 'file' ? <div className="field path-note"><label htmlFor={`${id}-key`}>Private key path</label><div className="key-picker"><input id={`${id}-key`} required value={draft.identityFile} disabled={!!busy} onChange={event => change({ identityFile: event.target.value })} placeholder="/Users/you/.ssh/id_ed25519" spellCheck={false} /><button type="button" disabled={!!busy} onClick={chooseIdentity}>Choose SSH key…</button></div></div> : <p className="path-note">Uses keys already unlocked in your Mac’s SSH agent.</p>}
        </fieldset>
      </form><aside className="helper-column"><LockKeyhole className="icon" aria-hidden="true" /><h3>Your key stays on this Mac.</h3><p>Outpost uses a private SSH connection. No key upload and no public ports to open.</p><ul><li><Check className="icon" aria-hidden="true" />Check the server’s identity</li><li><Check className="icon" aria-hidden="true" />Look for an existing installation</li><li><Check className="icon" aria-hidden="true" />Show a plan before installing</li></ul><p>Unlock encrypted keys in your SSH agent first. Password login, SSH aliases, proxy commands and agent forwarding aren’t enabled.</p></aside></div>
    </> : <div role="group" aria-label="Verify SSH host fingerprint"><div className="stage-intro"><h2 className="stage-title">Is this your server?</h2><p>Compare this fingerprint with the one from your server’s console.</p></div>
      <div className="verification"><div className="verification-label"><KeyRound className="icon" aria-hidden="true" />SSH host fingerprint</div><code className="fingerprint">{draft.scan?.fingerprint}</code><p>{draft.scan?.target.user}@{draft.scan?.target.host}:{draft.scan?.target.port}</p></div>
      <div className="notice"><LockKeyhole className="icon" aria-hidden="true" /><div><strong>A connection isn’t proof of identity.</strong><p>Use the server console or a trusted administrator to verify this fingerprint independently. Don’t approve an unexpected change.</p></div></div>
      <label className="check-row"><input type="checkbox" checked={draft.confirmed} disabled={!!busy} onChange={event => update(draft.id, { confirmed: event.target.checked })} /><span>I independently verified this fingerprint.<small>The next check is read-only. No software is installed during inspection.</small></span></label>
    </div>}
  </ServerSetupPane>;
}

function HistoryActions({ entry, store, active, onArchived }: {
  entry: Entry; store: ServerSetupState; active: boolean; onArchived: (id: string) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), generation = useRef(0);
  const [confirm, setConfirm] = useState(false), [exporting, setExporting] = useState(false), [exportMessage, setExportMessage] = useState('');
  useEffect(() => {
      if (!active) { setConfirm(false); setExporting(false); setExportMessage(''); }
      return () => { generation.current++; };
    }, [active]);
  const blocker = setupArchiveBlocker(entry, store.busy[entry.id] || (store.checkingStatus[entry.id] ? 'Checking progress' : ''), store.statusErrors[entry.id])
    || (!store.historyLoaded || store.historyError ? 'Archived setups must be loaded before changing this list.' : '')
    || (store.historyBusy ? 'Another history change is finishing.' : '');
  const exportLog = async () => {
    const version = ++generation.current;
    setExporting(true); setExportMessage('');
    try {
      const path = await call<string>('setup_export_log', { id: entry.id });
      if (version === generation.current) setExportMessage(`Saved setup log to ${path}. Review it before sharing.`);
    } catch (error) { if (version === generation.current) setExportMessage(`Could not export the setup log: ${String(error)}`); }
    finally { if (version === generation.current) setExporting(false); }
  };
  return <section className="setup-history-actions" aria-label={`${entry.label} setup history`} hidden={!active}>
    <button ref={trigger} className="text-button" disabled={!!blocker || exporting} aria-describedby={blocker ? `${id}-blocked` : undefined}
      onClick={() => setConfirm(true)}>Remove from list…</button>
    {blocker && <p id={`${id}-blocked`}>{blocker}</p>}
    {confirm && <InlineConfirmation title="Remove this setup from the list?" confirmLabel="Remove from list" disabled={!!blocker || exporting}
      onCancel={() => { setConfirm(false); trigger.current?.focus(); }} onConfirm={() => void store.archive(entry.id).then(removed => { if (removed) onArchived(entry.id); })}>
      <p>{['failed', 'interrupted', 'cancelled'].includes(entry.installation?.state ?? entry.phase) && 'Partial installation files remain on the server. '}This does not uninstall Outpost, stop services or remove a saved connection. The setup log and host trust are kept. Restore it from Archived setups.</p>
      <button className="text-button" disabled={exporting || !!store.historyBusy} onClick={() => void exportLog()}>{exporting ? 'Saving setup log…' : 'Download setup log before removal'}</button>
      {exportMessage && <p role="status">{exportMessage}</p>}
    </InlineConfirmation>}
    {store.historyErrors[entry.id] && <p className="negative" role={active ? 'alert' : undefined}>{store.historyErrors[entry.id]}</p>}
  </section>;
}

export default function ServerSetup({ registry, mutate, refresh, environmentId, autoOpen = false, children }: {
  registry: Metadata; mutate: MutateRegistry; refresh: () => Promise<void>; environmentId?: string; autoOpen?: boolean; children?: ReactNode;
}) {
  const store = useServerSetup(), draftState = useSetupDrafts(), { drafts } = draftState;
  const restarts = useSetupRestarts();
  const enabled = nativeApp() && !recordedPreview();
  const [open, setOpen] = useState(autoOpen && enabled), [selected, setSelected] = useState('');
  const [inspectRequests, setInspectRequests] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null), launcher = useRef<HTMLButtonElement>(null);
  const alive = useRef(true), selection = useRef(selected), latest = useRef(store), environments = useRef(registry.environments);
  selection.current = selected; latest.current = store; environments.current = registry.environments;
  const id = useId();
  const focusSelection = useCallback(() => {
    requestAnimationFrame(() => {
      if (!alive.current || !dialog.current?.open) return;
      (dialog.current.querySelector<HTMLButtonElement>('.session[aria-current="true"]')
        ?? dialog.current.querySelector<HTMLButtonElement>('.add-server'))?.focus();
    });
  }, []);
  const select = useCallback((value: string) => {
    if (selection.current !== value) setupDrafts.leave(selection.current);
    selection.current = value; setSelected(value);
  }, []);
  const labels = () => [...Object.values(environments.current).map(environment => environment.label), ...latest.current.entries.map(entry => entry.label)];
  const add = useCallback(() => {
    const draftId = setupDrafts.add(labels(), latest.current.journalReady && !latest.current.journalError);
    select(draftId); setOpen(true);
  }, [select]);
  const editConnection = useCallback((entry: Entry) => {
    latest.current.invalidatePlan(entry.id);
    setupRestarts.close(entry.id);
    select(setupDrafts.fromEntry(entry));
  }, [select]);
  const openOriginal = useCallback((entryId: string) => {
    select(entryId);
    void latest.current.reload();
  }, [select]);
  const openFresh = useCallback((entry: Entry) => {
    select(entry.id);
    const current = latest.current.entries.find(value => value.id === entry.id) ?? entry;
    if (!current.inspection && !current.plan && !current.installation) setInspectRequests(previous => [...new Set([...previous, entry.id])]);
  }, [select]);
  useEffect(() => {
    for (const [sourceId, session] of Object.entries(restarts)) {
      if (session.result?.state !== 'complete' || !session.result.entry || session.delivered) continue;
      latest.current.completeRestart(session.connection, session.result.entry);
      setupRestarts.delivered(sourceId);
      // Selection, inspection and consent belong to the fresh entry, never the executed plan.
      if (selection.current === sourceId) openFresh(session.result.entry);
      void latest.current.reloadHistory();
      void refresh().catch(() => { /* The fresh setup remains available if registry refresh is offline. */ });
    }
  }, [restarts, openFresh, refresh]);
  useEffect(() => {
    alive.current = true;
    if (autoOpen && enabled && !environmentId) {
      const retainedRestart = Object.values(setupRestarts.getSnapshot()).find(session => session.open || session.pending || session.result?.state === 'complete' && !session.delivered);
      const retained = setupDrafts.getSnapshot().drafts[0];
      if (retainedRestart) select(retainedRestart.connection.id);
      else if (retained) select(retained.id); else add();
    }
    return () => { alive.current = false; setupDrafts.leaveAll(); };
  }, [autoOpen, enabled, environmentId, add, select]);
  useEffect(() => {
    setupDrafts.reconcileNames(labels(), store.journalReady && !store.journalError);
  }, [registry.environments, store.entries, store.journalReady, store.journalError, drafts]);
  useEffect(() => {
    const current = setupDrafts.getSnapshot().drafts.find(draft => draft.id === selection.current);
    setupDrafts.reconcileTrusted(store.entries);
    if (current && !setupDrafts.getSnapshot().drafts.some(draft => draft.id === current.id)) {
      if (current.scan && !store.archivedIds.includes(current.scan.id)) select(current.scan.id);
    }
    if (selection.current === 'direct-url' || selection.current === 'archived-setups'
      || setupDrafts.getSnapshot().drafts.some(draft => draft.id === selection.current)
      || store.entries.some(entry => entry.id === selection.current)) return;
    const available = store.entries.filter(entry => !store.archivedIds.includes(entry.id));
    const match = environmentId ? available.find(entry => (entry.installation?.environmentId ?? entry.inspection?.environment?.environmentId) === environmentId) : available[0];
    const removedSelection = !!selection.current;
    select(match?.id ?? setupDrafts.getSnapshot().drafts[0]?.id ?? '');
    if (removedSelection) focusSelection();
  }, [store.entries, store.archivedIds, drafts, environmentId, select, focusSelection]);
  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (open && !modal.open) {
      if (!opener.current?.isConnected) opener.current = launcher.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      modal.showModal(); modal.querySelector<HTMLButtonElement>('.close-setup')?.focus();
    } else if (!open && modal.open) {
      modal.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  const close = useCallback(() => { setupDrafts.leaveAll(); setOpen(false); }, []);
  const selectSurvivor = useCallback((removedId: string) => {
    if (!alive.current || selection.current !== removedId) return;
    const next = latest.current.entries.find(entry => entry.id !== removedId && !latest.current.archivedIds.includes(entry.id))?.id
      ?? setupDrafts.getSnapshot().drafts.find(draft => draft.id !== removedId && isDraftEdited(draft))?.id ?? '';
    select(next); focusSelection();
  }, [select, focusSelection]);
  const discard = (draftId: string) => { if (setupDrafts.discard(draftId)) selectSurvivor(draftId); };
  const trusted = useCallback((draftId: string, entry: Entry) => {
    latest.current.replace(entry);
    setupDrafts.reconcileTrusted([entry]);
    if (!alive.current) return;
    setInspectRequests(previous => [...new Set([...previous, entry.id])]);
    if (selection.current === draftId) select(entry.id);
    // The saved entry pane retains ownership of inspection and installation cancellation.
  }, [select]);
  const reconcileTrust = useCallback(async () => {
    // A journal flight issued before trust may not include its commit. Always follow it with a fresh read.
    if (setupStore.getSnapshot().loading) await setupStore.reload();
    await setupStore.reload();
    const snapshot = setupStore.getSnapshot();
    if (!snapshot.journalReady || snapshot.journalError) return false;
    setupDrafts.reconcileTrusted(snapshot.entries);
    return true;
  }, []);
  const openSetup = () => {
    if (!enabled) return;
    opener.current = launcher.current;
    if (!selection.current && !environmentId) add(); else setOpen(true);
  };
  const visibleEntries = store.entries.filter(entry => !store.archivedIds.includes(entry.id));
  const archivedEntries = store.entries.filter(entry => store.archivedIds.includes(entry.id));
  const rows = [...visibleEntries.map(entry => {
    const environment = entry.installation?.environmentId ?? entry.inspection?.environment?.environmentId;
    const saved = environment ? registry.environments[environment] : undefined;
    return { id: entry.id, label: entry.label, host: entry.target.host, progress: entry.installation,
      status: setupEntryStatus(entry, store.busy[entry.id] || '', store.statusErrors[entry.id] || '', !!saved && (!entry.endpoint || saved.routes.includes(entry.endpoint))) };
  }), ...drafts.filter(isDraftEdited).map(draft => ({ id: draft.id, label: draft.label || 'New server', host: draft.host || 'Connection details', progress: undefined,
    status: { label: draftState.busy[draft.id] || (draft.scan ? 'Verify host' : 'Not connected'), tone: draftState.busy[draft.id] ? 'running' : draft.scan ? 'warning' : 'muted' } }))];
  const selectedEntry = store.entries.find(entry => entry.id === selected);
  const activeCount = store.entries.filter(entry => !['reset', 'restart_pending'].includes(entry.phase) && !restartHeld(entry, restarts) && entry.installation && !['complete', 'ready', 'failed', 'cancelled', 'interrupted'].includes(entry.installation.state)).length;
  const hasPane = drafts.some(draft => draft.id === selected) || !!selectedEntry || selected === 'direct-url' || selected === 'archived-setups';

  return <section className="settings-section server-setup-launcher" aria-label="Set up server">
    <div><h2>{environmentId ? 'Setup & connection' : 'Set up a server'}</h2><p>{environmentId ? 'Inspect this installation, review its setup history or restore its private connection.' : 'Connect over SSH, verify the server, then review what happens next. Existing installations do not need to be reinstalled.'}</p>
      <p>Each server has independent progress and diagnostics.{activeCount > 0 ? ` ${activeCount} installation${activeCount === 1 ? '' : 's'} in progress.` : ''}</p></div>
    <div><button ref={launcher} className="primary" disabled={!enabled} aria-haspopup="dialog" onClick={openSetup}>Open server setup</button>{!enabled && <p>Setup is available in the installed desktop app, not a browser or recorded preview.</p>}</div>
    {createPortal(<dialog ref={dialog} className="server-setup-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={event => { event.preventDefault(); close(); }} onClose={() => { if (alive.current) close(); }} onKeyDown={event => event.stopPropagation()}>
      <header className="modal-top"><div className="modal-heading"><Server className="icon" aria-hidden="true" /><h2 id={`${id}-title`}>Server setup</h2><span id={`${id}-description`}>One workspace. Separate setups.</span></div><button className="icon-button close-setup" aria-label="Close server setup" title="Close setup; running installations continue" onClick={close}><X className="icon" aria-hidden="true" /></button></header>
      <div className="modal-layout"><aside className="setup-sidebar" aria-label="Setup sessions"><div className="sidebar-label"><span>Your setups</span><span aria-label={`${rows.length} setups`}>{rows.length}</span></div><nav className="server-sessions" aria-label="Select a server">{rows.map(row => <button key={row.id} className="session" data-setup-id={row.id} aria-current={selected === row.id ? 'true' : undefined} onClick={() => select(row.id)}>
        <span className="session-name">{row.label}</span>{selected === row.id && <ChevronRight className="icon selection-mark" aria-hidden="true" />}<span className="session-host">{row.host}</span><span className={`session-status ${row.status.tone}`}><span className="dot" aria-hidden="true" />{row.status.label}{row.progress && <span className="muted"> · {row.progress.completedSteps}/{row.progress.totalSteps}</span>}</span>{row.progress && <progress className="session-progress" value={row.progress.completedSteps} max={row.progress.totalSteps} aria-label={`${row.label} setup progress`} />}
      </button>)}</nav><button className="add-server" onClick={add} aria-label="Add server"><Plus className="icon" aria-hidden="true" /><span>Add server</span></button>
        {children && <button className="url-server" aria-label="Connect with a URL" onClick={() => select('direct-url')} aria-current={selected === 'direct-url' ? 'true' : undefined}><Link className="icon" aria-hidden="true" /><span>Connect with a URL</span></button>}
        <button className="text-button setup-history-link" aria-current={selected === 'archived-setups' ? 'true' : undefined} onClick={() => { select('archived-setups'); void store.reloadHistory(); }}>Archived setups{archivedEntries.length ? ` (${archivedEntries.length})` : ''}</button>
        <div className="sidebar-bottom"><LockKeyhole className="icon" aria-hidden="true" /><p>Each server has its own progress and activity log.</p></div></aside>
        {drafts.map(draft => <DraftPane key={draft.id} draft={draft} active={open && selected === draft.id} busy={draftState.busy[draft.id] || ''} error={draftState.errors[draft.id] || ''} committing={!!draftState.committing[draft.id]} uncertainTrust={!!draftState.uncertainTrust[draft.id]} onTrusted={trusted} reconcileTrust={reconcileTrust} onDiscard={discard} onClose={close} />)}
        {store.entries.map(entry => <ServerInstall key={entry.id} entry={entry} inspectOnMount={inspectRequests.includes(entry.id)} registry={registry} busy={store.busy[entry.id] || ''} error={store.errors[entry.id] || ''} statusError={store.statusErrors[entry.id] || ''} lastChecked={store.lastChecked[entry.id]} active={open && selected === entry.id} operate={store.operate} replace={store.replace} invalidatePlan={store.invalidatePlan} checkStatus={store.checkStatus} refresh={refresh} mutate={mutate} onClose={close} onAdd={add} onEditConnection={() => editConnection(entry)} onOpenOriginal={openOriginal} onOpenFresh={openFresh} />)}
        {children && <ServerSetupPane label="Connect with a URL" status={{ label: 'Existing installation', tone: 'muted' }} step={0} steps={['Connect', 'Verify', 'Save']} active={selected === 'direct-url'} note="No installation or upgrade is performed." logs={[]} footer={<button className="text-button" onClick={close}>Close</button>}><div className="direct-connection">{children}</div></ServerSetupPane>}
        <ServerSetupPane label="Archived setups" status={{ label: store.historyLoading ? 'Loading history' : `${archivedEntries.length} archived`, tone: 'muted' }} step={0} steps={['History']} active={selected === 'archived-setups'} note="Archiving never removes saved connections or host trust." logs={[]} footer={<button className="text-button" onClick={close}>Close</button>}>
          <div className="stage-intro"><h2 className="stage-title">Archived setups</h2><p>Restore a setup to review its receipts and diagnostics. No installation is restarted.</p></div>
          {!archivedEntries.length && <p>{store.historyLoading ? 'Reading archived setups…' : store.historyError ? 'Archived setups could not be loaded. Retry history below.' : 'No archived setups.'}</p>}
          <ul className="setup-archived-list">{archivedEntries.map(entry => <li key={entry.id}><div><strong>{entry.label}</strong><p>{entry.target.user}@{entry.target.host}:{entry.target.port}</p></div>
            <button className="text-button" onClick={() => openOriginal(entry.id)}>Open history</button><button disabled={!!store.historyBusy || !!store.busy[entry.id] || !!store.checkingStatus[entry.id] || !!store.historyError} aria-label={`Restore ${entry.label}`} onClick={() => void store.restore(entry.id).then(restored => {
              if (restored && alive.current && selection.current === 'archived-setups') { select(entry.id); focusSelection(); }
            })}>Restore</button>{store.historyErrors[entry.id] && <p className="negative" role={selected === 'archived-setups' ? 'alert' : undefined}>{store.historyErrors[entry.id]}</p>}</li>)}</ul>
        </ServerSetupPane>
        {!hasPane && <ServerSetupPane label={environmentId ? registry.environments[environmentId]?.label || 'Saved server' : 'Your server setups'} status={{ label: store.loading ? 'Loading journal' : 'No setup selected', tone: 'muted' }} step={0} active note="Saved environment connections are unchanged." logs={[]} footer={<button className="primary" disabled={!enabled} onClick={add}>Add server<Plus className="icon" aria-hidden="true" /></button>}><div className="stage-intro"><h2 className="stage-title">{store.loading ? 'Reading your setup history.' : environmentId ? 'No SSH setup history on this Mac.' : 'Add your first server.'}</h2><p>{environmentId ? 'This installation’s verified routes are available in General. You can add its SSH details to inspect it without reinstalling.' : 'Add a server to begin, or select a previous setup from the list.'}</p></div></ServerSetupPane>}
      </div>
      {selectedEntry && !store.archivedIds.includes(selectedEntry.id) && <HistoryActions key={selectedEntry.id} entry={selectedEntry} store={store} active={open} onArchived={selectSurvivor} />}
      {store.journalError && <div className="journal-error" role={open ? 'alert' : undefined}><span>{store.journalError}</span><button onClick={() => void store.reload()}>Retry journal</button></div>}
      {store.historyError && <div className="journal-error setup-history-error" role={open ? 'status' : undefined}><span>{store.historyError}</span><button disabled={store.historyLoading} onClick={() => void store.reloadHistory()}>Retry history</button></div>}
    </dialog>, document.body)}
  </section>;
}
