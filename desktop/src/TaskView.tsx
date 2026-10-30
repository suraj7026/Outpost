import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Globe,
  Paperclip,
  Pause,
  Play,
  Square,
  Terminal,
  Shield,
  AlertCircle,
  UserRound,
  X,
} from "lucide-react";
import { call, recordedPreview, upload } from "./api";
import type { Connection } from "./useConnection";
import type { ServerRecord } from "./types";
import { Thinking, LiveTool } from "./LiveContent";
import OutpostMark from "./OutpostMark";
import EvidencePanel, { type EvidenceTab } from "./EvidencePanel";
import { actionNeedsReview, labelState, object, text, title } from "./types";

import Artifact from "./image-viewer/Artifact";

export function Action({
  record,
  connection,
}: {
  record: ServerRecord;
  connection: Connection;
}) {
  const mutationBlocked = connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const result = object(record.data.result),
    args = object(record.data.arguments),
    state = text(record, "state");
  const failed = actionNeedsReview(record);
  const warnings = Array.isArray(result.errors) ? result.errors.length : 0;
  const name = text(record, "tool");
  const label =
    name === "host.execute"
      ? `Root command on ${String(args.host)}`
      : name === "browser.run"
        ? "Browser task"
        : name === "command.run"
          ? "Workspace command"
          : name.replaceAll(".", " ");
  return (
    <details
      className={`action ${failed ? "action-failed" : ""}`}
      data-state={state}
      open={state === "pending" || state === "authorized"}
    >
      <summary>
        <ChevronRight size={13} className="disclosure" />
        {failed ? (
          <AlertCircle size={15} />
        ) : name === "browser.run" ? (
          <Globe size={15} />
        ) : name === "host.execute" ? (
          <Shield size={15} />
        ) : (
          <Terminal size={15} />
        )}
        <span>{label}</span>
        <span className="action-state">
          {failed ? (
            "Needs review"
          ) : state === "succeeded" ? (
            <><Check size={14} /><span className="sr-only">Succeeded</span></>
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

import ModelPicker from './agent/ModelPicker';
import { chosenModel, type ModelRef } from './agent/types';

export default function TaskView({
  task,
  connection,
}: {
  task: ServerRecord;
  connection: Connection;
}) {
  const [reply, setReply] = useState(""),
    [tab, setTab] = useState<"conversation" | "evidence">("conversation"),
    [evidenceTab, setEvidenceTab] = useState<EvidenceTab>("overview"),
    [reviewedAction, setReviewedAction] = useState<{ id: string; revision: number } | null>(null);
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const managed = !!connection.runtime?.piManagement;
  const initialModel = text(task, 'model') ? { providerId: text(task, 'provider') || 'outpost-ollama', modelId: text(task, 'model') } : null;
  const selectedRef = chosenModel(connection.agentCatalogue, modelRef, initialModel);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const mutationBlocked = connection.busy || !connection.connected || Boolean(connection.info?.pending) || recordedPreview();
  const followTail = useRef(true);
  const conversation = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const related = connection.records
    .filter((record) => text(record, "taskId") === task.id)
    .sort(
      (a, b) =>
        Number(a.data.startedAt ?? Date.parse(a.updatedAt)) -
        Number(b.data.startedAt ?? Date.parse(b.updatedAt)),
    );
  const messages = related.filter((record) => record.kind === "message"),
    actions = related.filter((record) => record.kind === "action"),
    artifacts = related.filter((record) => record.kind === "artifact");
  const pendingActions = actions.filter((action) => text(action, "state") === "pending");
  const reviewAction = (action: ServerRecord) => setReviewedAction({ id: action.id, revision: action.revision });
  const reviewing = actions.find((action) => action.id === reviewedAction?.id);
  useEffect(() => {
    if (reviewedAction && !reviewDialog.current?.open) reviewDialog.current?.showModal();
    if (!reviewedAction && reviewDialog.current?.open) reviewDialog.current.close();
  }, [reviewedAction]);
  const liveTools = related.filter(
    (record) =>
      record.kind === "tool_stream" &&
      !actions.some((action) => action.id === text(record, "actionId")),
  );
  const contentVersion = messages
    .map(
      (message) =>
        `${message.id}:${text(message, "text").length}:${text(message, "thinking").length}:${message.data.streaming}`,
    )
    .join("|");
  const policy = connection.records.find(
    (record) => record.kind === "policy" && record.id === task.id,
  );
  const state = text(task, "state"),
    stopped = ["cancelled", "completed"].includes(state),
    resumable = [
      "paused",
      "interrupted",
      "failed",
      "waiting_for_capacity",
    ].includes(state);
  useLayoutEffect(() => {
    const pane = conversation.current;
    if (pane && followTail.current) pane.scrollTop = pane.scrollHeight;
  }, [contentVersion, task.id, pendingActions.length]);
  const submit = async () => {
    if (!reply.trim() || stopped || mutationBlocked || (managed && !selectedRef)) return;
    const result = await connection.command(
      "task.steer",
      task.id,
      task.revision,
      { text: reply.trim(), ...(managed && selectedRef ? { modelRef: { providerId: selectedRef.providerId, modelId: selectedRef.modelId } } : {}) },
    );
    if (result) setReply("");
  };
  return (
    <section className="task-view">
      <header className="task-heading" data-tauri-drag-region>
        <div className="task-title" data-tauri-drag-region><span className="breadcrumb" data-tauri-drag-region>{text(task, "profile") || "Workspace"}</span><ChevronRight size={12} /><h1 data-tauri-drag-region>{title(task)}</h1></div>
        <div className="button-row">
          <span className={`task-status ${pendingActions.length ? "needs-review" : ""}`}><span className="status-dot" />{pendingActions.length ? "Needs your review" : labelState(state)}{state === "running" ? connection.streaming ? " · Live stream" : " · Reconnecting stream" : ""}</span>
          {pendingActions[0] && <button className="review-shortcut" onClick={() => reviewAction(pendingActions[0])}>Review</button>}
          {!stopped && (
            <>
              <button
                className="icon-button"
                title={resumable ? "Resume task" : "Pause task"}
                aria-label={resumable ? "Resume task" : "Pause task"}
                disabled={mutationBlocked}
                onClick={() =>
                  void connection.command(
                    resumable ? "task.resume" : "task.pause",
                    task.id,
                    task.revision,
                  )
                }
              >
                {resumable ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button
                className="icon-button"
                title="Cancel task"
                aria-label="Cancel task"
                disabled={mutationBlocked}
                onClick={() => {
                  if (
                    confirm(
                      "Cancel this task? Completed changes will not be undone.",
                    )
                  )
                    void connection.command(
                      "task.cancel",
                      task.id,
                      task.revision,
                    );
                }}
              >
                <Square size={15} />
              </button>
            </>
          )}
        </div>
      </header>
      <div className="mobile-tabs">
        <button
          aria-pressed={tab === "conversation"}
          onClick={() => setTab("conversation")}
        >
          Conversation
        </button>
        <button
          aria-pressed={tab === "evidence"}
          onClick={() => setTab("evidence")}
        >
          Evidence ({actions.length})
        </button>
      </div>
      <div className={`task-columns show-${tab}`}>
        <div className="conversation-column">
          <div
            className="conversation"
            ref={conversation}
            onScroll={(event) => {
              const node = event.currentTarget;
              followTail.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 100;
            }}
          >
            {messages.map((message) => (
              <article
                className={`message ${text(message, "author")}`}
                key={message.id}
              >
                <div className="message-byline">
                  {text(message, "author") === "owner" ? <span className="message-avatar"><UserRound size={14} /></span> : <OutpostMark />}
                  <span>
                    {text(message, "author") === "owner" ? "You" : "Outpost"}
                  </span>
                  {text(message, 'author') !== 'owner' && text(message, 'provider') && text(message, 'model') && <span className="message-model" title={`Response from ${text(message, 'provider')} · ${text(message, 'model')}`}>{text(message, 'provider')} · {text(message, 'model')}</span>}
                  {message.data.streaming === true && connection.streaming && (
                    <span className="stream-label">Streaming</span>
                  )}
                  <time>
                    {new Date(message.updatedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <Thinking message={message} />
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: () => null,
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => {
                          event.preventDefault();
                          if (href)
                            void call("open_url", { url: href }).catch(
                              (error) => connection.setError(String(error)),
                            );
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {text(message, "text")}
                </Markdown>
              </article>
            ))}
            {state === "running" && (
              <div className="working">
                <span className="status-dot" />
                Outpost is working. Executed actions appear in Evidence.
              </div>
            )}
            {text(task, "blocker") && state !== "verifying" && (
              <p className="inline-notice">{text(task, "blocker")}</p>
            )}
            {pendingActions[0] && (
              <div className="review-handoff">
                <div className="decision-heading"><Shield size={15} /><span>{pendingActions.length === 1 ? "One change. Your call." : `${pendingActions.length} actions need your review.`}</span><small>Ask permission</small></div>
                <h3>{text(pendingActions[0], "tool").replaceAll(".", " ")}</h3>
                <p>{text(pendingActions[0], "target") || "Review the exact arguments before approving."}</p>
                <div className="decision-bottom"><span>Nothing changes until you approve.</span><button className="primary" onClick={() => reviewAction(pendingActions[0])}>Review change <ChevronRight size={14} /></button></div>
              </div>
            )}
          </div>
          <div className="reply-composer">
            <textarea
              aria-label="Message Outpost"
              placeholder={stopped ? "This task is closed. Start a new task to continue." : "Ask a follow-up, or give Outpost the next step…"}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={stopped}
            />
            <div className="composer-toolbar">
              <input
                ref={input}
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file)
                    void connection.perform(() => upload(file, task.id));
                  event.target.value = "";
                }}
              />
              <button
                className="icon-button"
                aria-label="Attach file"
                disabled={mutationBlocked || stopped}
                onClick={() => input.current?.click()}
              >
                <Paperclip size={15} /><span>Attach</span>
              </button>
              {managed ? <ModelPicker catalogue={connection.agentCatalogue} value={selectedRef} onChange={setModelRef} disabled={mutationBlocked || stopped} /> : <span className="composer-model" title={text(task, "model") || connection.runtime?.model || "Server default"}>{text(task, "model") || connection.runtime?.model || "Server default"}</span>}
              {policy && <select aria-label="Task control mode" value={text(policy, "mode")} disabled={mutationBlocked} onChange={(event) => void connection.command("policy.change", task.id, policy.revision, { mode: event.target.value })}><option value="full_control">Full control</option><option value="auto">Auto review</option><option value="ask_permission">Ask permission</option></select>}
              <button
                className="send-button"
                aria-label="Send message"
                onClick={() => void submit()}
                disabled={
                  !reply.trim() || mutationBlocked || stopped || (managed && !selectedRef)
                }
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
        </div>
        <aside className="evidence-column" id="task-evidence" aria-label="Execution evidence">
          <EvidencePanel
            actions={actions}
            artifactCount={artifacts.length}
            tab={evidenceTab}
            onTabChange={setEvidenceTab}
            onReview={reviewAction}
            liveContent={<>{liveTools.map((record) => <LiveTool key={record.id} record={record} />)}</>}
            actionContent={<>
              {actions.length === 0 && liveTools.length === 0 && <p className="empty-line">No actions recorded yet.</p>}
              {actions.map((action) => <Action key={action.id} record={action} connection={connection} />)}
            </>}
            outputContent={<>
              {artifacts.length === 0 && <p className="empty-line">Files and screenshots will appear here.</p>}
              {artifacts.map((artifact) => <Artifact key={artifact.id} record={artifact} />)}
            </>}
          />
        </aside>
      </div>
      <dialog ref={reviewDialog} className="action-review-dialog" aria-labelledby="action-review-title" onClose={() => setReviewedAction(null)} onCancel={() => setReviewedAction(null)}>
        <div className="modal-top"><h2 id="action-review-title">Review the exact action</h2><button className="icon-button" aria-label="Close review" onClick={() => setReviewedAction(null)}><X size={18} /></button></div>
        <p>Approve only the displayed arguments. Completed changes cannot be undone here.</p>
        {reviewing && reviewing.revision === reviewedAction?.revision ? <Action record={reviewing} connection={connection} /> : <p role="status">The action has updated{reviewing ? `: ${labelState(text(reviewing, "state"))}` : ""}. Close this review to see its current state.</p>}
        {connection.error && <p className="error-text" role="alert">{connection.error}</p>}
        <div className="modal-actions"><button onClick={() => setReviewedAction(null)}>Close</button></div>
      </dialog>
    </section>
  );
}
