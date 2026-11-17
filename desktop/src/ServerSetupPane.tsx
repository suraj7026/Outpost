import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Check, ChevronRight, Copy, Download, LockKeyhole, Server, SquareTerminal as Terminal, TriangleAlert } from 'lucide-react';
import type { Entry, Inspection, Target } from './server-setup-state';
import { call, nativeApp } from './api';

export interface SetupEntryStatus {
  label: string;
  tone: 'positive' | 'running' | 'warning' | 'negative' | 'muted';
}

export function setupEntryStatus(entry: Entry, busy: string, statusError: string, saved: boolean): SetupEntryStatus {
  if (entry.phase === 'reset') return { label: 'Native installation removed / fenced', tone: 'muted' };
  if (entry.phase === 'restart_pending') return { label: 'Check restart outcome', tone: 'warning' };
  if (busy) return { label: busy, tone: 'running' };
  const state = entry.installation?.state;
  if (state === 'failed' || state === 'interrupted') return { label: 'Needs attention', tone: 'negative' };
  if (state === 'cancelled') return { label: 'Stopped', tone: 'muted' };
  if (statusError) return { label: 'Status unavailable', tone: 'warning' };
  if (state === 'complete') return saved && entry.endpoint
    ? { label: 'Ready to use', tone: 'positive' }
    : { label: saved ? 'Disconnected' : 'Verify saved connection', tone: 'warning' };
  if (state === 'ready') return { label: 'Ready to connect', tone: 'warning' };
  if (state === 'unknown') return { label: entry.installation?.completedSteps ? 'Installation status unknown' : 'Authorization unconfirmed', tone: 'warning' };
  if (state === 'authorizing') return { label: 'Awaiting authorization', tone: 'warning' };
  if (state === 'queued') return { label: 'Installation queued', tone: 'running' };
  if (state === 'running') return { label: 'Installing', tone: 'running' };
  if (state) return { label: 'Check installation receipt', tone: 'warning' };
  if (entry.phase === 'inspecting') return { label: 'Inspecting server', tone: 'running' };
  if (entry.phase === 'connecting') return { label: 'Connecting', tone: 'running' };
  if (entry.error || ['failed', 'interrupted'].includes(entry.phase)) return { label: 'Needs attention', tone: 'negative' };
  if (saved) return entry.endpoint
    ? { label: 'Ready to use', tone: 'positive' }
    : { label: 'Disconnected', tone: 'warning' };
  if (entry.endpoint) return { label: 'Verify enrollment', tone: 'warning' };
  if (entry.inspection) return { label: 'Review needed', tone: 'warning' };
  return { label: entry.phase === 'disconnected' ? 'Disconnected' : 'Inspection needed', tone: 'muted' };
}

export interface ServerSetupPaneProps {
  label: string;
  target?: Target;
  status: SetupEntryStatus;
  step: number;
  steps?: string[];
  children: ReactNode;
  footer: ReactNode;
  note: string;
  logs: string[];
  operationId?: string;
  setupId?: string;
  inspection?: Inspection;
  fingerprint?: string;
  onStep?: (step: number) => void;
  furthest?: number;
  error?: string;
  errorTitle?: string;
  errorTone?: 'warning' | 'negative';
  statusError?: string;
  active: boolean;
  onVisibilityChange?: (visible: boolean) => void;
  troubleshooting?: boolean;
  onTroubleshoot?: () => void;
  contentKey?: string;
  onRestart?: () => void;
  restartDisabled?: boolean;
  restartLabel?: string;
  restartRef?: Ref<HTMLButtonElement>;
}

