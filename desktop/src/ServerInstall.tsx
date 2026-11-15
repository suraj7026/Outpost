import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronRight, KeyRound, LockKeyhole, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { call } from './api';
import type { Metadata, MutateRegistry } from './Environments';
import { canVisitSetupStage, mergeSetupEntry, sameSetupHost, setupWasExecuted, type Entry, type Inspection, type InstallPlan, type InstallProgress } from './server-setup-state';
import ServerSetupPane, { setupEntryStatus } from './ServerSetupPane';
import SetupTroubleshooting from './SetupTroubleshooting';
import { diagnosticEntryKey, stoppedInstallSummary } from './setup-diagnostics';
import SetupRestart from './SetupRestart';
import { restartHeld, setupRestarts, useSetupRestarts } from './server-restart';

export type { InstallPlan, InstallProgress } from './server-setup-state';

export interface ServerInstallProps {
  entry: Entry;
  registry: Metadata;
  busy: string;
  error: string;
  statusError: string;
  lastChecked?: number;
  active: boolean;
  inspectOnMount?: boolean;
  operate: (id: string, label: string, work: () => Promise<void>) => Promise<boolean>;
  replace: (entry: Entry) => void;
  invalidatePlan: (id: string) => boolean;
  checkStatus: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  mutate: MutateRegistry;
  onClose: () => void;
  onAdd: () => void;
  onEditConnection: () => void;
  onOpenOriginal: (id: string) => void;
  onOpenFresh: (entry: Entry) => void;
}

const stages = ['Preflight', 'Service accounts', 'Private Node runtime', 'Server dependencies', 'Browser runtime', 'Protected configuration', 'Device enrollment', 'Persistent services', 'Health verification', 'Server ready', 'Private connection', 'Authenticated registration'];
const descriptions = [
  'Checking the operating system, storage and installation paths.',
  'Creating dedicated service accounts for Outpost.',
  'Installing a private Node runtime. System Node stays unchanged.',
  'Installing the locked dependencies for this release.',
  'Downloading and preparing the browser runtime. This step can take a little longer.',
  'Writing protected configuration and private listener settings.',
  'Enrolling this Mac into the new environment.',
  'Starting the coordinator and worker as persistent services.',
  'Checking that the new services respond correctly.',
  'Saving the installation receipt on this server.',
  'The server is installed. Connect this Mac and verify its enrollment to finish.',
  'Verifying this Mac’s authenticated access.',
];
const groups = [
  { title: 'Prepare the server', from: 0, to: 2 },
  { title: 'Install the runtime', from: 2, to: 5 },
  { title: 'Start Outpost', from: 5, to: 10 },
  { title: 'Connect this Mac', from: 10, to: 12 },
];
const stoppedStates = new Set(['failed', 'cancelled', 'interrupted']);
const terminalStates = new Set(['ready', 'complete', ...stoppedStates]);
const recommendations: Record<string, { title: string; message: string }> = {
  migration_review: { title: 'Migration review required', message: 'Kubernetes, containers or legacy Outpost data were detected. Connect an existing installation, or review a separate installation alongside it. Existing data is not overwritten or migrated, and Kubernetes is not removed.' },
  connect_existing: { title: 'Existing installation detected', message: 'Your server’s data and services stay as they are. A reported release is not proof of upgrade compatibility; maintenance checks remain separate.' },
  ambiguous_installation: { title: 'Existing data or service needs review', message: 'An installation path or occupied API port was found, but its ownership or API compatibility is unclear. A fresh installation must not overwrite it.' },
  unsupported_host: { title: 'This host is not supported for installation', message: 'Native installation requires Ubuntu 24.04 or later, x86_64, systemd and Python 3.12+ on the host, not inside a container. SSH access alone does not qualify another platform.' },
  insufficient_capacity: { title: 'Capacity review required', message: 'Installation needs 10 GiB free in /var/lib, 5 GiB in /opt and at least 2 GiB usable RAM. Browser tools require 3 GiB usable RAM, normally a 4 GiB host.' },
  fresh_install_candidate: { title: 'Ready to review a plan', message: 'No known installation or API listener was found. This is a read-only preflight result, not an installation. The native installer checks the host again when preparing a plan.' },
};
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const date = (timestamp: number) => new Date(timestamp).toLocaleString();

function installationBlocker(found: Inspection | null, recommendation: string | null, browser: boolean): string | undefined {
  if (!found) return 'Inspect this server before requesting an installation plan.';
  if (found.nativePresent) return 'Native installation files already exist. Connect that installation or inspect its original setup receipt. A new install will not overwrite them.';
  if (recommendation === 'ambiguous_installation') return recommendations.ambiguous_installation.message;
  if (recommendation === 'unsupported_host' || found.os !== 'ubuntu' || found.architecture !== 'x86_64'
    || !found.systemd || found.container || !(Number(found.osVersion.split('.')[0]) >= 24))
    return recommendations.unsupported_host.message;
  if (recommendation === 'insufficient_capacity' || found.freeBytes < 10 * 1024 ** 3 || found.memoryBytes < (browser ? 3 : 2) * 1024 ** 3)
    return recommendations.insufficient_capacity.message;
  return undefined;
}

function Notice({ title, children, tone = 'warning' }: { title: string; children: ReactNode; tone?: 'positive' | 'warning' | 'negative' | 'running' }) {
  const Icon = tone === 'positive' ? Check : tone === 'running' ? RefreshCw : TriangleAlert;
  return <div className={`notice ${tone}`}><Icon className="icon" aria-hidden="true" /><div><strong>{title}</strong><p>{children}</p></div></div>;
}

