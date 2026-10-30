import "./live.css";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { ServerRecord } from "./types";
import { object, text } from "./types";

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
              if (event.currentTarget.open)
                panel.current?.scrollIntoView({ block: "nearest" });
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

export function LiveTool({ record }: { record: ServerRecord }) {
  const args = object(record.data.arguments);
  const name = typeof args.tool === "string" ? args.tool : text(record, "name");
  return (
    <details className="action live-tool" open>
      <summary>
        <Terminal size={15} />
        <span>{name || "Tool call"}</span>
        <span className="action-state">
          {record.data.interrupted ? "Interrupted" : text(record, "state")}
        </span>
      </summary>
      <div className="action-body">
        <pre>{JSON.stringify(args.arguments ?? args, null, 2)}</pre>
        {text(record, "output") && <pre>{text(record, "output")}</pre>}
      </div>
    </details>
  );
}
