import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { nativeApp, recordedPreview } from './api';
import type { OpenChat } from './ChatHistory';
import type { Connection } from './useConnection';
import type { Json } from './types';
import { chosenModel, type ModelRef } from './agent/types';
import { preferredCloudModel } from './models';
import { Button, Dialog } from './Interface';
import { manualRecoverySteps, parseRecoveryReport, recoverySummary, type RecoveryReport } from './recovery-diagnostics';
import './recovery-investigation.css';

export default function RecoveryInvestigation({ connection, onClose, openChat }: {
  connection: Connection; onClose: () => void; openChat?: OpenChat;
}) {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [loading, setLoading] = useState(false), [starting, setStarting] = useState(false);
  const [readError, setReadError] = useState(''), [notice, setNotice] = useState('');
  const [submitted, setSubmitted] = useState(false), [createdId, setCreatedId] = useState<string | null>(null);
  const [model, setModel] = useState(''), [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const [shared, setShared] = useState(false);
  const mounted = useRef(false), sequence = useRef(0), startingRef = useRef(false);
  const currentConnection = useRef(connection); currentConnection.current = connection;
  const readOnly = !nativeApp() || recordedPreview();
  const recovery = connection.records.find(row => row.kind === 'recovery' && row.id === 'server');
  const evidenceKey = JSON.stringify([connection.environmentId, connection.info?.endpoint, connection.connected, recovery?.revision, recovery?.data.dispatchEnabled]);
  const currentEvidence = useRef(evidenceKey); currentEvidence.current = evidenceKey;
  const managed = !!connection.runtime?.piManagement;
  const selectedRef = chosenModel(connection.agentCatalogue, modelRef);
  const selectedModel = model ? (connection.models.includes(model) ? model : '') : preferredCloudModel(connection.models, '', connection.runtime?.model ?? null);
  const modelReady = managed ? !!selectedRef : !!selectedModel;
  const self = connection.records.find(row => row.kind === 'device' && row.id === connection.info?.deviceId);
  const localBlocker = readOnly ? 'Live investigation requires the installed app; manual guidance remains available.'
    : connection.retired ? 'Select the verified installation before starting an agent investigation.'
    : !connection.connected ? 'The server is offline. Reconnect or use manual discovery; cached records are not current evidence.'
    : connection.info?.pendingError ? 'Local recovery storage needs attention. Keep the files intact; do not reset pairing or reinstall.'
    : connection.info?.pending ? 'An earlier command has an unknown outcome. Inspect it and use only Retry same command with its original operation key.'
    : self?.data.revoked !== false ? 'This device’s authority is not confirmed. Use a trusted device for agent actions.' : '';
  const canStart = !!report?.agent.available && !localBlocker && !connection.busy && !loading && !starting && !submitted && modelReady && shared;

  const collect = useCallback(async () => {
    const ticket = ++sequence.current, key = currentEvidence.current;
    const owner = currentConnection.current;
    setReport(null); setReadError(''); setShared(false);
    if (readOnly || !owner.connected) { setLoading(false); return null; }
    setLoading(true);
    try {
      const next = parseRecoveryReport(await owner.api.query<unknown>('recovery.diagnostics'), owner.environmentId);
      if (!mounted.current || ticket !== sequence.current || key !== currentEvidence.current) return null;
      setReport(next);
      return next;
    } catch {
      if (mounted.current && ticket === sequence.current && key === currentEvidence.current)
        setReadError('A current diagnostic report could not be verified. This may be an older server release, a connection or trust failure, or an unsupported response. No repair was attempted. Use the manual steps below.');
      return null;
    } finally { if (mounted.current && ticket === sequence.current) setLoading(false); }
  }, [readOnly]);

  useEffect(() => {
    mounted.current = true;
    void collect();
    return () => { mounted.current = false; ++sequence.current; };
  }, [collect, evidenceKey]);

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); if (mounted.current) setNotice('Copied. Commands have not been executed.'); }
    catch { if (mounted.current) setNotice('Clipboard unavailable. Select the text below to copy it.'); }
  }

  async function startAgent() {
    if (!canStart || startingRef.current) return;
    startingRef.current = true; setStarting(true); setNotice('');
    const owner = currentConnection.current, key = currentEvidence.current;
    const selection: Record<string, Json> = managed && selectedRef ? { modelRef: { providerId: selectedRef.providerId, modelId: selectedRef.modelId } } : { model: selectedModel };
    try {
      // Re-read before handoff; command admission also checks live server policy atomically.
      const fresh = await collect();
      if (!fresh || !mounted.current || key !== currentEvidence.current) return;
      if (!fresh.agent.available) { setNotice('The server cannot start an agent investigation now. Use the findings and manual steps below.'); return; }
      const latest = currentConnection.current;
      if (!latest.connected || latest.retired || latest.busy || latest.info?.pending || latest.info?.pendingError ||
        latest.records.find(row => row.kind === 'device' && row.id === latest.info?.deviceId)?.data.revoked !== false) return;
      const id = crypto.randomUUID();
      setSubmitted(true);
      const result = await owner.command('recovery.investigate', id, 0, selection);
      if (!mounted.current || key !== currentEvidence.current) return;
      if (result) {
        setCreatedId(id);
        setNotice('Investigation created in Ask Permission. Open it to review proposed actions; a later hold can still pause it.');
      } else setNotice('Investigation was not confirmed. Check task history and any pending command before trying again. Do not submit a new copy of an uncertain command.');
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  const steps = manualRecoverySteps(report?.platform ?? null);
  return <Dialog title="Investigate recovery" onClose={onClose} busy={starting} className="recovery-investigation">
    <p>Outpost first reads this server’s recovery, maintenance and queue state. This check does not run a model, execute shell commands, resume work or change recovery records.</p>
    {localBlocker && <p className="settings-safety-note" role="status">{localBlocker}</p>}
    <div className="ui-dialog-actions recovery-review-actions"><Button disabled={readOnly || !connection.connected || loading || starting} onClick={() => void collect()}><RefreshCw size={16} />{loading ? 'Reading diagnostics…' : 'Refresh diagnostics'}</Button></div>
    {readError && <p role="alert">{readError}</p>}
    {report && <section aria-label="Recovery findings">
      <h3>{recoverySummary(report)}</h3>
      <p className="settings-safety-note">Observed {new Date(report.collectedAt).toLocaleString()}. A point-in-time report, not a guarantee that the runtime is healthy.</p>
      <dl className="ui-facts"><dt>Environment</dt><dd><code>{report.environmentId}</code>{connection.environmentId === null && ' · legacy route (not environment-bound)'}</dd>
        <dt>Server release</dt><dd>{report.release ?? 'Not reported'} · {report.platform} / {report.architecture}</dd>
        <dt>Dispatch policy</dt><dd>{report.dispatchEnabled ? 'Enabled' : 'Held'} · recovery revision {report.recovery.revision ?? 'not present'}</dd>
        <dt>Maintenance</dt><dd>{report.maintenance.state}{report.maintenance.holding ? ' · admission held' : ''}</dd>
        <dt>Uncertain work</dt><dd>{report.work.unknownActions} actions · {report.work.unknownOperations} operations · {report.work.unknownOutbox} outbox entries</dd>
        <dt>Queued tasks</dt><dd>{report.work.queuedTasks}</dd>
        <dt>Host access</dt><dd>{report.runtime.hostAdministration ? `Configured: ${report.runtime.hosts.join(', ') || 'no hosts reported'} (not health-checked)` : 'Not configured; the agent must give manual commands for host inspection'}</dd></dl>
      <ul>{report.findings.map((finding, index) => <li key={`${finding.code}:${index}`}>{finding.summary}</li>)}</ul>
      <details className="ui-details"><summary>Copy diagnostic report</summary><p>Contains installation ID, release, configured host names and work counts. Review before sharing; no credentials or command payloads are collected.</p><Button onClick={() => void copy(JSON.stringify(report, null, 2))}><Copy size={16} />Copy report</Button><pre tabIndex={0}>{JSON.stringify(report, null, 2)}</pre></details>
    </section>}
    {report?.agent.available && <section className="ui-form" aria-label="Agent investigation">
      <h3>Continue with the agent</h3>
      <p>The agent will investigate first, propose only evidence-based repairs, and verify results. Actions use <strong>Ask Permission</strong>, even if your normal tasks use Full control. It cannot bypass a recovery hold.</p>
      <label>Investigation model<select value={managed ? selectedRef ? JSON.stringify([selectedRef.providerId, selectedRef.modelId]) : '' : selectedModel} disabled={starting || submitted || !!localBlocker} onChange={event => {
        setShared(false);
        if (managed) {
          const found = connection.agentCatalogue?.models.find(item => JSON.stringify([item.providerId, item.modelId]) === event.target.value);
          setModelRef(found ? { providerId: found.providerId, modelId: found.modelId } : null);
        } else setModel(event.target.value);
      }}>
        <option value="">Choose an available model</option>
        {managed ? connection.agentCatalogue?.models.map(item => <option key={JSON.stringify([item.providerId, item.modelId])} value={JSON.stringify([item.providerId, item.modelId])}>{item.providerId} · {item.name}</option>) : connection.models.map(item => <option key={item} value={item}>{item}</option>)}
      </select></label>
      {!modelReady && <p role="status">No verified model is selected. Check Models &amp; providers, or use manual discovery.</p>}
      <label className="settings-page-check"><input type="checkbox" checked={shared} disabled={starting || submitted || !!localBlocker || !modelReady} onChange={event => setShared(event.target.checked)} /><span>Send a fresh diagnostic summary to this model. Cloud models receive the summary and subsequent tool context.</span></label>
      <Button variant="primary" disabled={!canStart} onClick={() => void startAgent()}>{starting ? 'Starting investigation…' : 'Start agent investigation'}</Button>
    </section>}
    {report && !report.agent.available && <p className="settings-safety-note">The agent cannot run on this server right now. Read-only diagnosis still works during a hold. Use the manual steps; do not resume queued work just to run an investigation.</p>}
    {notice && <p role="status">{notice}</p>}
    {createdId && openChat && <Button variant="primary" onClick={() => openChat(connection.environmentId, createdId)}>Open investigation</Button>}
    {createdId && !openChat && <p>Find “Investigate recovery” in this server’s task history.</p>}
    <details className="ui-details" open={!report || !report.agent.available}>
      <summary>Manual investigation commands</summary>
      <p>The deployment has not been identified. These commands only discover it; none repairs, restarts or deletes anything. Use the server’s existing trusted SSH connection or console, not an assumed hostname. Do not share tokens, environment files or unreviewed logs.</p>
      {steps.map(step => <section key={step.id} className="recovery-command"><h4>{step.title}</h4><p>{step.where}</p><pre tabIndex={0}>{step.command}</pre><Button onClick={() => void copy(step.command)}><Copy size={16} />Copy {step.title.toLowerCase()}</Button><p className="settings-safety-note">{step.expected}</p></section>)}
      <p>After identifying the installation, use Connection → Installation &amp; SSH setup → Troubleshoot &amp; report when available, or bring the reviewed output to the agent for exact repair commands and verification. Missing status alone is not a reason to create a recovery record.</p>
    </details>
    <div className="ui-dialog-actions"><Button disabled={starting} onClick={onClose}>Done</Button></div>
  </Dialog>;
}
