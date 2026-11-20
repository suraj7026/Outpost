import { useRef, useState } from "react";
import { ChevronRight, Globe, Shield, SquareTerminal as Terminal } from "lucide-react";
import { recordedPreview } from "./api";
import { EvidenceTime } from "./LiveContent";
import OutcomeDot from "./OutcomeDot";
import { actionNeedsReview, object, text, type ServerRecord } from "./types";
import type { Connection } from "./useConnection";
import ActionReviewReason from './ActionReviewReason';
import { taskModeBlocker } from './control-mode';
import { unchangedReviewedAction } from './action-review';

export function ActionDecisions({ record, connection }: { record: ServerRecord; connection: Connection }) {
  const working = useRef(false);
  const [busy, setBusy] = useState(false), [attempted, setAttempted] = useState<number | null>(null), [error, setError] = useState('');
  const blocked = busy || attempted === record.revision || connection.retired || !!connection.info?.pendingError || connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const safety = taskModeBlocker(connection.records, text(record, 'taskId'), connection.runtime);
  const state = text(record, 'state');
  const decide = async (decision: 'approve' | 'deny') => {
    if (blocked || working.current || state !== 'pending' || decision === 'approve' && safety) return;
    if (!unchangedReviewedAction(record, connection.records.find(row => row.kind === 'action' && row.id === record.id))) return;
    working.current = true; setBusy(true); setAttempted(record.revision);
    try {
      const result = await connection.command('approval.decide', record.id, record.revision, { nonce: text(record, 'nonce'), actionDigest: text(record, 'actionDigest'), decision });
      if (!result || result.kind !== 'action' || result.id !== record.id || result.revision <= record.revision)
        setError('Could not confirm the outcome. Check server recovery before trying again.');
    } catch { setError('Could not confirm the outcome. Check server recovery before trying again.'); }
    finally { working.current = false; setBusy(false); }
  };
  return state === 'pending' ? <>
    <button type="button" className="action-deny" disabled={blocked} onClick={() => void decide('deny')}>Deny</button>
    <button type="button" className="primary" disabled={blocked || !!safety} title={safety || undefined} onClick={() => void decide('approve')}>Approve</button>
    {safety && <p className="small" role="status">{safety}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </> : null;
}

export function Action({
  record,
  connection,
  showDecisions = true,
}: {
  record: ServerRecord;
  connection: Connection;
  showDecisions?: boolean;
}) {
  const result = object(record.data.result),
    args = object(record.data.arguments),
    state = text(record, "state");
  const [open, setOpen] = useState(() => state === "pending");
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
            state === 'authorized' ? 'Queued' : state === 'dispatching' ? 'Running' : state
          )}
        </span>
      </summary>
      <div className="action-body">
        <p className="small">{text(record, "target")}</p>
        <pre>{JSON.stringify(record.data.arguments, null, 2)}</pre>
        <ActionReviewReason record={record} />
        {state === 'authorized' && !failed && <p className="small">Queued for automatic execution.</p>}
        {showDecisions && state === 'pending' && <div className="button-row"><ActionDecisions record={record} connection={connection} /></div>}
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
