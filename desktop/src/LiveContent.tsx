import "./live.css";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { ServerRecord } from "./types";
import { object, text } from "./types";
import OutcomeDot from "./OutcomeDot";

export function Thinking({ message }: { message: ServerRecord }) {
  const thinking = text(message, "thinking");
  const active = message.data.streaming === true && !message.data.interrupted;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const panel = useRef<HTMLPreElement>(null),
    follow = useRef(true);
  const open = expanded ?? (active && !text(message, "text"));
  useEffect(() => {
    if (panel.current && follow.current)
      panel.current.scrollTop = panel.current.scrollHeight;
  }, [thinking.length]);
  return (
    <>
      {thinking && (
        <details
          className="thinking-block"
          open={open}
          onToggle={(event) => {
            if (event.currentTarget.open !== open) {
              setExpanded(event.currentTarget.open);
              const pane = event.currentTarget.closest<HTMLElement>(".conversation");
              if (event.currentTarget.open && pane) {
                const details = event.currentTarget.getBoundingClientRect();
                const viewport = pane.getBoundingClientRect();
                if (details.top < viewport.top) pane.scrollTop += details.top - viewport.top;
                else if (details.bottom > viewport.bottom)
                  pane.scrollTop += Math.min(details.bottom - viewport.bottom, details.top - viewport.top);
              }
            }
          }}
        >
          <summary>
            <ChevronRight size={13} />
            <span>
              {active && !text(message, "text") ? "Thinking…" : "Thinking"}
            </span>
            <span className="small">Model-provided reasoning</span>
          </summary>
          <pre
            ref={panel}
            onScroll={(event) => {
              const node = event.currentTarget;
              follow.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 60;
            }}
          >
            {thinking}
          </pre>
        </details>
      )}
      {active && !thinking && !text(message, "text") && (
        <p className="stream-placeholder">Waiting for model output…</p>
      )}
      {message.data.interrupted === true && (
        <p className="small">Interrupted · partial output retained</p>
      )}
      {text(message, "error") && (
        <p className="error-text">{text(message, "error")}</p>
      )}
      {message.data.outputTruncated === true && (
        <p className="small">
          Display limited to 128 KiB per text channel; full finalized context
          remains in the Pi session.
        </p>
      )}
    </>
  );
}

export function EvidenceTime({ record }: { record: ServerRecord }) {
  const date = new Date(record.updatedAt);
  return Number.isFinite(date.getTime()) ? <time className="action-time" dateTime={record.updatedAt} title={date.toISOString()}>
    {date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
  </time> : null;
}

export function LiveTool({ record }: { record: ServerRecord }) {
  const args = object(record.data.arguments);
  const name = typeof args.tool === "string" ? args.tool : text(record, "name");
  const state = record.data.interrupted ? 'interrupted' : text(record, 'state');
  const failed = state === 'error' || state === 'interrupted';
  const active = record.data.streaming === true && ['preparing', 'running'].includes(state);
  return (
    <details className={`action live-tool ${failed ? 'action-failed' : ''}`} data-record-id={record.id} data-state={state} open={active}>
      <summary>
        <ChevronRight size={13} className="disclosure" />
        <Terminal size={15} />
        <span>{name || "Tool call"}<EvidenceTime record={record} /></span>
        <span className="action-state">
          {failed || state === 'finished' ? <OutcomeDot failed={failed} label={state === 'error' ? 'Failed attempt' : state === 'interrupted' ? 'Interrupted' : 'Finished'} /> : state}
        </span>
      </summary>
      <div className="action-body">
        {failed && <p className="small">This attempt did not complete successfully. Separate later actions may have succeeded; each keeps its own result.</p>}
        <pre>{JSON.stringify(args.arguments ?? args, null, 2)}</pre>
        {text(record, "output") ? <pre>{text(record, "output")}</pre> : failed ? <p className="small">No additional error detail is available in this execution record.</p> : null}
      </div>
    </details>
  );
}
