import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, GitBranch, Maximize2, Minimize2, X } from 'lucide-react';
import type { SubagentRun } from './model';
import SubagentContent, { copyRun, isActive, nativePolicy, runScope, Status, useRunCopy, useRunDuration } from './SubagentContent';
import type { RunView } from './SubagentContent';
import './subagents.css';

export interface SubagentPanelProps {
  run: SubagentRun | null;
  connected: boolean;
  open: boolean;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  onClose: () => void;
}

export default function SubagentPanel(props: SubagentPanelProps) {
  return <RunPanel key={props.run ? runScope(props.run) : 'unavailable'} {...props} />;
}

function RunPanel({ run, connected, open, expanded, onExpandedChange, onClose }: SubagentPanelProps) {
  const [view, setView] = useState<RunView>('activity');
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>({});
  const scrollPositions = useRef<Record<string, number>>({ activity: 0, result: 0 });
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const wasModal = useRef(false);
  const titleId = useId();
  const duration = useRunDuration(run, connected, open);
  const modal = open && expanded;
  const { notice, copy } = useRunCopy(`${run ? runScope(run) : 'unavailable'}:${expanded}`, open && !!run);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (modal) {
      if (element && !element.open) element.showModal();
    } else {
      if (element?.open) element.close();
      // Final close focus belongs to the parent; only restore our own expand control.
      if (wasModal.current && open) expandButton.current?.focus({ preventScroll: true });
    }
    wasModal.current = modal;
  }, [modal, open]);
  useLayoutEffect(() => {
    const element = dialog.current;
    return () => { if (element?.open) element.close(); };
  }, []);

  const content = <>
    <header className="subagent-inspector-header">
      <span><GitBranch size={16} aria-hidden="true" />Subagent run</span>
      <div className="subagent-actions">
        <button type="button" className="subagent-icon-button" disabled={!run} aria-label="Copy run" title="Copy run"
          onClick={() => { if (run) void copy(copyRun(run, connected), 'Run copied'); }}><Copy size={16} aria-hidden="true" /></button>
        <button type="button" ref={expandButton} className="subagent-icon-button"
          onClick={() => onExpandedChange(!expanded)} aria-label={expanded ? 'Return to side panel' : 'Expand run'} title={expanded ? 'Return to side panel' : 'Expand run'}>
          {expanded ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="subagent-icon-button" onClick={() => expanded ? onExpandedChange(false) : onClose()} aria-label="Close subagent run" title="Close run"><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="subagent-run-heading"><h2 id={titleId}>{run ? run.label || run.agent || 'Subagent run' : 'Run unavailable'}</h2>
      {run && <div><span>{run.model || 'Model not recorded'}</span>
        <Status state={run.state} cached={!connected} live={open && connected && isActive(run) && !run.interrupted && !run.legacy} />
        {duration !== undefined && <span className="subagent-duration" title={run.endedAt === undefined ? 'Elapsed since recorded start' : 'Recorded duration'}>{duration}</span>}
      </div>}
    </div>
    {run ? <>
      <div className="subagent-run-toolbar">
        <div className="subagent-view-tabs" role="group" aria-label="Run view">
          <button type="button" aria-pressed={view === 'activity'} onClick={() => setView('activity')}>Activity</button>
          <button type="button" aria-pressed={view === 'result'} onClick={() => setView('result')}>Result</button>
        </div>
        <span className="subagent-tool-count">{run.activity.filter(item => item.kind === 'tool').length} recorded tool calls</span>
      </div>
      <SubagentContent run={run} connected={connected} view={view} disclosures={disclosures} scrollPositions={scrollPositions} visible={open}
        onDisclosureChange={(key, value) => setDisclosures(previous => ({ ...previous, [key]: value }))} />
    </> : <div className="subagent-run-scroll"><p className="subagent-empty">This run was removed or its recorded data is unavailable. No previous run details are shown.</p></div>}
    <footer className="subagent-inspector-footer"><span>{nativePolicy}</span><span className="subagent-copy-notice" role="status">{notice}</span></footer>
  </>;

  return <>
    <aside id="task-subagent-run" className="subagent-run-panel" hidden={!open || expanded} aria-label="Subagent run details"
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      {!modal && content}
    </aside>
    {typeof document !== 'undefined' && createPortal(<dialog ref={dialog} className="subagent-run-dialog" aria-label="Expanded subagent run" aria-labelledby={modal ? titleId : undefined}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onExpandedChange(false); }}>
      {modal && content}
    </dialog>, document.body)}
  </>;
}
