import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, UIEvent } from 'react';
import { Check, ChevronRight, CircleAlert, CircleHelp, Clock3, FileText, GitBranch, LoaderCircle, Square, SquareTerminal } from 'lucide-react';
import { subagentCopyText, subagentDurationMs } from './model';
import type { SubagentActivity, SubagentRun, SubagentState } from './model';

export type RunView = 'activity' | 'result';
export const nativePolicy = 'Native subagent · Runs with server worker permissions';
const labels: Record<SubagentState, string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed',
  stopped: 'Stopped', partial: 'Partially completed', unknown: 'Outcome unknown',
};

export function runScope(run: SubagentRun): string {
  return JSON.stringify([run.taskId, run.parentToolId]);
}

export function isActive(run: SubagentRun): boolean {
  return run.state === 'queued' || run.state === 'running';
}

export function Status({ state, live = false, compact = false, cached = false }: { state: SubagentState; live?: boolean; compact?: boolean; cached?: boolean }) {
  const Icon = state === 'completed' ? Check : state === 'failed' || state === 'partial' ? CircleAlert
    : state === 'running' ? LoaderCircle : state === 'queued' ? Clock3 : state === 'stopped' ? Square : CircleHelp;
  const label = `${cached ? 'Last known: ' : ''}${labels[state]}`;
  return <span className="subagent-status" data-state={state} data-compact={compact && !cached} title={label}>
    <Icon size={15} aria-hidden="true" className={state === 'running' && live ? 'subagent-spin' : undefined} />
    <span>{label}</span>
  </span>;
}

/** Only observed, connected live runs may advance an elapsed-time estimate. */
export function useRunDuration(run: SubagentRun | null, connected: boolean, visible = true): string | undefined {
  const [now, setNow] = useState<number>();
  const ticking = !!run && isActive(run) && connected && visible && !run.legacy && !run.interrupted
    && run.startedAt !== undefined && run.endedAt === undefined;
  const scope = run ? runScope(run) : '';
  useEffect(() => {
    if (!ticking) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const updateVisibility = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [ticking, scope]);
  if (!run || (run.endedAt === undefined && !ticking)) return undefined;
  const duration = subagentDurationMs(run, now ?? Date.now());
  if (duration === undefined) return undefined;
  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

/** Invalidate pending clipboard promises on selection, visibility, or presentation changes. */
export function useRunCopy(scope: string, enabled = true) {
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    setNotice('');
    return () => { generation.current += 1; };
  }, [scope, enabled]);
  const copy = async (text: string, label: string) => {
    if (!enabled) return;
    const request = ++generation.current;
    setNotice('');
    try {
      await navigator.clipboard.writeText(text);
      if (generation.current === request) setNotice(label);
    } catch {
      if (generation.current === request) setNotice('Could not copy. Clipboard access is unavailable.');
    }
  };
  return { notice, copy };
}

export function runNotices(run: SubagentRun, connected: boolean): string[] {
  return [
    !connected && 'Offline · Showing recorded data. Current activity cannot be verified.',
    run.legacy && 'Older run · Detailed activity was not recorded.',
    run.interrupted && 'Observation was interrupted. This does not mean the subagent stopped.',
    run.state === 'unknown' && 'The outcome is unknown. No successful completion is confirmed.',
    run.state === 'partial' && 'Only a partial outcome is recorded. Full completion is not confirmed.',
    run.incomplete && 'Details are incomplete; some activity or results may be unavailable.',
    run.truncated && 'Recorded content was truncated. Some details are omitted.',
    isActive(run) && 'Individual stop is unavailable for native subagents.',
  ].filter((notice): notice is string => typeof notice === 'string');
}

export function Notices({ run, connected }: { run: SubagentRun; connected: boolean }) {
  const notices = runNotices(run, connected);
  return notices.length ? <div className="subagent-notices">{notices.map(notice => <p key={notice}>{notice}</p>)}</div> : null;
}

export function copyRun(run: SubagentRun, connected: boolean, summaryOnly = false): string {
  const body = summaryOnly
    ? [run.label, labels[run.state], run.model ? `Model: ${run.model}` : 'Model not recorded',
      run.summary || 'No summary recorded.',
      ...(run.files?.length ? ['Recorded files', ...run.files.map(file => [file.path, file.change].filter(Boolean).join(' — '))] : [])].join('\n\n')
    : [subagentCopyText(run),
      ...(run.children?.length ? ['Workflow children', ...run.children.map(child =>
        `${child.agent || child.id} — ${labels[child.state]} — ${child.model || 'Model not recorded'}`)] : [])].join('\n\n');
  return [body, ...runNotices(run, connected), nativePolicy].join('\n\n');
}

export function Result({ run }: { run: SubagentRun }) {
  return <div className="subagent-result">
    {run.summary?.trim() ? <p className="subagent-recorded-text">{run.summary}</p>
      : <p className="subagent-empty">No summary recorded{isActive(run) ? ' yet' : ''}.</p>}
    {!!run.files?.length && <section aria-label="Recorded files">
      <h3 className="subagent-section-title">Recorded files</h3>
      <ul className="subagent-file-list">{run.files.map((file, index) => <li key={`${index}:${file.path}`}>
        <FileText size={15} aria-hidden="true" /><span>{file.path}</span>
        {file.change && <span className="subagent-file-mark">{file.change}</span>}
      </li>)}</ul>
    </section>}
  </div>;
}

type ScrollPositions = MutableRefObject<Record<string, number>>;

