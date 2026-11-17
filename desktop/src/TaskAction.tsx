import { useState } from "react";
import { ChevronRight, Globe, Shield, SquareTerminal as Terminal } from "lucide-react";
import { recordedPreview } from "./api";
import { EvidenceTime } from "./LiveContent";
import OutcomeDot from "./OutcomeDot";
import { actionNeedsReview, object, text, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";

export function Action({
  record,
  connection,
}: {
  record: ServerRecord;
  connection: Connection;
}) {
  const mutationBlocked = connection.retired || !!connection.info?.pendingError || connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const result = object(record.data.result),
    args = object(record.data.arguments),
    state = text(record, "state");
  const [open, setOpen] = useState(() => state === "pending" || state === "authorized");
  const failed = actionNeedsReview(record);
  const warnings = Array.isArray(result.errors) ? result.errors.length : 0;
  const name = text(record, "tool");
  const label =
    name === "host.execute"
      ? `Root command on ${String(args.host)}`
      : name.startsWith("browser.")
        ? "Browser action"
        : name === "command.run"
          ? "Workspace command"
          : name.replaceAll(".", " ");
  return (
    <details
      className={`action ${failed ? "action-failed" : ""}`}
      data-state={state}
      data-record-id={record.id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={13} className="disclosure" />
        {name.startsWith("browser.") ? (
          <Globe size={15} />
        ) : name === "host.execute" ? (
          <Shield size={15} />
        ) : (
          <Terminal size={15} />
        )}
        <span>{label}<EvidenceTime record={record} /></span>
        <span className="action-state">
          {failed || state === 'succeeded' ? (
            <OutcomeDot failed={failed} label={failed ? 'Needs review' : 'Succeeded'} />
          ) : (
            state === 'dispatching' ? 'Running' : state
          )}
        </span>
      </summary>
      <div className="action-body">
        <p className="small">{text(record, "target")}</p>
        <pre>{JSON.stringify(record.data.arguments, null, 2)}</pre>
        {state === "pending" && (
          <div className="button-row">
            <button
              onClick={() =>
                void connection.command(
                  "approval.decide",
                  record.id,
                  record.revision,
                  {
                    nonce: text(record, "nonce"),
                    actionDigest: text(record, "actionDigest"),
                    decision: "approve",
                  },
                )
              }
              className="primary"
              disabled={mutationBlocked}
            >
              Approve
            </button>
            <button
              onClick={() =>
                void connection.command(
                  "approval.decide",
                  record.id,
                  record.revision,
                  {
                    nonce: text(record, "nonce"),
                    actionDigest: text(record, "actionDigest"),
                    decision: "deny",
                  },
                )
              }
              disabled={mutationBlocked}
            >
              Deny
            </button>
          </div>
        )}
        {state === "authorized" && (
          <button
            onClick={() =>
              void connection.command(
                "action.dispatch",
                record.id,
                record.revision,
              )
            }
            className="primary"
            disabled={mutationBlocked}
          >
            Run approved action
          </button>
        )}
        {typeof result.stdout === "string" && (
          <pre>{result.stdout || "(no output)"}</pre>
        )}
        {typeof result.stderr === "string" && result.stderr && (
          <pre className="error-text">{result.stderr}</pre>
        )}
        {typeof result.exitCode === "number" && (
          <p className="small">Exit code {result.exitCode}</p>
        )}
        {typeof result.result === "string" && <p>{result.result}</p>}
        {typeof result.error === "string" && (
          <p className="error-text">{result.error}</p>
        )}
        {typeof result.detail === "string" && <pre>{result.detail}</pre>}
        {warnings > 0 && (
          <p className="small">
            {warnings} browser action-format issue{warnings === 1 ? "" : "s"}{" "}
            recorded. See the JSON artifact for details.
          </p>
        )}
        {!("stdout" in result) &&
          !("result" in result) &&
          !("error" in result) &&
          Object.keys(result).length > 0 && (
            <pre>{JSON.stringify(result, null, 2)}</pre>
          )}
      </div>
    </details>
  );
}
