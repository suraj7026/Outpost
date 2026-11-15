import { useEffect, useId, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import ServerSetupPane from './ServerSetupPane';
import { setupWasExecuted, type Entry } from './server-setup-state';
import { restartApplyBlocker, restartBusy, restartErrorPresentation, restartNeedsStop, restartReviewBinding, setupRestarts, type RestartSession } from './server-restart';
import './server-restart.css';

export default function SetupRestart({ entry, session, active, busy, step, onBack, onEdit, onOpenOriginal, onOpenFresh, onVisibilityChange }: {
  entry: Entry; session: RestartSession; active: boolean; busy: boolean; step: number;
  onBack: () => void; onEdit: () => void; onOpenOriginal: (id: string) => void; onOpenFresh: (entry: Entry) => void;
  onVisibilityChange: (visible: boolean) => void;
}) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), blockersHeading = useRef<HTMLHeadingElement>(null);
  const [confirmation, setConfirmation] = useState(''), [approved, setApproved] = useState(false);
  const [password, setPassword] = useState(true), [stopConfirmed, setStopConfirmed] = useState(false);
  const [, tick] = useState(0);
  const { review, result } = session;
  const disabled = busy || restartBusy(session);

  useEffect(() => { setConfirmation(''); setApproved(false); setStopConfirmed(false); }, [review?.reviewId, session.sourceId]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => tick(value => value + 1), Math.max(0, Math.min(2147483647, review.expiresAt - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [review]);
  const expired = !!review && Date.now() >= review.expiresAt;
  const requiresStop = !!review && restartNeedsStop(review);
  const noInstallation = session.reconciled && !setupWasExecuted(entry)
    && !entry.inspection?.nativePresent && !entry.inspection?.environment;
  const outcome = session.pending || !!result || !session.reconciled;
  const reviewBlocked = !!review && (!review.canReset || review.blockers.length > 0);
  const recheckSafety = !outcome && reviewBlocked && !requiresStop && !expired;
  const errorPresentation = restartErrorPresentation(session.error);
  useEffect(() => {
    if (!active) return;
    const target = reviewBlocked ? blockersHeading.current : heading.current;
    if (target && (target.closest('dialog')?.open ?? true)) target.focus();
  }, [active, review?.reviewId, reviewBlocked]);
  const blocker = restartApplyBlocker(entry, session, confirmation, approved);
  const nativePassword = entry.inspection?.uid === 0 ? false : password;
  const check = async () => { if (await setupRestarts.check(entry)) await setupRestarts.candidates(entry); };
  const authorization = <div className="restart-authorization">
    {entry.inspection?.uid === 0 ? <p>The current SSH account is root. Native confirmation is still specific to restart; installation approval is not reused.</p>
      : <label className="check-row" htmlFor={`${id}-sudo`}><input id={`${id}-sudo`} type="checkbox" checked={password} disabled={disabled}
        onChange={event => setPassword(event.target.checked)} /><span>Ask for the remote sudo password for restart in a protected native dialog.
          <small>This authorizes only the requested restart review, stop or removal. Uncheck only for appropriate passwordless sudo. No password is collected or saved here.</small></span></label>}
  </div>;
  let action;
  const fresh = result?.state === 'complete' ? result.entry : null;
  if (fresh) action = <button className="primary" disabled={disabled} onClick={() => onOpenFresh(fresh)}>Continue to new review</button>;
  else if (outcome) action = <button className="primary" disabled={disabled} onClick={() => void check()}>{session.busy === 'status' ? 'Checking restart outcome…' : 'Check restart outcome'}</button>;
  else if (noInstallation) action = <button className="primary" disabled={disabled} onClick={onEdit}>Start a new setup</button>;
  else if (review && requiresStop && !expired) action = <button className="danger" disabled={disabled || !stopConfirmed} onClick={() => void setupRestarts.stop(entry, nativePassword)}>Stop installation</button>;
  else if (review && !expired && review.canReset && !review.blockers.length) action = <button className="danger" disabled={disabled || !!blocker} onClick={() => void setupRestarts.apply(entry, confirmation, approved, nativePassword)}>Remove native installation & restart</button>;
  else action = <button className="primary" disabled={disabled || !session.sourceId || entry.phase === 'reset'} onClick={() => void setupRestarts.review(entry, nativePassword)}>{session.busy === 'review' ? 'Reviewing restart…' : recheckSafety ? 'Recheck safety checks' : 'Review restart'}</button>;

  return <ServerSetupPane label={entry.label} target={entry.target} status={{ label: session.busy ? 'Checking restart' : session.pending ? 'Restart outcome unconfirmed' : 'Restart review', tone: session.busy ? 'running' : 'warning' }}
    step={step} active={active} logs={entry.log} setupId={entry.id} operationId={review?.operationId ?? entry.installation?.operationId}
    fingerprint={entry.fingerprint} error={session.error} errorTitle={errorPresentation.title} errorTone={errorPresentation.tone}
    onVisibilityChange={onVisibilityChange} contentKey={`restart:${review?.reviewId ?? session.sourceId}`}
    note={session.pending ? 'Do not repeat removal or start an installation until the receipt is confirmed.' : 'Restart never reuses installation approval or starts installation automatically.'}
    footer={<><button className="text-button" onClick={onBack}>{session.pending || session.busy === 'apply' ? 'Close restart review' : 'Keep setup'}</button>{action}</>}>
    <div className="stage-intro"><h2 ref={heading} tabIndex={-1} className="stage-title">Restart setup on {entry.target.host}?</h2>
      <p>Review the original operation using this verified connection: {entry.target.user}@{entry.target.host.includes(':') ? `[${entry.target.host}]` : entry.target.host}:{entry.target.port}. Other servers stay independent.</p></div>
    {session.pending || result ? <div className={`notice ${result?.state === 'complete' ? 'positive' : 'warning'}`} role="status"><TriangleAlert className="icon" aria-hidden="true" /><div>
      <strong>{result?.state === 'complete' ? 'Native removal confirmed' : result?.state === 'failed' ? 'Restart needs recovery' : 'Restart outcome is not confirmed'}</strong>
      <p>{result?.message || 'The removal request is in progress. Closing this screen does not cancel it.'}</p>
      <p>Reset receipt: <code>{session.resetId}</code>. Original setup evidence is retained.</p>
    </div></div> : !session.reconciled ? <p className="quiet-note">Checking durable restart state is read-only. A failed check is not permission to repeat removal.</p> : noInstallation ? <div className="notice"><div>
      <strong>Start again without changing this server</strong><p>The saved connection details will be copied into a new editable form. Scan and verify the fingerprint again. Old inspection results, plans and approvals will not be reused; history is kept.</p>
    </div></div> : <>
      {reviewBlocked && <section className="notice warning restart-blockers" aria-labelledby={`${id}-blockers-title`}>
        <TriangleAlert className="icon" aria-hidden="true" /><div>
          <h3 id={`${id}-blockers-title`} ref={blockersHeading} tabIndex={-1} aria-describedby={`${id}-blockers-help`}>Removal blocked</h3>
          <p id={`${id}-blockers-help`}>This review did not remove files. Repeating authorization will not resolve these safety checks.</p>
          <ul>{review.blockers.length ? review.blockers.map((message, index) => <li key={index}>{message}</li>)
            : <li>Native ownership or inactivity could not be verified. Removal remains disabled.</li>}</ul>
          <p>Review this evidence with your server administrator. Rechecking is read-only and may ask for authorization again.</p>
        </div>
      </section>}
      <fieldset className="restart-candidates" disabled={disabled || !!review}><legend>Original installation</legend>
        {session.candidates === null ? <p>Reading local setup history, including archived operations…</p> : session.candidates.length === 0 ? <p>No matching original operation was found in local or archived history. Ownership is unknown; removal stays blocked. Use Activity &amp; diagnostics to inspect the evidence with your administrator.</p>
          : session.candidates.map(candidate => <div className="restart-candidate" key={candidate.id}><label className="radio-row">
            <input type="radio" name={`${id}-source`} checked={session.sourceId === candidate.id} onChange={() => setupRestarts.choose(entry, candidate.id)} />
            <span>{candidate.label}<small>{review?.sourceId === candidate.id ? review.state : candidate.state} · {review?.sourceId === candidate.id ? review.completedSteps : candidate.completedSteps}/{candidate.totalSteps} checks · <code>{candidate.operationId}</code></small></span>
          </label><button className="text-button" type="button" onClick={() => onOpenOriginal(candidate.id)}>Debug original setup</button></div>)}
      </fieldset>
      {!review && <p className="quiet-note">Choose the original operation explicitly if more than one matches. Review checks native ownership and inactivity; it does not remove files. After stopping, review again before removal.</p>}
      {review && <>
        <div className="notice negative"><TriangleAlert className="icon" aria-hidden="true" /><div><strong>Native Outpost data will be permanently erased.</strong>
          <p>This takes the native server offline and deletes its tasks, credentials, configuration and all data in the roots below. This cannot be undone. It is not a repair, migration or upgrade.</p></div></div>
        <dl className="change-list restart-scope">
          <div><dt>Delete these native roots and their contents</dt><dd>{review.paths.map(path => <code key={path}>{path}</code>)}</dd></div>
          <div><dt>Stop and remove these native services</dt><dd>{review.services.map(service => <code key={service}>{service}</code>)}</dd></div>
          <div><dt>Remove verified dedicated accounts / groups</dt><dd>{review.accounts.length ? review.accounts.map(account => <code key={account}>{account}</code>) : 'None reported by this review.'}</dd></div>
          <div><dt>Preserve</dt><dd>{review.preserved.map(value => <span key={value}>{value}</span>)}<span>Original operation evidence, SSH settings and keys, Tailscale, Kubernetes, Docker / legacy installations, shared OS packages and unrelated data are preserved.</span></dd></div>
          <div><dt>Bound original operation</dt><dd><code>{review.operationId}</code><code>{review.environmentId}</code><code>{review.releaseId}</code><span>{review.state} · {review.completedSteps}/{review.totalSteps} checks</span></dd></div>
        </dl>
        {review.warnings.map((warning, index) => <p className="quiet-note warning" key={index}>{warning}</p>)}

        {session.reviewBinding !== restartReviewBinding(entry) && <p className="quiet-note warning">Connection evidence or operation details changed. Refresh restart review before approving removal.</p>}
        {expired ? <p className="quiet-note warning">This restart review expired. Review again, retype the host and give new approval.</p>
          : requiresStop ? <div className="approval"><h3>Stop installation before removal</h3><p>The installer is active or inactivity is unconfirmed. Stop only this operation, then obtain a fresh review. Nothing can be deleted while it is busy.</p>
            <label className="check-row"><input type="checkbox" checked={stopConfirmed} disabled={disabled} onChange={event => setStopConfirmed(event.target.checked)} /><span>I request stopping this installation. Completed files remain until a separate removal is reviewed and approved.</span></label></div>
          : review.canReset && !review.blockers.length && <div className="approval restart-confirmation">
            <div className="field"><label htmlFor={`${id}-host`}>Type {review.host} to confirm the server</label><input id={`${id}-host`} autoComplete="off" spellCheck={false} value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} /></div>
            <label className="check-row" htmlFor={`${id}-approval`}><input id={`${id}-approval`} type="checkbox" checked={approved} disabled={disabled} onChange={event => setApproved(event.target.checked)} /><span>I approve permanently deleting this native Outpost installation and its data on {review.host}. I understand the server will go offline.</span></label>
            <p>A fresh trusted setup returns to Review. Choose capabilities and approve a new plan separately; no installation starts automatically.</p>
          </div>}
      </>}
      {!!session.sourceId && authorization}
      {review && !recheckSafety && <button className="text-button restart-refresh" disabled={disabled} onClick={() => void setupRestarts.review(entry, nativePassword)}>Refresh restart review</button>}
      {!review && session.candidates?.length === 0 && <button className="text-button" disabled={disabled} onClick={() => void setupRestarts.candidates(entry)}>Look up original setup again</button>}
    </>}
  </ServerSetupPane>;
}
