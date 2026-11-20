import { useState } from 'react';
import { ArrowUpRight, ChevronRight, Copy, Maximize2 } from 'lucide-react';
import type { SubagentRun } from './model';
import { copyRun, isActive, nativePolicy, Notices, Result, runScope, Status, useRunCopy, useRunDuration } from './SubagentContent';
import './subagents.css';

export interface SubagentCardProps {
  run: SubagentRun;
  connected: boolean;
  onOpen: (expanded: boolean, trigger: HTMLButtonElement) => void;
}

export default function SubagentCard(props: SubagentCardProps) {
  return <RunCard key={runScope(props.run)} {...props} />;
}

function RunCard({ run, connected, onOpen }: SubagentCardProps) {
  const [open, setOpen] = useState(false);
  const duration = useRunDuration(run, connected);
  const { notice, copy } = useRunCopy(runScope(run), open);
  const live = connected && isActive(run) && !run.interrupted && !run.legacy;
  return <details className="subagent-card" open={open} data-state={run.state}
    onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open !== open) setOpen(event.currentTarget.open); }}>
    <summary>
      <Status state={run.state} live={live} compact cached={!connected} />
      <span className="subagent-card-title">{run.label || run.agent || 'Subagent run'}
        <span className="subagent-card-model"> · {run.model || 'Model not recorded'}</span>
      </span>
      {duration !== undefined && <span className="subagent-card-duration" title={run.endedAt === undefined ? 'Elapsed since recorded start' : 'Recorded duration'}>{duration}</span>}
      <ChevronRight className="subagent-disclosure" size={15} aria-hidden="true" />
    </summary>
    <div className="subagent-card-body"><Notices run={run} connected={connected} /><Result run={run} />
      <p className="subagent-policy">{nativePolicy}</p>
    </div>
    <footer className="subagent-card-footer">
      <span className="subagent-copy-notice" role="status">{notice}</span>
      <div className="subagent-actions">
        <button type="button" className="subagent-icon-button" onClick={() => void copy(copyRun(run, connected, true), 'Summary copied')}
          aria-label="Copy summary" title="Copy summary"><Copy size={15} aria-hidden="true" /></button>
        <button type="button" className="subagent-open-run" onClick={event => onOpen(false, event.currentTarget)}>Open run<ArrowUpRight size={15} aria-hidden="true" /></button>
        <button type="button" className="subagent-icon-button" onClick={event => onOpen(true, event.currentTarget)}
          aria-label="Expand subagent run" title="Expand run"><Maximize2 size={15} aria-hidden="true" /></button>
      </div>
    </footer>
  </details>;
}
