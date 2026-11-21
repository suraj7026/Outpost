import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, ChevronRight, CircleAlert, Copy, FileText, GitBranch, LoaderCircle, Maximize2, Minimize2, Square, SquareTerminal, X } from 'lucide-react';

type RunState = 'completed' | 'running' | 'failed' | 'stopped';
type RunTab = 'activity' | 'result';
const runTitle = 'Update navigation and approval regressions';
const model = 'GPT-6 Astra';
const files = ['desktop/tests/test-startup-navigation.mjs', 'desktop/tests/test-workspace-refinement.mjs'];
const assignment = 'Update only the navigation and approval regression tests. Replace the removed Approvals page with chat-based attention indicators, cover saved-page migration to All chats, and verify the exact-action review flow. Preserve the automation, memory, chat, and replica checks. Do not change production code or create commits. Report the validation results and any remaining issues.';
const outcome = {
  completed: { label: 'Completed', time: '1m 12s', summary: 'Updated the tests for chat-based approvals and verified that navigation, action review, and saved-page restoration still work.' },
  running: { label: 'Running', time: '18s', summary: 'The navigation checks passed. The subagent is checking the approval flow and stale-action guards.' },
  failed: { label: 'Needs attention', time: '47s', summary: 'The navigation checks passed, but an approval-flow assertion failed. The subagent returned the failure for review.' },
  stopped: { label: 'Stopped', time: '18s', summary: 'The subagent was stopped before verification completed. Its partial work and recorded activity are retained.' },
};

function StatusIcon({ state }: { state: RunState }) {
  return state === 'completed' ? <Check size={16} className="subagent-success" aria-hidden="true" />
    : state === 'running' ? <LoaderCircle size={16} className="subagent-spin" aria-hidden="true" />
    : state === 'failed' ? <CircleAlert size={16} className="subagent-failure" aria-hidden="true" />
    : <Square size={13} className="subagent-muted" aria-hidden="true" />;
}

function Result({ state }: { state: RunState }) {
  return <div className="subagent-result">
    <p>{outcome[state].summary}</p>
    <div className="subagent-section-title">Files changed</div>
    <ul className="subagent-file-list">{files.map(path => <li key={path}><FileText size={15} aria-hidden="true" /><span>{path}</span><span className="subagent-file-mark">M</span></li>)}</ul>
    <div className="subagent-section-title">Validation</div>
    <ul className="subagent-check-list">
      <li><Check size={15} className="subagent-success" aria-hidden="true" /><span><code>test-startup-navigation.mjs</code><small>51 scenarios · 436 assertions passed</small></span></li>
      <li><StatusIcon state={state} /><span><code>test-workspace-refinement.mjs</code><small>{state === 'completed' ? 'Passed' : state === 'running' ? 'Running approval-flow checks…' : state === 'failed' ? 'Failed · inspect the recorded output' : 'Not completed'}</small></span></li>
      {state === 'completed' && <li><Check size={15} className="subagent-success" aria-hidden="true" /><span><code>git diff --check</code><small>Passed</small></span></li>}
    </ul>
    <p className="subagent-result-note">{state === 'completed' ? 'No production changes. No commits. The parent agent can continue.' : state === 'running' ? 'The parent chat stays available while this subagent works.' : 'No automatic retry. Review the output before deciding what to do next.'}</p>
  </div>;
}

function ToolRow({ title, kind, state = 'completed', output, command }: { title: string; kind: 'read' | 'edit' | 'command'; state?: RunState; output: string; command?: string }) {
  return <details className="subagent-tool" data-state={state}>
    <summary><ChevronRight size={13} className="subagent-disclosure" aria-hidden="true" />{kind === 'command' ? <SquareTerminal size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}<span>{title}</span><StatusIcon state={state} /></summary>
    <div className="subagent-tool-body">
      {command && <><div className="subagent-tool-meta"><span>Command</span><span>desktop/</span></div><pre>{command}</pre></>}
      <div className="subagent-tool-meta"><span>{kind === 'command' ? 'Output' : 'Recorded result'}</span><span>{state === 'completed' ? 'Complete' : outcome[state].label}</span></div>
      <pre className={state === 'failed' ? 'subagent-error-output' : ''}>{output}</pre>
    </div>
  </details>;
}