const defaultSteps = ['Connect', 'Verify', 'Review', 'Install', 'Finish'];
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export default function ServerSetupPane({
  label, target, status, step, steps = defaultSteps, children, footer, note, logs,
  operationId, setupId, inspection, fingerprint, onStep, furthest = step, error, errorTitle = 'This server needs attention', errorTone = 'negative', statusError, active,
  onVisibilityChange, troubleshooting = false, onTroubleshoot, contentKey, onRestart, restartDisabled, restartRef, restartLabel = 'Restart setup…',
}: ServerSetupPaneProps) {
  const id = useId();
  const workspace = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [step, contentKey]);
  useLayoutEffect(() => {
    if (!onVisibilityChange) return;
    const dialog = workspace.current?.closest('dialog');
    const update = () => onVisibilityChange(active && (dialog?.open ?? true));
    update();
    if (!dialog) return;
    // The setup modal keeps panes mounted on Close; selection alone is not visibility.
    const observer = new MutationObserver(update);
    observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    dialog.addEventListener('close', update);
    return () => { observer.disconnect(); dialog.removeEventListener('close', update); };
  }, [active, onVisibilityChange]);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState('');
  const [exportError, setExportError] = useState('');
  const [savedLog, setSavedLog] = useState('');
  const [exporting, setExporting] = useState(false);
  const destination = target
    ? `${target.user}@${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`
    : 'Add a connection to get started';
  const inspectionText = inspection ? [
    `Platform: ${inspection.os} ${inspection.osVersion} · ${inspection.architecture}`,
    `Service manager: ${inspection.systemd ? 'systemd' : 'Not detected'}`,
    `Container: ${inspection.container ? 'Detected' : 'Not reported'}`,
    `Capacity: ${gib(inspection.freeBytes)} free in /var/lib · ${gib(inspection.memoryBytes)} RAM`,
    `SSH UID: ${inspection.uid}; sudo inspection: ${inspection.sudo}`,
    `API: ${inspection.api}${inspection.apiPort ? ` · 127.0.0.1:${inspection.apiPort}` : ''}`,
    `Native files: ${inspection.nativePresent ? 'Present' : 'Not reported'}`,
    `Environment: ${inspection.environment?.environmentId ?? 'Not verified'}`,
    `Reported release: ${inspection.environment?.release ?? 'Unknown'}`,
    `Existing markers: ${inspection.markers.join(', ') || 'None reported'}`,
  ].join('\n') : 'No inspection result yet.';
  const report = [
    `Outpost setup — ${label}`, `Target: ${destination}`,
    `Operation: ${operationId ?? 'No installation operation yet'}`,
    `SSH fingerprint: ${fingerprint || 'Not verified'}`, '', inspectionText, '',
    'Activity', ...(logs.length ? logs : ['No activity yet.']),
  ].join('\n');

  const copyLog = async () => {
    setExportError('');
    try { await navigator.clipboard.writeText(report); setCopied(report); }
    catch { setExportError('Could not copy this log. Select its text or download it instead.'); }
  };
  const downloadLog = async () => {
    if (exporting) return;
    setExportError(''); setSavedLog('');
    if (nativeApp()) {
      if (!setupId) { setExportError('No saved setup journal yet. Copy the current diagnostic text instead.'); return; }
      setExporting(true);
      try { setSavedLog(await call<string>('setup_export_log', { id: setupId })); }
      catch (failure) { setExportError(`Could not save this log: ${String(failure)}`); }
      finally { setExporting(false); }
      return;
    }
    let url: string | undefined;
    const link = document.createElement('a');
    try {
      url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
      link.href = url;
      link.download = `outpost-${(target?.host || label).replace(/[^a-zA-Z0-9._-]/g, '-')}-${(operationId || 'inspection').replace(/[^a-zA-Z0-9._-]/g, '-')}.log`;
      document.body.append(link);
      link.click();
    } catch { setExportError('Could not download this log. Copy it or select its text instead.'); }
    finally { link.remove(); if (url) URL.revokeObjectURL(url); }
  };

  return <section ref={workspace} className="workspace" hidden={!active} aria-labelledby={`${id}-identity`} aria-live={active ? undefined : 'off'}>
    <header className="identity">
      <div className="identity-main"><Server className="icon" aria-hidden="true" /><div>
        <h2 id={`${id}-identity`}>{label}</h2><p>{destination}</p>
      </div></div>
      <div className="identity-actions"><span className={`badge ${status.tone}`} role={active ? 'status' : undefined}>
        <span className="dot" aria-hidden="true" />{status.label}
      </span>{onRestart && <button ref={restartRef} className="text-button" type="button" disabled={restartDisabled} onClick={onRestart}>{restartLabel}</button>}</div>
    </header>
    <nav className="steps" aria-label={`${label} setup steps`}>
      {steps.map((name, index) => <button key={`${index}:${name}`} type="button"
        className={`step${index < furthest ? ' done' : ''}`} aria-current={index === step ? 'step' : undefined}
        aria-label={`${name}, ${index === step ? 'current' : index < furthest ? 'complete' : index === furthest ? 'available' : 'upcoming'}`}
        disabled={!onStep || index > furthest} onClick={() => onStep?.(index)}>
        <span className="step-mark">{index < furthest ? <Check className="icon" aria-hidden="true" /> : index + 1}</span><span>{name}</span>
      </button>)}
    </nav>
    <div className="content-scroll" ref={scroll}><div className="stage-content" id={`${id}-stage-content`}>
      {error && <div className={`notice ${errorTone} setup-error`} role={active ? 'alert' : undefined}>
        <TriangleAlert className="icon" aria-hidden="true" /><div><strong>{errorTitle}</strong><p className="setup-error-details">{error}</p></div>
      </div>}
      {statusError && <div className="notice warning" role={active ? 'status' : undefined}>
        <TriangleAlert className="icon" aria-hidden="true" /><div><strong>Progress could not be refreshed</strong>
          <p>The server may still be working. These are its last confirmed checks; no installation has been repeated. {statusError}</p>
        </div>
      </div>}
      {children}
    </div></div>
    <section className="diagnostics" aria-label={`${label} activity and diagnostics`}>
      <button className="diagnostics-toggle" type="button" aria-expanded={expanded} aria-controls={`${id}-diagnostic-body`} onClick={() => setExpanded(value => !value)}>
        <Terminal className="icon" aria-hidden="true" />Activity &amp; diagnostics
        <span className="diagnostics-caption">{label} only · {logs.length} events</span><ChevronRight className="icon" aria-hidden="true" />
      </button>
      <div className="diagnostic-body" id={`${id}-diagnostic-body`} hidden={!expanded}>
        <div className="log-toolbar"><span>{destination}</span><code>{operationId ?? 'Inspection only'}</code>
          {onTroubleshoot ? <button className="text-button" type="button" disabled={troubleshooting} onClick={onTroubleshoot}>{troubleshooting ? 'Reports in troubleshooting above' : 'Troubleshoot & report'}</button> : <>
            <button className="text-button" type="button" onClick={() => void copyLog()}><Copy className="icon" aria-hidden="true" />{copied === report ? 'Copied' : 'Copy log'}</button>
            <button className="text-button" type="button" disabled={exporting || nativeApp() && !setupId} onClick={() => void downloadLog()}><Download className="icon" aria-hidden="true" />{exporting ? 'Saving log…' : 'Download'}</button>
          </>}
        </div>
        {onTroubleshoot && <p className="quiet-note">Saved local activity only; private server output is not collected here. Use troubleshooting for evidence and sanitized report sharing.</p>}
        {!onTroubleshoot && savedLog && <p className="saved-log" role={active ? 'status' : undefined}>Saved log to {savedLog}</p>}
        {!onTroubleshoot && exportError && <p className="inline-error" role={active ? 'alert' : undefined}>{exportError}</p>}
        <pre className="log-lines" tabIndex={0} aria-label={`${label} activity log`}>{logs.length ? logs.join('\n') : 'No activity yet. Connect this server to begin.'}</pre>
        <details><summary>Inspection details</summary><pre className="log-lines" tabIndex={0} aria-label={`${label} inspection details`}>{inspectionText}</pre>
          <p className="quiet-note">Inspection does not grant installation or ongoing root authority. Reported releases do not establish upgrade compatibility, and marker detection may not cover every deployment.</p>
        </details>
        <details><summary>SSH host fingerprint</summary><code className="fingerprint">{fingerprint || 'Not verified'}</code>
          <p className="quiet-note">Compare this fingerprint with the server console or a trusted administrator. Never approve an unexpected change.</p>
        </details>
      </div>
    </section>
    <footer className="setup-footer"><span className="footer-info"><LockKeyhole className="icon" aria-hidden="true" /><span>{note}</span></span><div className="footer-actions">{footer}</div></footer>
  </section>;
}