function useSavedScroll<T extends HTMLElement>(positions: ScrollPositions, key: string, visible: boolean) {
  const ref = useRef<T>(null);
  const restoring = useRef(false);
  useLayoutEffect(() => {
    if (!visible) return;
    const position = positions.current[key] ?? 0;
    restoring.current = true;
    // A portaled dialog is still closed during its children's layout effects.
    // Restore after showModal, without letting the hidden layout erase the saved position.
    const frame = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = position;
      restoring.current = false;
    });
    return () => { cancelAnimationFrame(frame); restoring.current = false; };
  }, [positions, key, visible]);
  const onScroll = (event: UIEvent<T>) => {
    if (visible && !restoring.current && event.currentTarget.getClientRects().length) {
      positions.current[key] = event.currentTarget.scrollTop;
    }
  };
  return { ref, onScroll };
}

function RecordedText({ text, limit = 8192, positions, scrollKey, visible }: {
  text: string; limit?: number; positions: ScrollPositions; scrollKey: string; visible: boolean;
}) {
  const scroll = useSavedScroll<HTMLPreElement>(positions, scrollKey, visible);
  return <><pre tabIndex={0} {...scroll}>{text.slice(0, limit)}</pre>
    {text.length > limit && <p className="subagent-empty">Display truncated.</p>}</>;
}

function Tool({ item, open, onOpen, live, visible, positions }: {
  item: SubagentActivity; open: boolean; onOpen: (value: boolean) => void; live: boolean; visible: boolean; positions: ScrollPositions;
}) {
  return <details className="subagent-tool" open={open} data-state={item.state ?? 'unknown'}
    onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open !== open) onOpen(event.currentTarget.open); }}>
    <summary><ChevronRight size={13} className="subagent-disclosure" aria-hidden="true" />
      <SquareTerminal size={15} aria-hidden="true" /><span className="subagent-tool-title">{item.label || item.tool || 'Recorded tool'}</span>
      <Status state={item.state ?? 'unknown'} live={live} />
    </summary>
    <div className="subagent-tool-body">
      {item.text && <p className="subagent-recorded-text">{item.text}</p>}
      <h4 className="subagent-section-title">Recorded input</h4>
      {item.arguments !== undefined ? <RecordedText text={item.arguments} limit={4096} positions={positions} scrollKey={`input:${item.id}`} visible={visible && open} /> : <p className="subagent-empty">Input not recorded or withheld.</p>}
      <h4 className="subagent-section-title">Recorded output</h4>
      {item.output !== undefined ? <RecordedText text={item.output} positions={positions} scrollKey={`output:${item.id}`} visible={visible && open} /> : <p className="subagent-empty">Output not recorded or withheld.</p>}
    </div>
  </details>;
}

export interface SubagentContentProps {
  run: SubagentRun;
  connected: boolean;
  view: RunView;
  disclosures: Record<string, boolean>;
  onDisclosureChange: (key: string, open: boolean) => void;
  scrollPositions: ScrollPositions;
  visible: boolean;
}

export default function SubagentContent({ run, connected, view, disclosures, onDisclosureChange, scrollPositions, visible }: SubagentContentProps) {
  const scroll = useSavedScroll<HTMLDivElement>(scrollPositions, view, visible);
  const live = visible && connected && isActive(run) && !run.interrupted && !run.legacy;
  return <div className="subagent-run-scroll" {...scroll} tabIndex={0} aria-label={`${view === 'activity' ? 'Activity' : 'Result'} details`}>
    <Notices run={run} connected={connected} />
    {view === 'result' ? <Result run={run} /> : <div className="subagent-activity">
      <details className="subagent-assignment" open={disclosures.assignment ?? true}
        onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open !== (disclosures.assignment ?? true)) onDisclosureChange('assignment', event.currentTarget.open); }}>
        <summary><ChevronRight size={13} className="subagent-disclosure" aria-hidden="true" /><span>Assignment</span></summary>
        <div>{run.assignment ? <p className="subagent-recorded-text">{run.assignment}</p> : <p className="subagent-empty">Assignment not recorded.</p>}</div>
      </details>
      {!!run.children?.length && <section className="subagent-children" aria-label="Workflow children">
        <h3 className="subagent-section-title">Workflow children</h3>
        <ul>{run.children.map(child => <li key={child.id}>
          <GitBranch size={15} aria-hidden="true" /><div><span>{child.agent || child.id}</span><small>{child.model || 'Model not recorded'}</small></div>
          <Status state={child.state} live={live} />
        </li>)}</ul>
      </section>}
      <h3 className="subagent-section-title">Recorded activity</h3>
      {run.activity.length === 0 && <p className="subagent-empty">No activity recorded{isActive(run) ? ' yet' : ''}.</p>}
      {run.activity.map(item => item.kind === 'tool'
        ? <Tool key={item.id} item={item} live={live} visible={visible} positions={scrollPositions} open={disclosures[`tool:${item.id}`] ?? false}
          onOpen={open => onDisclosureChange(`tool:${item.id}`, open)} />
        : <div key={item.id} className={item.kind === 'notice' ? 'subagent-activity-notice' : 'subagent-run-message'}>
          <div className="subagent-run-author">{item.kind === 'notice' ? <CircleAlert size={15} aria-hidden="true" /> : <GitBranch size={15} aria-hidden="true" />}
            <span>{item.label || (item.kind === 'notice' ? 'Recorded notice' : run.agent || 'Subagent')}</span>
          </div>
          {item.text !== undefined ? <p className="subagent-recorded-text">{item.text}</p> : <p className="subagent-empty">Message content not recorded.</p>}
        </div>)}
    </div>}
  </div>;
}
