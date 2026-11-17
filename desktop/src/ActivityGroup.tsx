import { useContext, useState, type ReactNode } from 'react';
import { Check, ChevronRight, CircleAlert } from 'lucide-react';
import { ConversationDetailContext, ThinkingIndicator } from './conversation-detail';
import { activitySummary } from './activity-model';
import type { ServerRecord } from './types';
import './activity-group.css';

export default function ActivityGroup({ records, children }: { records: ServerRecord[]; children: ReactNode }) {
  const detail = useContext(ConversationDetailContext);
  const [choice, setChoice] = useState<{ detail: typeof detail; open?: boolean }>({ detail });
  const summary = activitySummary(records);
  const single = records.length === 1;
  const forced = single || summary.active || summary.attention;
  const preferred = choice.detail === detail ? choice.open : undefined;
  const open = forced || (preferred ?? (detail === 'extended' || !summary.complete));
  if (choice.detail !== detail) setChoice({ detail });
  const keepInspectedContent = () => setChoice({ detail, open: true });
  return <details className="activity-group" data-single={single} data-state={summary.attention ? 'attention' : summary.active ? 'active' : summary.complete ? 'complete' : 'waiting'}
    open={open} onToggle={event => {
      if (event.target !== event.currentTarget || event.currentTarget.open === open) return;
      if (forced) event.currentTarget.open = true;
      else setChoice({ detail, open: event.currentTarget.open });
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
