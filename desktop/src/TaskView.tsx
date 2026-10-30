import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  File,
  Globe,
  Paperclip,
  Pause,
  Play,
  Square,
  Terminal,
  Shield,
  AlertCircle,
} from "lucide-react";
import { call, recordedPreview, upload } from "./api";
import type { Connection } from "./useConnection";
import type { ServerRecord } from "./types";
import { Thinking, LiveTool } from "./LiveContent";
import { labelState, object, text, title } from "./types";

export function Artifact({
  record,
  connection,
}: {
  record: ServerRecord;
  connection: Connection;
}) {
  const [image, setImage] = useState(""),
    [saved, setSaved] = useState("");
  const png = text(record, "mime") === "image/png";
  useEffect(() => {
    let active = true;
    if (png && !recordedPreview())
      void call<string>("artifact", {
        id: record.id,
        hash: text(record, "hash"),
      })
        .then((data) => {
          if (active) setImage(`data:image/png;base64,${data}`);
        })
        .catch((error) => connection.setError(String(error)));
    return () => {
      active = false;
    };
  }, [record.id, png]);
  return (
    <div className="artifact">
      {image && (
        <a
          href={image}
          onClick={(event) => {
            event.preventDefault();
            void call<string>("save_artifact", {
              id: record.id,
              hash: text(record, "hash"),
              name: text(record, "name"),
            })
              .then(setSaved)
              .catch((error) => connection.setError(String(error)));
          }}
        >
          <img src={image} alt={`Browser evidence: ${text(record, "name")}`} />
        </a>
      )}
      <div className="artifact-row">
        <File size={15} />
        <span>{text(record, "name")}</span>
        <button
          className="icon-button"
          aria-label={`Download ${text(record, "name")}`}
          disabled={recordedPreview()}
          onClick={() =>
            void call<string>("save_artifact", {
              id: record.id,
              hash: text(record, "hash"),
              name: text(record, "name"),
            })
              .then(setSaved)
              .catch((error) => connection.setError(String(error)))
          }
        >
          <Download size={15} />
        </button>
      </div>
      {saved && <p className="small">Saved to {saved}</p>}
    </div>
  );
}

export function Action({
  record,
  connection,
}: {
  record: ServerRecord;
  connection: Connection;
}) {
  const result = object(record.data.result),
    args = object(record.data.arguments),
    state = text(record, "state");
  const failed =
    state === "unknown" ||
    state === "failed" ||
    (typeof result.exitCode === "number" && result.exitCode !== 0) ||
    result.agent_reported_success === false;
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
              disabled={connection.busy}
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
              disabled={connection.busy}
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
            disabled={connection.busy}
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

export default function TaskView({
  task,
  connection,
}: {
  task: ServerRecord;
  connection: Connection;
}) {
  const [reply, setReply] = useState(""),
    [tab, setTab] = useState<"conversation" | "evidence">("conversation");
  const followTail = useRef(true);
  const end = useRef<HTMLDivElement>(null),
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
    if (followTail.current)
      end.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [contentVersion, task.id]);
  const submit = async () => {
    if (!reply.trim()) return;
    const result = await connection.command(
      "task.steer",
      task.id,
      task.revision,
      { text: reply.trim() },
    );
    if (result) setReply("");
  };
  return (
    <section className="task-view">
      <header className="task-heading">
        <div>
          <h1>{title(task)}</h1>
          <p>
            {labelState(state)}
            {state === "running"
              ? connection.streaming
                ? " · Live stream"
                : " · Reconnecting stream"
              : ""}
            {text(task, "model") ? ` · ${text(task, "model")}` : ""}
          </p>
        </div>
        <div className="button-row">
          {policy && (
            <select
              aria-label="Task control mode"
              value={text(policy, "mode")}
              disabled={connection.busy || !connection.connected}
              onChange={(event) =>
                void connection.command(
                  "policy.change",
                  task.id,
                  policy.revision,
                  { mode: event.target.value },
                )
              }
            >
              <option value="full_control">Full control</option>
              <option value="auto">Auto review</option>
              <option value="ask_permission">Ask permission</option>
            </select>
          )}
          {!stopped && (
            <>
              <button
                className="icon-button"
                title={resumable ? "Resume task" : "Pause task"}
                aria-label={resumable ? "Resume task" : "Pause task"}
                disabled={connection.busy}
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
                disabled={connection.busy}
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
                  <span>
                    {text(message, "author") === "owner" ? "You" : "Outpost"}
                  </span>
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
            <div ref={end} />
          </div>
          <div className="reply-composer">
            <textarea
              aria-label="Message Outpost"
              placeholder="Give Outpost the next step…"
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
                disabled={connection.busy || !connection.connected}
                onClick={() => input.current?.click()}
              >
                <Paperclip size={16} />
              </button>
              <span className="small">Persistent workspace</span>
              <button
                className="send-button"
                aria-label="Send message"
                onClick={() => void submit()}
                disabled={
                  !reply.trim() ||
                  connection.busy ||
                  !connection.connected ||
                  stopped ||
                  connection.info?.pending
                }
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
        </div>
        <aside className="evidence-column">
          <div className="section-heading">
            <h2>Execution evidence</h2>
            <span>{actions.length} actions</span>
          </div>
          <p className="small evidence-intro">
            Actual commands, results and browser captures.
          </p>
          {liveTools.map((record) => (
            <LiveTool key={record.id} record={record} />
          ))}
          {actions.length === 0 && (
            <p className="empty-line">No actions executed yet.</p>
          )}
          {actions.map((action) => (
            <Action key={action.id} record={action} connection={connection} />
          ))}
          <div className="section-heading outputs-heading">
            <h2>Outputs</h2>
            <span>{artifacts.length}</span>
          </div>
          {artifacts.length === 0 && (
            <p className="empty-line">
              Files and screenshots will appear here.
            </p>
          )}
          {artifacts.map((artifact) => (
            <Artifact
              key={artifact.id}
              record={artifact}
              connection={connection}
            />
          ))}
        </aside>
      </div>
    </section>
  );
}