function PlanDetails({ plan, browser, fullControl }: { plan?: InstallPlan | null; browser: boolean; fullControl: boolean }) {
  return <dl className="change-list">
    <div><dt>Private runtime and services</dt><dd>{plan ? `Release ${plan.releaseId}, with private Node ${plan.nodeVersion}.` : 'The bundled release has its own private Node runtime.'} System Node stays unchanged. A non-root coordinator and Pi worker start on boot and keep running when this Mac closes.{fullControl && ' An authenticated root executor provides full server control.'}</dd></div>
    <div><dt>Dedicated files</dt><dd><code>/opt/outpost-native</code><br /><code>/etc/outpost-native</code><br /><code>/var/lib/outpost-native</code></dd></div>
    <div><dt>Private connection</dt><dd>Loopback listeners on 127.0.0.1:4518{fullControl ? ', :4519' : ''} and :4520. No public ports or firewall changes.</dd></div>
    <div><dt>Required capacity</dt><dd>10 GiB free in /var/lib and 5 GiB in /opt; {browser ? '3 GiB usable RAM with browser tools (normally a 4 GiB host)' : '2 GiB usable RAM'}. The installer checks both filesystem paths before writing.</dd></div>
    <div><dt>Browser tools</dt><dd>{browser ? 'Install local Camoufox and pinned browser/Python tooling. Shared Ubuntu browser libraries may be installed or updated; use a maintenance window if other applications run here.' : 'Not installed. The browser runtime check will be skipped.'}</dd></div>
    <div><dt>Server access</dt><dd>{fullControl ? 'Ongoing full root access: Outpost can read secrets, change or delete host data, manage Docker and control system services. Task approval settings still apply.' : 'Restricted workspace only. No root executor, ongoing root authority, Docker administration or access to protected host files.'} No sudoers rules are installed.</dd></div>
    <div><dt>Device enrollment</dt><dd>Enroll this Mac into a new, empty environment. Existing device lists are untouched; this is not a migration or an upgrade.</dd></div>
    {plan && <div><dt>Technical details</dt><dd><details><summary>Release, signing identity &amp; operation</summary><dl className="change-list">
      <div><dt>Release SHA-256</dt><dd><code>{plan.sha256}</code><br />{plan.size.toLocaleString()} bytes; the native installer verifies the bundled archive before upload.</dd></div>
      <div><dt>This Mac’s signing identity</dt><dd>Device <code>{plan.deviceId}</code><br />Ed25519 public key <code>{plan.publicKey}</code><br />The plan is bound to this identity; a change blocks authorization.</dd></div>
      <div><dt>New environment</dt><dd><code>{plan.environmentId}</code></dd></div>
      <div><dt>Reviewed operation</dt><dd><code>{plan.operationId}</code><br />Plan <code>{plan.planId}</code></dd></div>
      <div><dt>Plan expires</dt><dd>{date(plan.expiresAt)}. Refreshing the plan requires fresh approval.</dd></div>
    </dl></details></dd></div>}
  </dl>;
}

