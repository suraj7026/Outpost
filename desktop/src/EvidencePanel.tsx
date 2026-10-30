import type { ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, FileText, Shield, Terminal } from "lucide-react";
import type { ServerRecord } from "./types";
import { actionNeedsReview, labelState, object, text } from "./types";

export type EvidenceTab = "overview" | "changes" | "activity";
const tabs: EvidenceTab[] = ["overview", "changes", "activity"];

export default function EvidencePanel({ actions, artifactCount, tab, onTabChange, onReview, actionContent, liveContent, outputContent }: {
  actions: ServerRecord[];
  artifactCount: number;
  tab: EvidenceTab;
  onTabChange: (tab: EvidenceTab) => void;
  onReview: (action: ServerRecord) => void;
  actionContent: ReactNode;
  liveContent: ReactNode;
  outputContent: ReactNode;
}) {
  const proposed = actions.filter((action) => ["pending", "authorized"].includes(text(action, "state")));
  const change = (action: ServerRecord) => {
    const args = object(action.data.arguments);
    const path = typeof args.path === "string" ? args.path : text(action, "target");
    return (
      <div className="proposed-change" key={action.id}>
        <div className="change-file"><FileText size={13} /><span>{path || text(action, "tool")}</span></div>
        <pre>{JSON.stringify(args, null, 2)}</pre>
        <button onClick={() => onReview(action)}>Review exact action <ChevronRight size={13} /></button>
      </div>
    );
  };
  return (
    <>
      <div className="inspector-title"><h2 aria-label="Execution evidence">Evidence</h2></div>
      <div className="evidence-tabs" role="tablist" aria-label="Evidence views">
        {tabs.map((value, index) => (
          <button key={value} id={`evidence-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="evidence-panel" tabIndex={tab === value ? 0 : -1}
            onClick={() => onTabChange(value)} onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              onTabChange(tabs[next]);
              document.getElementById(`evidence-tab-${tabs[next]}`)?.focus();
            }}>
            {value === "overview" ? "Overview" : value === "changes" ? "Changes" : "Activity"}
          </button>
        ))}
      </div>
      <div id="evidence-panel" role="tabpanel" aria-labelledby={`evidence-tab-${tab}`} tabIndex={0}>
        {tab === "overview" && <>
          <div className="evidence-section-title"><h3>The handoff</h3><span>{actions.length} actions</span></div>
          <div className="handoff-spine">
            {actions.length === 0 && <p className="empty-line">No actions recorded yet.</p>}
            {actions.slice(-4).map((action) => {
              const state = text(action, "state");
              const failed = actionNeedsReview(action);
              return <button key={action.id} className={`handoff-step ${failed ? "failed" : state === "pending" ? "pending" : ""}`} onClick={() => onTabChange("activity")}>
                <span className="handoff-node">{failed ? <AlertCircle size={12} /> : state === "succeeded" ? <Check size={12} /> : state === "pending" ? <Clock3 size={12} /> : <Terminal size={12} />}</span>
                <span>{text(action, "tool").replaceAll(".", " ")}<small>{failed ? "Needs review" : labelState(state)}</small></span>
              </button>;
            })}
          </div>
          {liveContent}
          {proposed.length > 0 && <section className="evidence-section"><h3>Proposed change{proposed.length === 1 ? "" : "s"}</h3>{proposed.map(change)}</section>}
          <section className="evidence-section"><div className="evidence-section-title"><h3>Artifacts</h3><span>{artifactCount} {artifactCount === 1 ? "file" : "files"}</span></div>{outputContent}</section>
        </>}
        {tab === "changes" && <section className="evidence-section"><h3>Proposed actions</h3>{proposed.length ? proposed.map(change) : <p className="empty-line">No actions waiting for approval or dispatch.</p>}</section>}
        {tab === "activity" && <section className="evidence-section"><h3>Execution record</h3>{liveContent}{actionContent}</section>}
      </div>
      <p className="evidence-footer"><Shield size={13} /> Every action leaves a record.</p>
    </>
  );
}
