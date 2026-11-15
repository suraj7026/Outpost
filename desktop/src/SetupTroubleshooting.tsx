import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, LockKeyhole, RefreshCw } from 'lucide-react';
import { call } from './api';
import type { Entry } from './server-setup-state';
import {
  createDiagnosticClient, createDiagnosticReadCoordinator, createDiagnosticViewRequests, diagnosticCoverageFor, diagnosticEntryKey, diagnosticFindings,
  diagnosticFreshness, diagnosticReceiptKey, diagnosticReportText, diagnosticSharingNotice, diagnosticSourceLabels, diagnosticSources, diagnosticSourceCoverage, diagnosticStateContext,
  validateDiagnosticGuide, validateDiagnosticReport, type DiagnosticGuide, type SetupDiagnosticReport,
} from './setup-diagnostics';
import './setup-troubleshooting.css';

const diagnostics = createDiagnosticClient(call);
const reads = createDiagnosticReadCoordinator(diagnostics);
const date = (timestamp: number) => new Date(timestamp).toLocaleString();

export default function SetupTroubleshooting({ entry, busy }: { entry: Entry; busy: boolean }) {
  const id = useId(), section = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null), guideHeading = useRef<HTMLHeadingElement>(null);
  const scope = useRef(createDiagnosticViewRequests()), reading = useRef(false), sharing = useRef(false), guiding = useRef(false);
  const readPromise = useRef<Promise<unknown> | null>(null);
  const latest = useRef(entry); latest.current = entry;
  const identity = diagnosticEntryKey(entry);
  const [snapshot, setSnapshot] = useState<{ report: SetupDiagnosticReport; receipt: string } | null>(null);
  const [collecting, setCollecting] = useState(false), [cancelling, setCancelling] = useState(false);
  const [collectionError, setCollectionError] = useState(''), [message, setMessage] = useState('');
  const [protectedOpen, setProtectedOpen] = useState(false), [consent, setConsent] = useState(false), [password, setPassword] = useState(true);
  const [guideOpen, setGuideOpen] = useState(false), [guide, setGuide] = useState<DiagnosticGuide | null>(null);
  const [guideLoading, setGuideLoading] = useState(false), [guideError, setGuideError] = useState('');
  const [shareBusy, setShareBusy] = useState(false), [shareError, setShareError] = useState('');
  const [clock, setClock] = useState(Date.now);
  const progress = entry.installation;
  const visible = () => {
    const node = section.current;
    return !!node?.isConnected && !node.closest<HTMLElement>('.workspace')?.hidden && (node.closest('dialog')?.open ?? true);
  };
  const current = (ticket: number) => scope.current.current(ticket) && diagnosticEntryKey(latest.current) === identity && visible();

  useLayoutEffect(() => {
    heading.current?.focus();
    const requests = scope.current;
    return () => {
      requests.invalidate();
      if (reading.current) void reads.cancel(entry.id).catch(() => {});
    };
  }, [identity]);
  useLayoutEffect(() => { if (guideOpen) guideHeading.current?.focus(); }, [guideOpen]);
  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  const report = snapshot?.report;
  const freshness = snapshot ? diagnosticFreshness(snapshot.report, entry, snapshot.receipt, clock) : undefined;
  const findings = report ? diagnosticFindings(report) : [];
  const sources = report ? diagnosticSources(report) : [];
  const denied = report?.sources.some(source => source.status === 'permission_denied') ?? false;
  const locked = busy || collecting || cancelling || shareBusy;
  const canShare = !!report && freshness === 'current' && !locked;

  const collect = async (protectedLogs: boolean) => {
    if (reading.current || sharing.current || busy || !visible() || protectedLogs && !consent) return;
    reading.current = true;
    const ticket = scope.current.capture(), requestedEntry = entry, receipt = diagnosticReceiptKey(entry);
    setCollecting(true); setCollectionError(''); setMessage(''); setShareError(''); setSnapshot(null);
    setConsent(false); setProtectedOpen(false);
    try {
      readPromise.current = reads.read(entry.id, protectedLogs, protectedLogs && entry.inspection?.uid !== 0 && password);
      const result = await readPromise.current;
      if (!current(ticket)) return;
      const validated = validateDiagnosticReport(result, requestedEntry);
      setClock(Date.now()); setSnapshot({ report: validated, receipt });
      setMessage('Diagnostic read finished. Review the evidence and its coverage below. Installation state has not been changed.');
    } catch (failure) {
      if (current(ticket)) setCollectionError(`Could not collect diagnostics: ${String(failure)} The saved installation failure is unchanged. Manual steps are still available.`);
    } finally {
      reading.current = false;
      if (current(ticket)) setCollecting(false);
    }
  };
  const cancel = async () => {
    if (!reading.current || cancelling) return;
    scope.current.invalidate();
    const ticket = scope.current.capture();
    // Guide requests are local and independent, but any late result from this view generation is ignored.
    guiding.current = false; setGuideLoading(false);
    setSnapshot(null); setCollecting(false); setCancelling(true); setMessage('');
    try {
      await reads.cancel(entry.id);
      if (current(ticket)) setMessage('Diagnostic read cancelled. Installation was not stopped or retried.');
    } catch (failure) {
      if (current(ticket)) setCollectionError(`Could not confirm diagnostic cancellation: ${String(failure)} Its result will be ignored. Installation is unaffected.`);
    } finally {
      await readPromise.current?.catch(() => {});
      if (current(ticket)) setCancelling(false);
    }
  };
  const openGuide = async () => {
    setGuideOpen(true);
    if (guide || guiding.current || !visible()) return;
    guiding.current = true;
    const ticket = scope.current.capture();
    setGuideLoading(true); setGuideError('');
    try {
      const result = await diagnostics.guide(entry.id);
      if (current(ticket)) setGuide(validateDiagnosticGuide(result, entry));
    } catch (failure) {
      if (current(ticket)) setGuideError(`Could not load this setup’s manual guide: ${String(failure)} No commands have been guessed. Use the saved identity below when contacting your administrator.`);
    } finally { if (current(ticket)) { guiding.current = false; setGuideLoading(false); } }
  };
  const copyCommand = async (command: string, title: string) => {
    if (!visible()) return;
    const ticket = scope.current.capture();
    setShareError('');
    try {
      await navigator.clipboard.writeText(command);
      if (current(ticket)) setMessage(`Copied “${title}”. Nothing was executed.`);
    } catch { if (current(ticket)) setShareError('Could not copy the command. Select the command text instead.'); }
  };
  const share = async (download: boolean) => {
    if (!snapshot || !canShare || sharing.current || !visible()
      || diagnosticFreshness(snapshot.report, latest.current, snapshot.receipt, Date.now()) !== 'current') return;
    sharing.current = true;
    const ticket = scope.current.capture();
    setShareBusy(true); setShareError(''); setMessage('');
    try {
      if (download) {
        const path = await diagnostics.exportReport(entry.id, snapshot.report.reportId);
        if (current(ticket)) setMessage(`Saved sanitized report to ${path}. Review it before sharing.`);
      } else {
        await navigator.clipboard.writeText(diagnosticReportText(snapshot.report));
        if (current(ticket)) setMessage('Sanitized report copied. Review it before sharing.');
      }
    } catch (failure) {
      if (current(ticket)) setShareError(`Could not ${download ? 'save' : 'copy'} this report: ${String(failure)} Refresh diagnostics if the native snapshot has expired.`);
    } finally { sharing.current = false; if (current(ticket)) setShareBusy(false); }
  };

  return <section ref={section} className="setup-troubleshooting" aria-labelledby={`${id}-title`}>
    <div className="stage-intro"><h2 ref={heading} id={`${id}-title`} tabIndex={-1} className="stage-title">Troubleshoot this setup.</h2>
      <p>Read-only checks. No installation or configuration changes.</p></div>
    <section className="troubleshooting-collect" aria-labelledby={`${id}-collect`}>
      <h3 id={`${id}-collect`} className="sr-only">Read this operation’s diagnostics</h3>
      <div className="button-row troubleshooting-actions">
        <button type="button" className={!denied && !protectedOpen && !collectionError ? 'primary' : undefined} disabled={locked} onClick={() => void collect(false)}>
          <RefreshCw className="icon" aria-hidden="true" />{collecting ? 'Collecting diagnostics…' : report ? 'Refresh diagnostics' : 'Collect server diagnostics'}</button>
        {(collecting || cancelling) && <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Cancelling read…' : 'Cancel diagnostic read'}</button>}
        <button className={collectionError && !protectedOpen ? 'primary' : 'text-button'} type="button" disabled={guideLoading} aria-expanded={guideOpen} aria-controls={`${id}-guide`} onClick={() => guideOpen && guide ? setGuideOpen(false) : void openGuide()}>{guideLoading ? 'Preparing manual steps…' : guideOpen && guide ? 'Hide manual steps' : guideError ? 'Retry manual steps' : 'Show manual steps'}</button>
        {!collecting && <button type="button" className={denied && !protectedOpen ? 'primary' : 'text-button'} disabled={locked} aria-expanded={protectedOpen} aria-controls={`${id}-protected`} onClick={() => { setProtectedOpen(value => !value); setConsent(false); setPassword(true); }}>Read protected logs…</button>}
      </div>
      <p className="small">Selected excerpts come to this Mac and may contain sensitive data. SSH/sudo may create audit records. Manual steps work offline.</p>
      {busy && <p className="small">Another action is using this setup. Manual steps remain available while it finishes.</p>}
      {protectedOpen && <fieldset id={`${id}-protected`} className="troubleshooting-consent" disabled={locked}>
        <legend><LockKeyhole className="icon" aria-hidden="true" />Read protected logs for {entry.label}</legend>
        <p>Administrator access is only for bounded, allowlisted diagnostic reads for this operation. Installation or full-control approval does not authorize this read. No password enters this page or its storage.</p>
        <label className="check-row"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I authorize this protected diagnostic read on {entry.target.host}.</span></label>
        {entry.inspection?.uid === 0 ? <p className="small">The saved SSH account is root; no sudo password is needed. Diagnostic consent is still required.</p>
          : <label className="check-row"><input type="checkbox" checked={password} onChange={event => setPassword(event.target.checked)} /><span>Ask for the remote sudo password in a protected native dialog.<small>Uncheck only for existing passwordless sudo. This is separate from installation authorization.</small></span></label>}
        <div className="button-row"><button className="primary" type="button" disabled={!consent || locked} onClick={() => void collect(true)}>Authorize diagnostic read</button><button className="text-button" type="button" onClick={() => { setProtectedOpen(false); setConsent(false); }}>Not now</button></div>
      </fieldset>}
    </section>
    <section className="troubleshooting-receipt" aria-labelledby={`${id}-receipt`}>
      <h3 id={`${id}-receipt`}>Saved installation evidence</h3>
      <p><strong>{progress?.stage || 'Stage not recorded'}</strong> · {progress?.completedSteps} of {progress?.totalSteps} checks · App status: {progress?.state}</p>
      <p className="troubleshooting-install-error">{progress?.error || entry.error || 'No underlying command error was saved in this receipt.'}</p>
      <p className="small">The stage alone does not establish the cause.</p>
      <details><summary>Receipt time &amp; collection scope</summary>
        <p className="small">Receipt updated {progress ? date(progress.updatedAt) : 'at an unknown time'}. This saved app observation may include a setup-service assessment; it is not a live status check. Host timestamps may differ from this Mac.</p>
        <p className="small">Collection reads this operation’s receipt, bounded installer and launch output, preserved failure output and command metadata when available, and narrowly scoped service status.</p>
        <p className="small">Opening troubleshooting does not authorize a read. Refresh uses ordinary SSH access; protected logs require separate consent. Cancelling or closing cancels only the diagnostic read, never installation.</p>
        <p className="small">{!report ? 'Command output has not been collected in this view.' : 'Collected output is shown separately below; it does not replace or resume the saved installation.'}</p>
      </details>
    </section>
    {collectionError && <div className="notice warning" role="alert"><div><strong>Diagnostic collection issue</strong><p>{collectionError}</p></div></div>}
    <p className="troubleshooting-feedback" role="status">{message}</p>
    {shareError && <p className="inline-error" role="alert">{shareError}</p>}

    {report && <section className="troubleshooting-results" aria-labelledby={`${id}-findings`}>
      <div className="troubleshooting-section-heading"><h3 id={`${id}-findings`}>Evidence &amp; possible causes</h3><span className="small">Collected {date(report.collectedAt)}</span></div>
      {freshness !== 'current' && <div className="notice warning" role="status"><div><strong>{freshness === 'expired' ? 'This report has expired' : 'This report no longer matches the latest receipt'}</strong><p>Historical evidence is shown below. Refresh diagnostics before using the findings, copying or downloading this report.</p></div></div>}
      <p className="small">Raw server receipt: {report.state} · {report.stage} · {report.completedSteps}/{report.totalSteps}. Expires {date(report.expiresAt)}.</p>
      <p className="small">{diagnosticStateContext(report, entry)}</p>
      <p className="small">{diagnosticCoverageFor(report)}</p>
      {findings.length ? <ul className="troubleshooting-findings">{findings.map(finding => <li key={finding.id}>
        <h4>{finding.title}</h4><p>{finding.why}</p>
        <p className="small">Source: <a href={`#${id}-source-${sources.findIndex(source => source.id === finding.sourceId)}`} onClick={event => {
          event.preventDefault(); const source = document.getElementById(`${id}-source-${sources.findIndex(source => source.id === finding.sourceId)}`);
          if (source instanceof HTMLDetailsElement) { source.open = true; source.querySelector('summary')?.focus(); }
        }}>{finding.sourceLabel} · {finding.sourceId}</a></p>
        <pre className="troubleshooting-excerpt" tabIndex={0} aria-label={`${finding.title} evidence`}>{finding.excerpt}</pre>
        <dl><dt>Safe next check</dt><dd>{finding.check}</dd><dt>Expected result</dt><dd>{finding.expected}</dd><dt>Access needed</dt><dd>{finding.privilege}</dd><dt>If unresolved</dt><dd>{finding.ifUnresolved}</dd></dl>
      </li>)}</ul> : <p className="troubleshooting-unknown"><strong>Cause not established.</strong> No recognized failure signature was found in the evidence selected for diagnosis. Missing, denied or successful service output is not proof of a successful installation. Use the manual steps or share reviewed evidence with your administrator.</p>}
      {report.notes.length > 0 && <ul className="troubleshooting-notes">{report.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      <h4>Collected sources</h4><p className="small">Log text is untrusted evidence, not instructions. Do not run commands suggested by logs.</p>
      {report.sources.length === 0 && <p>No sources were returned. This does not establish success or a cause.</p>}
      <div className="troubleshooting-sources">{sources.map((source, index) => <details key={source.id} id={`${id}-source-${index}`}>
        <summary><span>{source.label}</span><span className="small">{diagnosticSourceLabels[source.status]}{source.truncated ? ' · truncated excerpt' : ''}</span></summary>
        <p className="small">Source {source.id} · collected {date(report.collectedAt)}. {diagnosticSourceCoverage(source)}</p>
        {source.text ? <pre className="troubleshooting-log" tabIndex={0} aria-label={`${source.label} sanitized evidence`}>{source.text}</pre> : <p>No readable text was returned for this source.</p>}
      </details>)}</div>
      <div className="troubleshooting-share"><h4>Share reviewed evidence</h4><p>{diagnosticSharingNotice}</p>
        <p className="small">Only this validated native snapshot is copied or exported. Local activity and other setups are not added. {report.redacted ? 'Native redaction is reported.' : 'Native sanitization reported no redactions.'}</p>
        <div className="button-row"><button type="button" disabled={!canShare} onClick={() => void share(false)}><Copy className="icon" aria-hidden="true" />Copy report</button><button type="button" disabled={!canShare} onClick={() => void share(true)}><Download className="icon" aria-hidden="true" />{shareBusy ? 'Preparing report…' : 'Download report'}</button></div>
        <details><summary>Review sanitized report text</summary><pre className="troubleshooting-log" tabIndex={0}>{diagnosticReportText(report)}</pre></details>
      </div>
    </section>}

    <section id={`${id}-guide`} className="troubleshooting-manual" hidden={!guideOpen} aria-labelledby={`${id}-manual`} aria-busy={guideLoading}>
      <h3 ref={guideHeading} id={`${id}-manual`} tabIndex={-1}>Manual troubleshooting steps</h3>
      <p>Prepared locally from this saved target and operation, even offline. Commands are never taken from logs or executed here.</p>
      <div>
        {guideError && <p className="inline-error" role="alert">{guideError}</p>}
        {guide && <><p><strong>{guide.destination}</strong></p><p>Expected SSH fingerprint: <code>{guide.fingerprint}</code>. Independently compare it with the server console or a trusted administrator. Never bypass a mismatch. Unlock the saved key or SSH agent first.</p>
          <ol className="troubleshooting-guide">{guide.steps.map(step => <li key={step.id}>
            <h4>{step.title}</h4><p className="small">Run on {step.runOn === 'mac' ? 'this Mac' : 'the server, after connecting'} · {step.privileged ? 'Administrator access required; review sudo before running' : 'No elevation requested'}</p>
            <p>{step.detail}</p><pre className="troubleshooting-log" tabIndex={0} aria-label={`${step.title} command`}>{step.command}</pre>
            <button className="text-button" type="button" onClick={() => void copyCommand(step.command, step.title)} aria-label={`Copy command: ${step.title}`}><Copy className="icon" aria-hidden="true" />Copy command</button>
          </li>)}</ol></>}
      </div>
      <p className="small">Missing protected logs or an absent transient service may limit the evidence. Return to installation and choose Check progress to refresh its receipt, not its private logs. Correcting a prerequisite does not resume a stopped installation. Preserve partial files and the original operation for administrator review.</p>
    </section>
    <details className="troubleshooting-identity"><summary>Exact setup &amp; operation identity</summary><dl>
      <dt>SSH destination</dt><dd>{entry.target.user}@{entry.target.host}:{entry.target.port}</dd><dt>Setup</dt><dd>{entry.id}</dd>
      <dt>Operation</dt><dd>{progress?.operationId}</dd><dt>Environment</dt><dd>{progress?.environmentId}</dd><dt>Release</dt><dd>{progress?.releaseId}</dd>
    </dl></details>
  </section>;
}