function InstallationPhase({ group, index, progress, browser, stale }: {
  group: typeof groups[number]; index: number; progress: InstallProgress; browser?: boolean; stale: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const done = progress.completedSteps >= group.to;
  const current = progress.completedSteps >= group.from && progress.completedSteps < group.to;
  const stopped = stoppedStates.has(progress.state);
  const uncertain = stale || ['unknown', 'authorizing'].includes(progress.state);
  const tone = done ? 'positive' : !current ? '' : stopped ? progress.state === 'cancelled' ? 'muted' : 'negative' : uncertain ? 'warning' : 'running';
  const count = Math.max(0, Math.min(group.to - group.from, progress.completedSteps - group.from));
  const label = done ? 'Complete' : !current ? 'Not started' : stopped ? progress.state === 'cancelled' ? 'Stopped' : 'Needs attention'
    : uncertain ? 'Last known progress' : progress.state === 'queued' ? 'Queued' : 'In progress';
  return <details className={`phase${current ? ' current' : ''}`} open={expanded ?? current} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span className={`phase-number ${tone}`}>{done ? <Check className="icon" aria-hidden="true" /> : index + 1}</span>
      <span className="phase-label"><strong>{group.title}</strong><small>{label}{current ? ` · ${count} of ${group.to - group.from} checks` : ''}</small></span><ChevronRight className="icon" aria-hidden="true" />
    </summary>
    <ul className="task-list">{stages.slice(group.from, group.to).map((name, offset) => {
      const position = group.from + offset, finished = position < progress.completedSteps, isCurrent = position === progress.completedSteps;
      const skipped = position === 4 && browser === false;
      const state = skipped ? finished ? 'Skipped' : 'Will skip' : finished ? 'Done' : !isCurrent ? 'Waiting'
        : stopped ? progress.state === 'cancelled' ? 'Stopped' : 'Failed' : uncertain ? 'Unconfirmed' : progress.state === 'queued' ? 'Queued' : 'Running';
      return <li key={name}>{finished ? <Check className="icon positive" aria-hidden="true" /> : <span className={`task-bullet ${isCurrent ? tone : ''}`} aria-hidden="true" />}
        <span className={`task-name ${isCurrent ? tone : finished ? '' : 'muted'}`}>{name}</span><span className="task-state">{state}</span></li>;
    })}</ul>
  </details>;
}

export default function ServerInstall({
  entry, registry, busy, error, statusError, lastChecked, active, inspectOnMount = false, operate, replace, invalidatePlan, checkStatus, refresh, mutate, onClose, onAdd, onEditConnection, onOpenOriginal, onOpenFresh,
}: ServerInstallProps) {
  const id = useId();
  const { plan, installation: progress, inspection: found } = entry;
  const restarts = useSetupRestarts(), restart = restarts[entry.id];
  const held = restartHeld(entry, restarts) || entry.phase === 'restart_pending', removed = entry.phase === 'reset';
  const restartTrigger = useRef<HTMLButtonElement>(null), restoreRestartFocus = useRef(false);
  const closeRestart = () => { restoreRestartFocus.current = true; setupRestarts.close(entry.id); };
  useLayoutEffect(() => {
    if (!restart?.open && restoreRestartFocus.current) {
      restoreRestartFocus.current = false;
      if (active) restartTrigger.current?.focus();
    }
  }, [restart?.open, active]);
  const executed = setupWasExecuted(entry);
  const [viewedStep, setViewedStep] = useState<number | null>(null);
  const [browser, setBrowser] = useState(plan?.browser ?? true);
  const [fullControl, setFullControl] = useState(plan?.fullControl ?? false);
  const [approvedPlan, setApprovedPlan] = useState('');
  const [coexistencePlan, setCoexistencePlan] = useState('');
  const [retryPlan, setRetryPlan] = useState('');
  const [password, setPassword] = useState(true);
  const [existingApproved, setExistingApproved] = useState(false);
  const [retireLegacy, setRetireLegacy] = useState(false);
  const [preferInstall, setPreferInstall] = useState(!!plan);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState('');
  const [paneVisible, setPaneVisible] = useState(false);
  const [troubleshootingKey, setTroubleshootingKey] = useState('');
  const troubleshootButton = useRef<HTMLButtonElement>(null), restoreTroubleshootFocus = useRef(false);
  const diagnosticKey = diagnosticEntryKey(entry);
  const troubleshooting = active && paneVisible && troubleshootingKey === diagnosticKey;
  useEffect(() => { if (!active || !paneVisible) setTroubleshootingKey(''); }, [active, paneVisible]);
  const openTroubleshooting = () => setTroubleshootingKey(diagnosticKey);
  const closeTroubleshooting = () => { restoreTroubleshootFocus.current = true; setTroubleshootingKey(''); };
  useLayoutEffect(() => {
    if (!troubleshooting && restoreTroubleshootFocus.current) {
      restoreTroubleshootFocus.current = false;
      if (active && paneVisible) troubleshootButton.current?.focus();
    }
  }, [troubleshooting, active, paneVisible]);
  const autoInspected = useRef(false);
  const alive = useRef(true), disconnectPending = useRef(false), commandGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setApprovedPlan(''); setCoexistencePlan(''); setRetryPlan('');
    if (plan) { setBrowser(plan.browser); setFullControl(plan.fullControl); }
  }, [plan?.planId]);
  useEffect(() => { setExistingApproved(false); setRetireLegacy(false); }, [found?.environment?.environmentId]);

  const environment = found?.environment;
  const environmentId = progress?.environmentId ?? environment?.environmentId;
  const registered = environmentId ? registry.environments[environmentId] : undefined;
  const saved = !!registered && (!entry.endpoint || registered.routes.includes(entry.endpoint));
  const existing = !!environment && !progress && !preferInstall;
  const linked = existing && saved;
  const complete = progress?.state === 'complete' || linked;
  const finish = progress?.state === 'ready' || complete;
  const terminal = !!progress && terminalStates.has(progress.state);
  const stopped = !!progress && stoppedStates.has(progress.state);
  const uncertain = !!progress && ['unknown', 'authorizing'].includes(progress.state);
  const canRetry = uncertain && progress.completedSteps === 0 && !!plan;
  const blocked = installationBlocker(found, entry.recommendation, browser);
  const optionsChanged = !!plan && (plan.browser !== browser || plan.fullControl !== fullControl);
  const expired = !!plan && Date.now() >= plan.expiresAt;
  const approved = !!plan && approvedPlan === plan.planId;
  const coexistence = !!plan && coexistencePlan === plan.planId;
  const retryApproved = !!plan && retryPlan === plan.planId;
  const disabled = !!busy || disconnecting || held || removed || !!restart?.busy;
  const inspecting = !progress && (entry.phase === 'inspecting' || /inspect|plan/i.test(busy) || !found && !!busy);
  const linking = !progress && (entry.phase === 'connecting' || /connecting existing|verifying enrolled/i.test(busy));
  const furthest = finish ? 4 : progress || linking ? 3 : !found ? 1 : 2;
  const step = viewedStep !== null && canVisitSetupStage(viewedStep, furthest) ? viewedStep : furthest;
  useEffect(() => { setViewedStep(null); }, [furthest]);
  const clearApproval = () => { setApprovedPlan(''); setCoexistencePlan(''); setRetryPlan(''); setExistingApproved(false); };
  const openRestart = () => { clearApproval(); setTroubleshootingKey(''); void setupRestarts.open(entry); };
  const wasVisible = useRef(false);
  useEffect(() => {
    if (active && !wasVisible.current && (restart?.open || restart?.pending || entry.phase === 'restart_pending')) void setupRestarts.open(entry);
    wasVisible.current = active;
    if (!active) clearApproval();
  }, [active, entry.id, entry.phase]);
  const navigateStep = (index: number) => {
    if (!canVisitSetupStage(index, furthest) || restart?.busy) return;
    clearApproval(); setTroubleshootingKey(''); setViewedStep(index);
  };
  const editConnection = () => {
    if (executed || found?.nativePresent || found?.environment) openRestart();
    else { clearApproval(); onEditConnection(); }
  };
  const recommendation = entry.recommendation ? recommendations[entry.recommendation] : undefined;
  const errors = [...new Set([error, localError, entry.error, progress?.error].filter(Boolean))].join('\n');
  const logs = [...entry.log.map(line => `[Setup] ${line}`), ...(progress?.log.map(line => `[Installation] ${line}`) ?? [])];

  const run = (label: string, work: () => Promise<void>) => {
    if (held || removed || restart?.pending || restart?.busy) return Promise.resolve(false);
    setLocalError('');
    return operate(entry.id, label, work);
  };
  const request = async (command: string, args: Record<string, unknown> = {}) => {
    const generation = commandGeneration.current;
    const response = await call<Entry>(command, { ...args, id: entry.id });
    const merged = mergeSetupEntry(entry, response, entry.id);
    if (generation !== commandGeneration.current) throw new Error('This SSH action was cancelled. Inspect the current target before continuing.');
    replace(merged);
    return merged;
  };
  const inspect = () => {
    if (executed || held || removed || disabled) return;
    clearApproval(); invalidatePlan(entry.id); setViewedStep(null);
    void run('Inspecting server', async () => { await request('setup_inspect'); });
  };
  useEffect(() => {
    if (inspectOnMount && !autoInspected.current && !executed && !held && !removed && !disabled) { autoInspected.current = true; inspect(); }
  }, [inspectOnMount, entry.id, held, removed, disabled]);
  const reviewPlan = () => void run(plan ? 'Refreshing installation plan' : 'Preparing installation plan', async () => {
    if (progress || blocked) throw new Error(blocked ?? 'An installation receipt already exists. Check its status instead.');
    setApprovedPlan(''); setCoexistencePlan(''); setRetryPlan('');
    await request('setup_plan', { browser, fullControl });
  });
  const authorize = (retry: boolean) => void run(retry ? 'Retrying same authorization' : 'Authorizing server installation', async () => {
    if (!plan || !(retry ? canRetry && retryApproved : !progress && approved && !optionsChanged && !blocked)
      || plan.coexistenceRequired && !coexistence) throw new Error('Review and approve this installation plan before authorizing.');
    if (!retry && Date.now() >= plan.expiresAt) {
      setApprovedPlan(''); setCoexistencePlan('');
      throw new Error('This installation plan has expired. Refresh the plan and approve it again.');
    }
    setApprovedPlan(''); setRetryPlan(''); setCoexistencePlan('');
    await request('setup_install', { planId: plan.planId, approved: true, coexistence, password: found?.uid === 0 ? false : password });
  });
  const readStatus = async () => {
    if (checking || disabled) return;
    setChecking(true); setLocalError('');
    try { await checkStatus(entry.id); }
    catch (failure) { if (alive.current) setLocalError(String(failure)); }
    finally { if (alive.current) setChecking(false); }
  };
  const disconnect = async () => {
    if (disconnectPending.current || held || removed || restart?.busy) return;
    disconnectPending.current = true;
    commandGeneration.current++;
    setDisconnecting(true); setLocalError('');
    // Inspection holds the target's operate lock. Cancellation must bypass that lock.
    try {
      const response = await call<Entry>('setup_disconnect', { id: entry.id });
      replace(mergeSetupEntry(entry, response, entry.id));
    } catch (failure) { if (alive.current) setLocalError(String(failure)); }
    finally { disconnectPending.current = false; if (alive.current) setDisconnecting(false); }
  };
  const connectExisting = () => void run('Connecting existing installation', async () => {
    if (!environment || !existingApproved && !linked) throw new Error('Approve connecting to this existing installation first.');
    const connected = entry.endpoint ? entry : await request('setup_tunnel');
    if (!connected.endpoint || connected.inspection?.environment?.environmentId !== environment.environmentId)
      throw new Error('The private route does not match the reviewed environment. Nothing was registered.');
    await mutate('environment_register', { environmentId: environment.environmentId, endpoint: connected.endpoint, label: entry.label,
      ...(retireLegacy ? { retireLegacyMutations: true } : {}) });
    await refresh();
  });
  const finishSetup = () => {
    void run(progress?.state === 'complete' ? 'Reconnecting saved environment' : 'Verifying and saving environment', async () => {
      await request('setup_finish');
      await refresh();
    }).then(success => {
      // Status reads are locked during operate; clear stale receipt errors after it releases.
      if (success) return checkStatus(entry.id);
    }).catch(failure => { if (alive.current) setLocalError(String(failure)); });
  };
  const stopInstallation = () => void run('Requesting safe cancellation', async () => {
    await request('setup_install_cancel');
    if (alive.current) { setCancelConfirm(false); setCancelRequested(true); }
  });
  const openEnvironment = () => void run('Opening environment', async () => {
    if (!environmentId || !saved || !entry.endpoint) throw new Error('Reconnect and verify this environment before opening it.');
    await mutate('environment_select', { environmentId });
    window.location.hash = '';
    onClose();
  });

  const nativeAuthorization = (retry = false) => <>
    {plan?.coexistenceRequired && <label className="check-row" htmlFor={`${id}-${retry ? 'retry-' : ''}coexistence`}>
      <input id={`${id}-${retry ? 'retry-' : ''}coexistence`} type="checkbox" checked={coexistence} disabled={disabled || !retry && (expired || optionsChanged || !!blocked)} onChange={event => setCoexistencePlan(event.target.checked ? plan.planId : '')} />
      <span>Create a separate environment alongside existing services.<small>Do not migrate data, replace services or remove Kubernetes. This consent is separate from installation approval.</small></span>
    </label>}
    {found?.uid === 0 ? <p className="quiet-note">The SSH account is root; no sudo password is needed. The coordinator and Pi worker remain non-root.</p> : <label className="check-row" htmlFor={`${id}-${retry ? 'retry-' : ''}sudo`}>
      <input id={`${id}-${retry ? 'retry-' : ''}sudo`} type="checkbox" checked={password} disabled={disabled} onChange={event => setPassword(event.target.checked)} />
      <span>Ask for the remote sudo password in a protected native dialog.<small>Uncheck only if this SSH account already has appropriate passwordless sudo. Passwords are never collected or saved by this page.</small></span>
    </label>}
  </>;

  let content: ReactNode;
  let footer: ReactNode;
  let note: string;

  if (finish && step === 4) {
    const connected = !!entry.endpoint && !statusError;
    const readyToUse = complete && saved && connected;
    content = <>
      <div className="success-mark"><Check className="icon" aria-hidden="true" /></div>
      <div className="stage-intro"><h2 className="stage-title">{readyToUse ? `${entry.label} is ready.` : complete ? saved ? 'Saved. Reconnect when you’re ready.' : 'Verify the saved connection.' : 'Installed. One last connection.'}</h2>
        <p>{readyToUse ? 'This Mac is authenticated and the server is saved in your workspace.' : complete ? 'The installation is kept. Verify the private connection without running installation again.' : 'Outpost is running on the server. Connect this Mac to verify access and finish setup.'}</p>
      </div>
      <div className="review-grid"><div className="summary-rows">
        <div className="summary-row"><span>Server installation</span><strong className="positive">{existing ? 'Existing installation kept' : 'Complete'}</strong></div>
        <div className="summary-row"><span>Private SSH route</span><strong className={connected ? 'positive' : 'warning'}>{statusError ? 'Status unavailable' : entry.endpoint ? 'Connected' : complete ? 'Disconnected' : 'Not connected yet'}</strong></div>
        <div className="summary-row"><span>This Mac’s enrollment</span><strong className={complete ? 'positive' : 'muted'}>{complete ? connected ? 'Verified' : 'Previously verified' : 'Waiting for verification'}</strong></div>
        <div className="summary-row"><span>Saved in Outpost</span><strong className={saved ? 'positive' : 'muted'}>{saved ? 'Yes' : complete ? 'Registry needs verification' : 'Not yet'}</strong></div>
        {progress && <div className="summary-row"><span>Completed checks</span><strong>{progress.completedSteps} of {progress.totalSteps}</strong></div>}
        <div className="summary-row"><span>Environment</span><strong><code>{environmentId}</code></strong></div>
        <div className="button-row">{entry.endpoint && <button className="text-button" type="button" disabled={disabled} onClick={() => void disconnect()}>Disconnect SSH</button>}
          {progress && statusError && <button className="text-button" type="button" disabled={disabled || checking} onClick={() => void readStatus()}>{checking ? 'Checking progress…' : 'Check progress'}</button>}
        </div>
      </div><aside className="live-detail"><h3>{readyToUse ? 'Next: choose a model.' : 'No second installation.'}</h3>
        <p>{readyToUse ? 'Configure a model provider before starting an agent task. You can do that later in Models & providers.' : 'We’ll reuse this installation, verify its identity and save the authenticated connection. Existing data stays in place.'}</p>
        <p className="quiet-note">{!complete && progress ? '10 of 12 checks complete. The final two verify the private connection and registration.' : 'Connecting and finishing setup do not switch your active environment.'}</p>
        {complete && saved && environmentId && <section aria-label="Optional provider import"><h4>Bring your providers to this server</h4>
          <p>Optionally copy API keys from another Outpost server. Existing keys are kept by default; subscription accounts need a fresh sign-in.</p>
          <div className="button-row"><a className="small-link" href={`#settings/servers/${encodeURIComponent(environmentId)}/models`} onClick={onClose}>Import from server</a><a className="small-link" href={`#settings/servers/${encodeURIComponent(environmentId)}`} onClick={onClose}>Skip for now</a></div>
        </section>}
      </aside></div>
    </>;
    note = readyToUse ? 'Setup complete. Connection verified.' : complete ? 'The existing installation will be reused.' : 'The server is installed; finish verification to save it.';
    footer = <>
      <button className="text-button" type="button" onClick={onClose}>{readyToUse ? 'Done' : 'Finish later'}</button>
      {complete && <button className="text-button" type="button" onClick={onAdd}>Add another server</button>}
      {readyToUse ? <button className="primary" type="button" disabled={disabled} onClick={openEnvironment}>Open environment<ArrowRight className="icon" aria-hidden="true" /></button>
        : <button className="primary" type="button" disabled={disabled} onClick={existing ? connectExisting : finishSetup}>{complete ? 'Reconnect environment' : 'Connect & finish setup'}<ArrowRight className="icon" aria-hidden="true" /></button>}
    </>;
  } else if (progress && finish) {
    content = <><div className="stage-intro"><h2 className="stage-title">Review installation checks.</h2><p>The server installation is complete. These are its saved checks, not a new installation request.</p></div>
      <div className="phase-list">{groups.map((group, index) => <InstallationPhase key={group.title} group={group} index={index} progress={progress} browser={plan?.browser} stale={!!statusError} />)}</div></>;
    note = 'Reviewing completed checks does not repeat installation.';
    footer = <><button className="text-button" onClick={openRestart}>Edit for a new installation</button><button className="primary" onClick={() => setViewedStep(null)}>Back to finish</button></>;
  } else if (progress) {
    const stale = !!statusError || uncertain;
    const currentTitle = stopped ? progress.stage || 'Installation stopped' : uncertain ? 'Authorization is not confirmed' : progress.state === 'queued' ? 'Waiting for the setup service' : progress.stage || stages[progress.completedSteps];
    content = <>
      <div className="stage-intro stage-intro-row"><div><h2 className="stage-title">{stopped ? progress.state === 'cancelled' ? 'Installation stopped.' : 'This setup needs attention.' : stale ? 'Waiting for confirmed progress.' : 'Installing Outpost.'}</h2>
        <p>{stopped ? 'Partial files are kept. Nothing is automatically removed or retried.' : stale ? 'The server may still be installing. These are its last confirmed checks.' : `Everything below belongs to ${entry.label}. Your other setups stay independent.`}</p>
      </div><div className="stage-count"><strong>{progress.completedSteps}<span className="muted"> / {progress.totalSteps}</span></strong><small>checks complete</small></div></div>
      {uncertain && <Notice title="Check status before retrying authorization">Authorization or launch was not confirmed. Read the remote receipt first.{canRetry ? ' An explicit retry below uses this same operation and reviewed plan, never a new installation.' : ' Partial progress exists; review the receipt with the server administrator. Do not launch another installation.'}</Notice>}
      {cancelRequested && !terminal && <Notice title="Safe cancellation requested">The server may finish its current check before stopping. Check progress to confirm; closing this window is not cancellation.</Notice>}
      {cancelConfirm && !terminal && <div className="inline-confirmation" role="group" aria-labelledby={`${id}-stop-title`}>
        <strong id={`${id}-stop-title`}>Stop installation on {entry.label}?</strong><p>Completed files remain for review. Other servers are unaffected. This requests a safe stop, not an uninstall.</p>
        <div className="button-row"><button type="button" disabled={disabled} onClick={() => setCancelConfirm(false)}>Keep installing</button><button className="danger" type="button" disabled={disabled} onClick={stopInstallation}>Stop this installation</button></div>
      </div>}
      <div className="install-grid"><div className="phase-list">{groups.map((group, index) => <InstallationPhase key={`${progress.operationId}:${group.title}`} group={group} index={index} progress={progress} browser={plan?.browser} stale={stale} />)}</div>
        <aside className="progress-column"><div className="live-detail">
          <span className={`badge ${stopped ? 'negative' : stale ? 'warning' : 'running'}`}><span className="dot" aria-hidden="true" />{stopped ? 'Action needed' : stale ? 'Last confirmed activity' : 'Working on this now'}</span>
          <h3>{currentTitle}</h3><p>{stopped ? stoppedInstallSummary(entry) : uncertain ? 'A native authorization prompt or launch may not have completed. The operation identity is retained.' : descriptions[progress.completedSteps]}</p>
          <div className="progress-heading"><span>Completed checks</span><span>{progress.completedSteps} of {progress.totalSteps}</span></div>
          <progress value={progress.completedSteps} max={progress.totalSteps} aria-label={`${entry.label} completed checks`} />
          <dl className="status-facts"><dt>Private app route</dt><dd>{statusError ? 'Status unavailable' : entry.endpoint ? 'Available' : 'Not opened yet'}</dd>
            <dt>Receipt updated</dt><dd>{date(progress.updatedAt)}</dd><dt>Last status check</dt><dd>{lastChecked ? date(lastChecked) : 'Not checked yet'}</dd>
            <dt>Installation</dt><dd>{stopped ? 'Stopped on server' : uncertain ? 'Unconfirmed' : progress.state === 'queued' ? 'Queued on server' : statusError ? 'Last known: running' : 'Running on server'}</dd>
          </dl><p className="quiet-note">Progress counts completed checks, not time remaining. Host receipt timestamps may differ from this Mac’s clock.</p>
        </div><p className="quiet-note"><LockKeyhole className="icon" aria-hidden="true" /><span>{stopped ? 'Partial installation files are retained for review.' : 'You can close this window. Launched installation continues on the server.'}</span></p></aside>
      </div>
      {stopped && <Notice title="Read evidence before deciding what’s next" tone={progress.state === 'cancelled' ? 'warning' : 'negative'}>Troubleshoot this operation without changing installation files or configuration. The saved receipt is under <code>/var/lib/outpost-setup/operations/{progress.operationId}</code>. Partial files remain; correcting a prerequisite does not resume a stopped installation.</Notice>}
      {canRetry && plan && <div className="approval"><h3>Retry this operation only</h3>
        <details><summary>Original approved installation plan</summary><PlanDetails plan={plan} browser={plan.browser} fullControl={plan.fullControl} /></details>
        {nativeAuthorization(true)}
        <label className="check-row" htmlFor={`${id}-retry-approval`}><input id={`${id}-retry-approval`} type="checkbox" checked={retryApproved} disabled={disabled} onChange={event => setRetryPlan(event.target.checked ? plan.planId : '')} />
          <span>I approve retrying authorization for this same installation operation.{plan.fullControl ? ' I grant ongoing full root access to this server, including its secrets, services and data.' : ' No ongoing root access is granted.'}</span>
        </label><p>Retry keeps operation <code>{progress.operationId}</code>. The five-minute expiry blocks a first launch, not explicit recovery of this existing operation.</p>
        <button type="button" disabled={disabled || !retryApproved || plan.coexistenceRequired && !coexistence} onClick={() => authorize(true)}>Retry same authorization</button>
      </div>}
    </>;
    note = stopped ? 'Other server setups are unaffected.' : 'Closing this window won’t stop a launched installation.';
    footer = <>
      {!terminal && <button className="text-button" type="button" disabled={disabled || cancelRequested} onClick={() => setCancelConfirm(true)}>Stop installation…</button>}
      <button className="text-button" type="button" disabled={disabled || checking} onClick={() => void readStatus()}><RefreshCw className="icon" aria-hidden="true" />{checking ? 'Checking progress…' : stale ? 'Reconnect & check' : 'Check progress'}</button>
      <button className={stopped ? 'text-button' : 'primary'} type="button" onClick={onClose}>{stopped ? 'Close' : 'Continue in background'}</button>
      {stopped && <button ref={troubleshootButton} className="primary" type="button" onClick={openTroubleshooting}>Troubleshoot<ArrowRight className="icon" aria-hidden="true" /></button>}
    </>;
  } else if (!found) {
    content = <>
      <div className="stage-intro"><h2 className="stage-title">{inspecting ? 'Checking your server.' : 'Let’s inspect this server.'}</h2><p>The host fingerprint is pinned. Read-only inspection checks the platform, available space and existing installations before any changes.</p></div>
      <div className="notice"><LockKeyhole className="icon" aria-hidden="true" /><div><strong>No software is installed during inspection.</strong><p>The private key stays on this Mac. Unlock encrypted keys in your SSH agent first.</p></div></div>
      <ul className="check-list"><li><Check className="icon" aria-hidden="true" />Host fingerprint confirmed</li><li><Server className="icon" aria-hidden="true" />Inspect operating system, capacity and services</li><li><KeyRound className="icon" aria-hidden="true" />Review detected installation and access</li></ul>
    </>;
    note = 'No installation changes have been authorized.';
    footer = <><button className="text-button" type="button" onClick={onClose}>Close</button>
      {inspecting ? <button type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? 'Cancelling…' : 'Cancel inspection'}</button>
        : <button className="primary" type="button" disabled={disabled} onClick={inspect}>Inspect server<ArrowRight className="icon" aria-hidden="true" /></button>}
    </>;
  } else if (existing) {
    content = <>
      <div className="stage-intro"><h2 className="stage-title">{linking ? 'Connecting this Mac.' : 'Outpost is already here.'}</h2><p>Connect to the existing installation. There’s nothing to reinstall.</p></div>
      <Notice title={recommendation?.title ?? 'Existing installation detected'} tone={entry.recommendation === 'migration_review' ? 'warning' : 'positive'}>{recommendation?.message ?? recommendations.connect_existing.message}</Notice>
      <div className="review-grid"><div><h3>What we found</h3><dl className="change-list">
        <div><dt>Server</dt><dd>{entry.target.host}</dd></div><div><dt>Operating system</dt><dd>{found.os} {found.osVersion} · {found.architecture} · {found.systemd ? 'systemd' : 'No systemd detected'}</dd></div>
        <div><dt>Outpost API</dt><dd>{found.api}{found.apiPort ? ` on 127.0.0.1:${found.apiPort}` : ''}</dd></div><div><dt>Environment</dt><dd><code>{environment.environmentId}</code></dd></div>
        <div><dt>Reported release</dt><dd>{environment.release ?? 'Unknown; upgrade compatibility is not established'}</dd></div>
        {entry.endpoint && <div><dt>Private route</dt><dd><code>{entry.endpoint}</code> — enrollment must be verified before saving.</dd></div>}
      </dl></div><aside className="options-panel"><h3>What happens next</h3><ul className="check-list">
        <li><LockKeyhole className="icon" aria-hidden="true" />Open a private SSH route</li><li><KeyRound className="icon" aria-hidden="true" />Verify this Mac’s signed enrollment</li><li><Server className="icon" aria-hidden="true" />Save the server in Outpost</li>
      </ul><p className="quiet-note">If this Mac isn’t enrolled, an already trusted device must approve it. Existing pairing is never reset.</p></aside></div>
      <div className="approval">
        {!registry.legacyMutationsRetired && !registered && <label className="check-row" htmlFor={`${id}-retire`}><input id={`${id}-retire`} type="checkbox" checked={retireLegacy} disabled={disabled} onChange={event => setRetireLegacy(event.target.checked)} />
          <span>If required for adoption, retire legacy mutations.<small>Existing legacy history remains readable. Resolve its pending commands first; this is a separate, explicit adoption choice.</small></span></label>}
        <label className="check-row" htmlFor={`${id}-existing-approval`}><input id={`${id}-existing-approval`} type="checkbox" checked={existingApproved} disabled={disabled} onChange={event => setExistingApproved(event.target.checked)} /><span>Connect to this installation without changing its data.</span></label>
      </div>
      {found.nativePresent && <p className="quiet-note">Native installation files already exist. A new installation will not overwrite them.</p>}
      <div className="button-row"><button className="text-button" type="button" disabled={disabled || !!entry.endpoint} onClick={inspect}>Inspect again</button>
        {!blocked && <button className="text-button" type="button" disabled={disabled || !!entry.endpoint} onClick={() => setPreferInstall(true)}>Review a separate installation</button>}
      </div>
    </>;
    note = 'Connect only. No reinstall, migration or active-environment switch.';
    footer = <><button className="text-button" type="button" onClick={onClose}>Close</button>
      {(inspecting || linking && !entry.endpoint || entry.endpoint && !busy) && <button className="text-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? 'Disconnecting…' : inspecting ? 'Cancel inspection' : linking ? 'Cancel connection' : 'Disconnect SSH'}</button>}
      <button className="primary" type="button" disabled={disabled || !existingApproved} onClick={connectExisting}>{entry.endpoint ? 'Verify enrollment & save' : 'Verify & connect'}<ArrowRight className="icon" aria-hidden="true" /></button>
    </>;
  } else {
    const approvalDisabled = disabled || !plan || expired || optionsChanged || !!blocked;
    content = <>
      <div className="stage-intro"><h2 className="stage-title">{plan ? 'Here’s what will change.' : 'Choose what this server can do.'}</h2><p>{plan ? `Review the native installation plan for ${entry.target.host} before authorizing changes.` : 'Choose capabilities, then request a real installation plan. This preview does not authorize installation.'}</p></div>
      {recommendation && <Notice title={recommendation.title} tone={entry.recommendation === 'fresh_install_candidate' && !blocked ? 'positive' : 'warning'}>{recommendation.message}</Notice>}
      {blocked && <Notice title="Installation blocked">{blocked}</Notice>}
      <div className="inspection-strip"><span><Server className="icon" aria-hidden="true" />{found.os} {found.osVersion} · {found.architecture}</span><span>{gib(found.freeBytes)} free in /var/lib</span><span>{gib(found.memoryBytes)} RAM</span><span>{found.systemd ? 'systemd available' : 'systemd unavailable'}</span></div>
      {plan && expired && <Notice title="This plan has expired">Refresh the plan to recheck the host and approve the current changes. No first installation can be authorized with an expired plan.</Notice>}
      {optionsChanged && <Notice title="Capabilities changed">Refresh the installation plan before approving these options. The plan below still describes the previously reviewed capabilities.</Notice>}
      <div className="review-grid"><div><h3>{plan ? 'Installation plan' : 'Proposed changes'}</h3><PlanDetails plan={plan} browser={plan?.browser ?? browser} fullControl={plan?.fullControl ?? fullControl} /></div>
        <aside className="options-panel"><h3>Choose capabilities</h3>
          <label className="check-row" htmlFor={`${id}-browser`}><input id={`${id}-browser`} type="checkbox" checked={browser} disabled={disabled} onChange={event => { if (invalidatePlan(entry.id)) { setBrowser(event.target.checked); clearApproval(); } }} /><span>Browser tools<small>Install a local Camoufox browser. Shared Ubuntu libraries may be updated.</small></span></label>
          <label className="check-row" htmlFor={`${id}-full-control`}><input id={`${id}-full-control`} type="checkbox" checked={fullControl} disabled={disabled} onChange={event => { if (invalidatePlan(entry.id)) { setFullControl(event.target.checked); clearApproval(); } }} /><span>Full server control<small>{fullControl ? 'Ongoing root access: can read secrets, change or delete host data, and manage Docker and services.' : 'Off by default. Restricted workspace; no root executor.'}</small></span></label>
          <p className="quiet-note">Existing services are not replaced. This is not a migration or an upgrade. Host downloads require Internet access.</p>
          {plan && <p className="quiet-note">A plan is valid for five minutes. The native installer enforces expiry and checks this Mac’s signing identity.</p>}
        </aside>
      </div>
      {plan && <div className="approval">{nativeAuthorization()}
        <label className="check-row" htmlFor={`${id}-install-approval`}><input id={`${id}-install-approval`} type="checkbox" checked={approved} disabled={approvalDisabled} onChange={event => setApprovedPlan(event.target.checked ? plan.planId : '')} /><span>I approve these installation changes on {entry.target.host}.{plan.fullControl ? ' I grant Outpost ongoing full root access to this server, including its secrets, services and data.' : ' No ongoing root access is granted.'}</span></label>
        <p>Authorization uses a protected native dialog when needed. No password is collected here. Refreshing this plan resets both approvals.</p>
      </div>}
      <div className="button-row"><button className="text-button" type="button" disabled={disabled || !!entry.endpoint} onClick={inspect}>Inspect again</button>
        {environment && <button className="text-button" type="button" disabled={disabled} onClick={() => setPreferInstall(false)}>Connect existing installation instead</button>}
      </div>
    </>;
    note = plan ? 'Only this server will be changed, after explicit approval.' : 'Review a native plan before authorizing any server changes.';
    footer = <><button className="text-button" type="button" onClick={onClose}>Close</button>
      {inspecting && <button className="text-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? 'Cancelling…' : 'Cancel inspection'}</button>}
      <button className={plan ? 'text-button' : 'primary'} type="button" disabled={disabled || !!blocked || !!entry.endpoint} onClick={reviewPlan}>{plan ? 'Refresh plan' : 'Review installation plan'}{!plan && <ArrowRight className="icon" aria-hidden="true" />}</button>
      {plan && <button className="primary" type="button" disabled={approvalDisabled || !approved || plan.coexistenceRequired && !coexistence} onClick={() => authorize(false)}>Authorize &amp; install<ArrowRight className="icon" aria-hidden="true" /></button>}
    </>;
  }

  if (step < furthest && (step < 2 || executed && step === 2)) {
    content = <>
      <div className="stage-intro"><h2 className="stage-title">{step === 0 ? 'Review connection details.' : step === 1 ? 'Review verified host.' : 'Review the executed plan.'}</h2>
        <p>{executed ? 'This is the saved evidence for this installation, not an editable new plan. Editing requires a separately reviewed restart.' : 'Your entered details are kept. Changing the connection requires a new scan and fingerprint verification; saved host trust is never overwritten.'}</p></div>
      {step === 2 ? <PlanDetails plan={plan} browser={plan?.browser ?? browser} fullControl={plan?.fullControl ?? fullControl} /> : <dl className="change-list">
        <div><dt>Server name</dt><dd>{entry.label}</dd></div><div><dt>SSH connection</dt><dd>{entry.target.user}@{entry.target.host}:{entry.target.port}</dd></div>
        <div><dt>Private key</dt><dd>{entry.target.identityFile || 'SSH agent'}</dd></div>
        <div><dt>Pinned host fingerprint</dt><dd><code className="fingerprint">{entry.fingerprint}</code>Previously verified for this connection. A changed host or key is not implicitly trusted.</dd></div>
      </dl>}
    </>;
    note = executed ? 'Original evidence is read-only. Restart needs separate removal and installation consent.' : 'New connection details require new proof and approval.';
    footer = <><button className="text-button" onClick={() => setViewedStep(null)}>Back to {furthest === 4 ? 'finish' : furthest === 3 ? 'installation' : 'review'}</button>
      {step === 1 && !executed && <button disabled={disabled || !!entry.endpoint} onClick={inspect}>Inspect again</button>}
      <button className="primary" disabled={disabled} onClick={editConnection}>{executed || found?.nativePresent ? 'Edit for a new installation' : 'Edit connection details'}</button></>;
  }

  if (!progress && found?.nativePresent && !removed && step === furthest) {
    content = <>{content}<div className="setup-lifecycle-note"><p>Find the original operation, including archived setup history, using this verified host and fingerprint. Restart uses this connection, not the original username or key.</p>
      <button className="text-button" disabled={disabled} onClick={openRestart}>Find original setup / Debug</button></div></>;
  }

  if (held && !removed) {
    content = <Notice title="Restart outcome must be checked">Removal may have started using this server’s verified connection. Installation, connection changes and retries are paused. Check the original restart receipt; no deletion will be repeated.</Notice>;
    note = 'A pending reset is not a clean server or permission to install.';
    footer = <><button className="text-button" onClick={onClose}>Close</button><button className="primary" disabled={!!restart?.busy} onClick={() => {
      const owner = Object.values(restarts).find(session => session.pending && sameSetupHost(session.connection, entry));
      if (owner && owner.connection.id !== entry.id) onOpenOriginal(owner.connection.id); else openRestart();
    }}>Check restart outcome</button></>;
  }

  if (removed) {
    content = <><div className="stage-intro"><h2 className="stage-title">Native installation removed / fenced.</h2><p>This original setup is read-only history. Its installation, reconnect and status-polling actions are disabled. A reset fence alone does not prove removal completed; check the restart receipt for its verified outcome.</p></div>
      {plan && <PlanDetails plan={plan} browser={plan.browser} fullControl={plan.fullControl} />}</>;
    note = 'Original operation evidence is retained. This setup cannot be revived.';
    footer = <><button className="text-button" onClick={onClose}>Close</button><button onClick={openRestart}>Check restart outcome</button></>;
  }

  if (troubleshooting && progress && stopped && !held && !removed) {
    content = <SetupTroubleshooting key={diagnosticKey} entry={entry} busy={disabled || checking} />;
    note = 'Read-only diagnostics. Installation and other setups are unchanged.';
    footer = <><button className="text-button" type="button" onClick={closeTroubleshooting}>Back to installation</button><button type="button" onClick={onClose}>Close</button></>;
  }

  if (restart?.open) return <SetupRestart entry={entry} session={restart} active={active} busy={!!busy || disconnecting} step={step}
    onBack={closeRestart} onEdit={onEditConnection} onOpenOriginal={onOpenOriginal} onOpenFresh={onOpenFresh} onVisibilityChange={setPaneVisible} />;

  return <ServerSetupPane label={entry.label} target={entry.target} status={setupEntryStatus(entry, disconnecting ? 'Cancelling SSH action' : busy, statusError, saved)}
    step={step} furthest={furthest} onStep={navigateStep} steps={existing ? ['Connect', 'Verify', 'Review', 'Link', 'Ready'] : undefined} active={active}
    onRestart={openRestart} restartRef={restartTrigger} restartDisabled={!!busy || disconnecting} restartLabel={held || removed ? 'Restart outcome…' : 'Restart setup…'}
    logs={logs} setupId={entry.id} operationId={progress?.operationId ?? plan?.operationId} inspection={found ?? undefined} fingerprint={entry.fingerprint}
    error={removed ? undefined : troubleshooting ? [error, localError].filter(Boolean).join('\n') : errors} statusError={removed ? undefined : statusError} note={note} footer={footer}
    onVisibilityChange={setPaneVisible} troubleshooting={troubleshooting} onTroubleshoot={stopped && !held && !removed ? openTroubleshooting : undefined}
    contentKey={troubleshooting ? 'troubleshooting' : `installation:${step}`}>{content}</ServerSetupPane>;
}