function Activity({ state }: { state: RunState }) {
  return <div className="subagent-activity">
    <details className="subagent-assignment" open>
      <summary><ChevronRight size={13} className="subagent-disclosure" aria-hidden="true" /><span>Assignment</span><small>From parent</small></summary>
      <div><p>{assignment}</p><span className="subagent-assignment-scope">Tests only · 2 files · No commits</span></div>
    </details>
    <div className="subagent-run-message"><span className="subagent-run-author"><GitBranch size={15} aria-hidden="true" />Subagent</span><p>I’ll inspect the current navigation tests and review-dialog contract, update only the two test files, and run the targeted regressions.</p></div>
    <div className="subagent-section-title">Recorded activity</div>
    <ToolRow kind="read" title="Read navigation and approval tests" output={'desktop/tests/test-startup-navigation.mjs\ndesktop/tests/test-workspace-refinement.mjs\n\nRead the existing test cases and fixture setup.'} />
    <ToolRow kind="read" title="Read exact-action review contract" output={'desktop/src/ActionReviewDialog.tsx\ndesktop/src/startup-navigation.ts\n\nInspected revision, owner, and approval guards.'} />
    <ToolRow kind="edit" title="Update 2 regression test files" output={'Added stored Approvals → All chats migration coverage.\nReplaced the obsolete Approvals-page fixture with exact-action review.\nKept automation, memory, chat, and replica checks.'} />
    <ToolRow kind="command" title="Run startup navigation tests" command="node test-startup-navigation.mjs" output={'51 scenarios, 436 assertions passed.\nExit code 0'} />
    <ToolRow kind="command" title="Run workspace regression tests" state={state} command="node tests/test-workspace-refinement.mjs" output={state === 'completed' ? 'Workspace refinement checks passed.\nExit code 0' : state === 'running' ? 'Checking approval, dispatch, and stale-action handling…\nWaiting for the test process to finish.' : state === 'failed' ? 'AssertionError: expected the exact-action review dialog to be visible.\nExit code 1\n\nSample failure for this design preview.' : 'Run stopped before the test process completed.\nNo successful validation result recorded.'} />
    {state === 'completed' && <ToolRow kind="command" title="Check whitespace and patch formatting" command="git diff --check" output={'No whitespace errors.\nExit code 0'} />}
    <div className="subagent-run-message subagent-run-outcome"><span className="subagent-run-author"><StatusIcon state={state} />{state === 'completed' ? 'Returned to parent' : state === 'running' ? 'Working' : 'Partial result'}</span><p>{outcome[state].summary}</p></div>
  </div>;
}

function RunView({ state, tab, onTab, onClose, onExpand, expanded, onCopy, onStop, notice }: {
  state: RunState; tab: RunTab; onTab: (tab: RunTab) => void; onClose: () => void; onExpand: () => void; expanded: boolean; onCopy: () => void; onStop: () => void; notice: string;
}) {
  return <>
    <header className="subagent-inspector-header"><span><GitBranch size={16} aria-hidden="true" />Subagent run</span><div>
      <button type="button" className="subagent-icon-button" onClick={onCopy} aria-label="Copy run" title="Copy run"><Copy size={16} /></button>
      <button type="button" className="subagent-icon-button" onClick={onExpand} aria-label={expanded ? 'Return to side panel' : 'Expand run'} title={expanded ? 'Return to side panel' : 'Expand run'}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button type="button" className="subagent-icon-button" onClick={onClose} aria-label={expanded ? 'Close expanded run' : 'Close subagent run'} title="Close run"><X size={17} /></button>
    </div></header>
    <div className="subagent-run-heading"><h2>{runTitle}</h2><div><span>{model}</span><span className="subagent-status" data-state={state}><StatusIcon state={state} />{outcome[state].label}</span><span>{outcome[state].time}</span></div></div>
    <div className="subagent-run-toolbar"><div className="subagent-view-tabs" role="group" aria-label="Run view"><button type="button" aria-pressed={tab === 'activity'} onClick={() => onTab('activity')}>Activity</button><button type="button" aria-pressed={tab === 'result'} onClick={() => onTab('result')}>Result</button></div><span className="subagent-tool-count">{state === 'completed' ? '6' : '5'} tool calls</span>{state === 'running' && <button type="button" className="subagent-stop" onClick={onStop}><Square size={12} />Stop subagent</button>}</div>
    <div className="subagent-run-scroll">{tab === 'activity' ? <Activity state={state} /> : <Result state={state} />}</div>
    <footer className="subagent-inspector-footer"><span role="status">{notice || 'Sample run · No commands are executed'}</span><span>{state === 'completed' ? 'Returned to parent' : state === 'running' ? 'Previewing live activity' : 'Partial work retained'}</span></footer>
  </>;
}

