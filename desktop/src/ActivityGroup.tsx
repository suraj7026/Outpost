import { useContext, useState, type ReactNode } from 'react';
import { Check, ChevronRight, CircleAlert } from 'lucide-react';
import { ConversationDetailContext, ThinkingIndicator, type ConversationDetail, type ExecutionViewState } from './conversation-detail';
import { activitySummary } from './activity-model';
import type { ServerRecord } from './types';
import './activity-group.css';

export interface ActivityGroupMemory {
  choice?: { detail: ConversationDetail; open?: boolean };
}

export default function ActivityGroup({ records, children, memory, rowStates }: {
  records: ServerRecord[]; children: ReactNode; memory: ActivityGroupMemory; rowStates: ExecutionViewState[];
}) {
  const detail = useContext(ConversationDetailContext);
  const [choice, setChoice] = useState(() => memory.choice ?? { detail });
  const choose = (open?: boolean) => {
    const next = { detail, open };
    memory.choice = next;
    for (const row of rowStates) row.inspectedDetail = open ? detail : undefined;
    setChoice(next);
  };
  if (choice.detail !== detail) choose();
  const summary = activitySummary(records);
  const single = records.length === 1;
  const forced = single || summary.active || summary.attention;
  const preferred = choice.detail === detail ? choice.open : undefined;
  const inspected = rowStates.some(row => row.inspectedDetail === detail);
  const open = forced || inspected || (preferred ?? (detail === 'extended' || !summary.complete));
  const keepInspectedContent = () => choose(true);
  return <details className="activity-group" data-single={single} data-state={summary.attention ? 'attention' : summary.active ? 'active' : summary.complete ? 'complete' : 'waiting'}
    open={open} onToggle={event => {
      if (event.target !== event.currentTarget || event.currentTarget.open === open) return;
      if (forced) event.currentTarget.open = true;
      else choose(event.currentTarget.open);
    }}>
    <summary className="activity-group-summary" hidden={single} aria-disabled={forced || undefined}
      onClick={event => { if (forced) event.preventDefault(); }}>
      <ChevronRight size={13} className="disclosure" aria-hidden="true" />
      {summary.attention ? <CircleAlert size={15} className="activity-attention" aria-hidden="true" />
        : summary.active ? <ThinkingIndicator active />
          : summary.complete ? <Check size={15} className="activity-complete" aria-hidden="true" /> : null}
      <span className="activity-group-title">{summary.label}</span>
      {!summary.complete && <span className="activity-group-progress">{summary.completed} of {records.length} actions complete</span>}
    </summary>
    <div className="activity-stack" onPointerDownCapture={keepInspectedContent} onFocusCapture={keepInspectedContent}>
      {children}
    </div>
  </details>;
}