export default function SubagentDemo({ columns, footer }: { columns: HTMLElement; footer: HTMLElement }) {
  const [state, setState] = useState<RunState>('completed');
  const [open, setOpen] = useState(false);
  const [inspect, setInspect] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<RunTab>('activity');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cardSummary = useRef<HTMLElement>(null);
  useEffect(() => {
    document.body.dataset.subagentState = state;
    (window as Window & { __subagentPreview: { setStatus: (value: string) => void } }).__subagentPreview.setStatus(state);
  }, [state]);
  useEffect(() => {
    columns.classList.toggle('subagent-inspector-open', inspect && !expanded);
    return () => columns.classList.remove('subagent-inspector-open');
  }, [columns, inspect, expanded]);
  useEffect(() => {
    if (!expanded) return;
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      requestAnimationFrame(() => {
        const target = previous instanceof HTMLElement && previous.isConnected ? previous : document.querySelector<HTMLElement>('.subagent-run-panel button[aria-label="Expand run"]') ?? cardSummary.current;
        target?.focus({ preventScroll: true });
      });
    };
  }, [expanded]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2800);
    return () => clearTimeout(timer);
  }, [notice]);
  const close = () => {
    setExpanded(false); setInspect(false);
    requestAnimationFrame(() => (trigger.current?.getClientRects().length ? trigger.current : cardSummary.current)?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    if (!inspect || expanded) return;
    const toggle = document.querySelector<HTMLButtonElement>('.task-workspace-toggle');
    const previous = toggle ? { label: toggle.getAttribute('aria-label'), title: toggle.title, expanded: toggle.getAttribute('aria-expanded') } : undefined;
    toggle?.setAttribute('aria-label', 'Close subagent panel');
    toggle?.setAttribute('aria-expanded', 'true');
    if (toggle) toggle.title = 'Close subagent panel';
    const intercept = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.task-workspace-toggle, button[aria-label="Files, changes and browser"]')) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    };
    document.addEventListener('click', intercept, true);
    return () => {
      document.removeEventListener('click', intercept, true);
      if (toggle && previous) { toggle.setAttribute('aria-label', previous.label ?? 'Open workspace'); toggle.setAttribute('aria-expanded', previous.expanded ?? 'false'); toggle.title = previous.title; }
    };
  }, [inspect, expanded]);
  const openRun = (full = false) => {
    if (columns.classList.contains('workspace-open')) document.querySelector<HTMLButtonElement>('.task-workspace-toggle')?.click();
    setInspect(true); setExpanded(full);
  };
  const copy = async (full = false) => {
    const value = `${runTitle}\n${model} · ${outcome[state].label}\n\n${full ? `Assignment\n${assignment}\n\n` : ''}${outcome[state].summary}\n\nFiles changed\n${files.join('\n')}\n\n${state === 'completed' ? '51 startup scenarios, 436 assertions passed.\nWorkspace regression checks passed.\nNo production changes. No commits.' : 'Validation is incomplete.'}`;
    try { await navigator.clipboard.writeText(value); setNotice(full ? 'Run copied' : 'Summary copied'); }
    catch { setNotice('Clipboard unavailable in this browser'); }
  };
  const runProps = { state, tab, onTab: setTab, onClose: close, onExpand: () => setExpanded(value => !value), expanded, onCopy: () => void copy(true), onStop: () => setState('stopped'), notice };
  return <>
    <details className="subagent-card" open={open} data-state={state} onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open !== open) setOpen(event.currentTarget.open); }}>
      <summary ref={cardSummary}><StatusIcon state={state} /><span className="subagent-card-title">{runTitle}<span className="subagent-card-model"> · {model}</span></span><span className="subagent-card-duration">{outcome[state].time}</span><ChevronRight className="subagent-disclosure" size={15} aria-hidden="true" /></summary>
      <div className="subagent-card-body"><Result state={state} /></div>
      <footer className="subagent-card-footer"><span className="subagent-status" data-state={state}><StatusIcon state={state} />{outcome[state].label}</span><span className="subagent-card-notice" role="status">{notice}</span><div><button type="button" className="subagent-icon-button" onClick={() => void copy()} aria-label="Copy summary" title="Copy summary"><Copy size={15} /></button><button type="button" ref={trigger} className="subagent-open-run" onClick={() => openRun()}>Open run<ArrowUpRight size={15} aria-hidden="true" /></button><button type="button" className="subagent-icon-button" onClick={() => openRun(true)} aria-label="Expand subagent run" title="Expand run"><Maximize2 size={15} /></button></div></footer>
    </details>
    {inspect && !expanded && createPortal(<aside className="subagent-run-panel" aria-label="Subagent run details" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}><RunView {...runProps} /></aside>, columns)}
    {expanded && createPortal(<dialog ref={dialog} className="subagent-run-dialog" aria-label="Expanded subagent run" onCancel={event => { event.preventDefault(); setExpanded(false); }}><RunView {...runProps} onClose={() => setExpanded(false)} /></dialog>, document.body)}
    {createPortal(<div className="subagent-demo-controls"><strong>Subagent design preview</strong><label>Preview state<select aria-label="Preview subagent state" value={state} onChange={event => setState(event.target.value as RunState)}><option value="completed">Completed</option><option value="running">Running</option><option value="failed">Needs attention</option><option value="stopped">Stopped</option></select></label><p>Sample activity only.<br />No real subagent is started.</p></div>, footer)}
  </>;
}
