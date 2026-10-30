import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Code2,
  Globe,
  ClipboardList,
  Inbox,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Shield,
  Sparkles,
  FileText,
  ChevronDown,
  Search,
  Clock3,
  UserRound,
  Pin,
  PanelLeftClose,
} from "lucide-react";
import { call, nativeApp, recordedPreview } from "./api";
import { useConnection, type Connection } from "./useConnection";
import { labelState, object, text, title, type ServerRecord } from "./types";
import ConnectionSettings from "./ConnectionSettings";
import TaskView, { Action } from "./TaskView";
import Artifact from "./image-viewer/Artifact";
import { ImageViewerProvider } from "./image-viewer/ImageViewer";
import OutpostMark from "./OutpostMark";
import { preferredCloudModel } from "./models";
import { useAppearance, useMediaQuery } from "./appearance";
import { useSidebar } from "./useSidebar";

const navigation = [
  {
    id: "home",
    title: "Tasks",
    icon: "square.grid.2x2",
    glyph: ClipboardList,
  },
  {
    id: "decisions",
    title: "Approvals",
    icon: "checkmark.shield",
    glyph: Inbox,
  },
  { id: "servers", title: "Machines", icon: "server.rack", glyph: Server },
  { id: "outputs", title: "Library", icon: "doc.on.doc", glyph: FileText },
  { id: "automations", title: "Automations", icon: "clock", glyph: RefreshCw },
  {
    id: "memory",
    title: "Memory",
    icon: "square.stack.3d.up",
    glyph: Sparkles,
  },
];
const profileIcons = {
  code: Code2,
  browser: Globe,
  operations: Server,
  research: Globe,
  cowork: FileText,
  chat: MessageSquare,
};

import ModelPicker from './agent/ModelPicker';
import { chosenModel, type ModelRef } from './agent/types';

function Composer({
  connection,
  onCreated,
  initialProfile = "code",
}: {
  connection: Connection;
  onCreated: (id: string) => void;
  initialProfile?: string;
}) {
  const [goal, setGoal] = useState(""),
    [profile, setProfile] = useState(initialProfile),
    [model, setModel] = useState(""),
    [mode, setMode] = useState("full_control");
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const managed = !!connection.runtime?.piManagement;
  const selectedRef = chosenModel(connection.agentCatalogue, modelRef);
  const selectedModel = preferredCloudModel(connection.models, model, connection.runtime?.model ?? null);
  const modelReady = managed ? !!selectedRef : !!selectedModel;
  const submit = async () => {
    if (
      !goal.trim() ||
      !modelReady ||
      connection.busy ||
      !connection.connected ||
      connection.info?.pending
    )
      return;
    const id = crypto.randomUUID();
    const result = await connection.command("task.create", id, 0, {
      goal: goal.trim(),
      profile,
      mode,
      ...(managed && selectedRef ? { modelRef: { providerId: selectedRef.providerId, modelId: selectedRef.modelId } } : { model: selectedModel }),
    });
    if (result) {
      setGoal("");
      onCreated(id);
    }
  };
  return (
    <div className="new-work">
      <h1>What should run next?</h1>
      <div className="profile-tabs" role="group" aria-label="Task profile">
        {(["code", "browser", "operations", "research", "chat"] as const).map(
          (value) => {
            const Icon = profileIcons[value];
            return (
              <button
                aria-pressed={profile === value}
                key={value}
                onClick={() => setProfile(value)}
              >
                <Icon size={15} />
                {value === "code"
                  ? "Code"
                  : value[0].toUpperCase() + value.slice(1)}
              </button>
            );
          },
        )}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label="Task goal"
          autoFocus
          placeholder={
            profile === "operations"
              ? "Tell Outpost what to do across your servers…"
              : profile === "browser"
                ? "Describe what you want done in the browser…"
                : "Describe a change, a problem, or something to build…"
          }
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-toolbar">
          {managed ? <ModelPicker catalogue={connection.agentCatalogue} value={selectedRef} onChange={setModelRef} disabled={!connection.connected || connection.busy || !!connection.info?.pending} /> : <select
            aria-label="Ollama model"
            title="Cloud models advertised by your connected Ollama server"
            value={selectedModel}
            disabled={!connection.models.length}
            onChange={(event) => setModel(event.target.value)}
          >
            {!connection.models.length && <option value="">No cloud models available</option>}
            {connection.models.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>}
          <select
            aria-label="Control mode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="full_control">Full control</option>
            <option value="ask_permission">Ask permission</option>
            <option value="auto">Auto review</option>
          </select>
          <button
            type="submit"
            className="send-button"
            aria-label="Start task"
            disabled={
              !goal.trim() ||
              !modelReady ||
              !connection.connected ||
              connection.busy ||
              connection.info?.pending
            }
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
      <p className="composer-note">
        {managed && !selectedRef ? "Choose an available model. Manage server providers in Settings." : !managed && !connection.models.length ? "No cloud models returned by the connected Ollama server. Local models are not listed." : mode === "full_control"
          ? "Runs autonomously. Root commands on both hosts are available when enabled."
          : mode === "auto"
            ? "An independent reviewer is required; otherwise actions wait for your approval."
            : "Every tool action waits for your approval."}
      </p>
    </div>
  );
}

function RecentTasks({
  tasks,
  connection,
  select,
}: {
  tasks: ServerRecord[];
  connection: Connection;
  select: (id: string) => void;
}) {
  return (
    <section className="recent">
      <div className="section-heading">
        <h2>Recent sessions</h2>
        <span>
          {tasks.length} {tasks.length === 1 ? "session" : "sessions"}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="empty-line">
          Your first task starts here. Its conversation, actions and files stay
          together.
        </p>
      ) : (
        <div className="session-list">
          {tasks.slice(0, 8).map((task) => {
            const Icon =
              profileIcons[
                text(task, "profile") as keyof typeof profileIcons
              ] ?? MessageSquare;
            const actionCount = connection.records.filter(
              (record) =>
                record.kind === "action" && text(record, "taskId") === task.id,
            ).length;
            return (
              <button
                className="session-row"
                key={task.id}
                onClick={() => select(task.id)}
              >
                <Icon size={17} />
                <span className="session-title">
                  <strong>{title(task)}</strong>
                  <span>
                    {text(task, "profile")} · {actionCount} recorded actions
                  </span>
                </span>
                <span className={`state state-${text(task, "state")}`}>
                  {labelState(text(task, "state"))}
                </span>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Servers({
  connection,
  select,
}: {
  connection: Connection;
  select: (id: string) => void;
}) {
  const inspect = async () => {
    const id = crypto.randomUUID();
    const result = await connection.command("task.create", id, 0, {
      goal: "Read-only host inspection. Use host.execute on surajhomeserver and surajhomeserver2 to run: hostname; uptime; free -h; df -h /. Report the observed output. Do not change files, install software or restart anything.",
      profile: "operations",
      mode: "full_control",
    });
    if (result) select(id);
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Your servers</h1>
          <p>Two machines. One agent environment.</p>
        </div>
        <button
          className="primary"
          onClick={() => void inspect()}
          disabled={
            connection.busy ||
            !connection.connected ||
            !connection.runtime?.hostAdministration
          }
        >
          Run inspection <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="server-list">
        {["surajhomeserver", "surajhomeserver2"].map((host) => {
          const latest = connection.records
            .filter(
              (record) =>
                record.kind === "action" &&
                text(record, "tool") === "host.execute" &&
                object(record.data.arguments).host === host,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          return (
            <section className="server-row" key={host}>
              <Server size={23} />
              <div>
                <h2>{host}</h2>
                <p>
                  {host === "surajhomeserver"
                    ? "Control plane · Ollama · existing host services"
                    : "Pi workspace · Outpost runtime · self-hosted Chromium"}
                </p>
                <p className="small">
                  {connection.runtime?.hostAdministration
                    ? "Root executor enabled"
                    : "Root executor not configured"}
                </p>
              </div>
              <div className="server-observation">
                {latest ? (
                  <>
                    <span>Last recorded command</span>
                    <strong>
                      {object(latest.data.result).exitCode === 0
                        ? "Exit code 0"
                        : "Inspect result"}
                    </strong>
                    <time>{new Date(latest.updatedAt).toLocaleString()}</time>
                  </>
                ) : (
                  <span>No host commands recorded</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="inline-notice">
        These are recorded command results, not live host-health measurements.
        Run an inspection for current CPU, memory and storage information.
      </p>
      <h2 className="section-title">Execution environment</h2>
      <dl className="settings-list">
        <div>
          <dt>Agent runtime</dt>
          <dd>Pi SDK on Kubernetes</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{connection.runtime?.model ?? "Not configured"}</dd>
        </div>
        <div>
          <dt>Browser</dt>
          <dd>
            {connection.runtime?.browserUse
              ? "Browser-Use with local Chromium"
              : "Not configured"}
          </dd>
        </div>
        <div>
          <dt>Workspace commands</dt>
          <dd>
            {connection.runtime?.unrestrictedCommands
              ? "Unrestricted executables enabled"
              : "Enrolled executables only"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function App() {
  const connection = useConnection();
  const appearance = useAppearance();
  const narrow = useMediaQuery("(max-width: 780px)");
  const [selection, setSelection] = useState<string | null>(null),
    [searchOpen, setSearchOpen] = useState(false),
    [taskSearch, setTaskSearch] = useState("");
  const sidebar = useSidebar(appearance, narrow);
  const tasks = useMemo(
    () =>
      connection.records
        .filter((record) => record.kind === "task")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [connection.records],
  );
  useEffect(() => {
    if (selection === null && connection.connected) setSelection(tasks[0]?.id ?? "home");
  }, [selection, connection.connected, tasks]);
  const selectedTask = tasks.find((task) => task.id === selection);
  const pending = connection.records.filter(
    (record) => record.kind === "action" && text(record, "state") === "pending",
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") sidebar.dismiss();
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setSelection("home");
        sidebar.dismiss();
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Task goal"]')?.focus());
      }
      if (event.key.toLowerCase() === "b" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        sidebar.toggle();
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        sidebar.reveal(true);
        requestAnimationFrame(() => document.getElementById("task-search")?.focus());
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [sidebar.visible, sidebar.pinned, narrow]);
  const select = (id: string) => {
    setSelection(id);
    sidebar.dismiss();
  };
  const heading = selectedTask
    ? "Session"
    : selection === "connection"
      ? "Settings"
      : (navigation.find((item) => item.id === selection)?.title ??
        "Workspace");
  return (
    <ImageViewerProvider key={`${connection.info?.endpoint}:${connection.info?.deviceId}`} records={connection.records}>
    <div
      className={`app-shell web-shell ${nativeApp() && navigator.userAgent.includes("Macintosh") ? "desktop-window" : ""} ${narrow ? "sidebar-overlay" : "sidebar-push"} ${sidebar.present ? "sidebar-present" : ""} ${sidebar.visible ? "sidebar-visible" : "sidebar-hidden"}`}
    >
        {!sidebar.docked && <button className="sidebar-edge" aria-label="Show sidebar" aria-controls="app-sidebar" aria-expanded={sidebar.visible} onPointerEnter={() => { sidebar.enter(); sidebar.reveal(); }} onPointerLeave={sidebar.leave} onClick={() => sidebar.reveal(true)} onFocus={() => sidebar.reveal(true)} />}
        <aside className="web-sidebar" id="app-sidebar" ref={sidebar.panel} inert={!sidebar.visible} aria-hidden={!sidebar.visible} data-motion={sidebar.settled && sidebar.visible ? "open" : sidebar.visible ? "opening" : sidebar.present ? "closing" : "closed"} onPointerEnter={sidebar.enter} onPointerLeave={sidebar.leave} onPointerDownCapture={sidebar.pointerInteraction} onFocusCapture={sidebar.focus} onBlurCapture={() => requestAnimationFrame(sidebar.blur)}>
          <div className="sidebar-chrome" data-tauri-drag-region>
            <button className="icon-button" aria-label={sidebar.pinned ? "Collapse sidebar" : "Pin sidebar"} aria-controls="app-sidebar" title={sidebar.pinned ? "Collapse sidebar (⌘B)" : "Pin sidebar · keep open"} onClick={sidebar.pinned ? sidebar.close : sidebar.pin}>{sidebar.pinned ? <PanelLeftClose size={16} /> : <Pin size={15} />}</button>
          </div>
          <div className="brand" data-tauri-drag-region>
            <OutpostMark />
            <strong data-tauri-drag-region>Outpost</strong>
          </div>
          <button className="new-task-button" onClick={() => select("home")}>
            <Plus size={16} />
            New task <span className="shortcut">⌘ N</span>
          </button>
          <nav aria-label="Main navigation">
            {navigation.slice(0, 4).map((item) => (
              <button
                key={item.id}
                aria-current={selection === item.id || (item.id === "home" && selectedTask) ? "page" : undefined}
                onClick={() => select(item.id)}
              >
                <item.glyph size={16} />
                {item.title}
                {item.id === "decisions" && pending.length > 0 && (
                  <span className="nav-count">{pending.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-section"><span>Recent tasks</span><button className="icon-button" aria-label="Find a task" onClick={() => setSearchOpen(!searchOpen)}><Search size={14} /></button></div>
          {searchOpen && <input id="task-search" className="task-search" aria-label="Find a task" placeholder="Find a task…" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} autoFocus />}
          <div className="sidebar-sessions">
            {tasks.filter((task) => title(task).toLowerCase().includes(taskSearch.toLowerCase())).slice(0, 16).map((task) => (
              <button
                key={task.id}
                title={`${title(task)} · ${labelState(text(task, "state"))}`}
                aria-label={`${title(task)} · ${labelState(text(task, "state"))}`}
                aria-current={selection === task.id ? "page" : undefined}
                onClick={() => select(task.id)}
              >
                <span className="sidebar-task-top">{text(task, "state") === "completed" ? <Check size={13} /> : <Clock3 size={13} />}<span>{title(task)}</span></span>
                <span className="sidebar-task-meta"><span>{text(task, "profile") || "Task"}</span><time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time></span>
              </button>
            ))}
          </div>
          <details className="workspace-tools"><summary>Workspace tools <ChevronDown size={13} /></summary>{navigation.slice(4).map((item) => <button key={item.id} onClick={() => select(item.id)}><item.glyph size={15} />{item.title}</button>)}</details>
          <div className="sidebar-bottom">{sidebar.nativeError && <p role="status">{sidebar.nativeError}</p>}{recordedPreview() && <p>Recorded server preview</p>}
          <button
            className="connection-nav"
            aria-label="Connection settings"
            aria-current={selection === "connection" ? "page" : undefined}
            onClick={() => select("connection")}
          >
            <span className="profile-avatar"><UserRound size={14} /></span>
            <span>This Mac<small>Connection settings</small></span><ChevronDown size={13} />
          </button></div>
        </aside>
      <div className={`main-shell ${selectedTask ? "task-active" : ""}`} tabIndex={-1} onPointerDown={() => { if (!sidebar.docked) sidebar.dismiss(); }}>
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-leading">
            <span>{heading}</span>
          </div>
          <div className="topbar-status">
            <span
              className={`status-dot ${connection.connected ? "online" : ""}`}
            />
            <span>
              {recordedPreview()
                ? "Read-only snapshot"
                : connection.connected
                  ? "Private server connected"
                  : "Disconnected"}
            </span>
            <button
              className="icon-button"
              aria-label="Reconnect"
              title="Reconnect"
              onClick={() => void connection.connect()}
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="Open connection settings"
              onClick={() => select("connection")}
            >
              <Settings size={14} />
            </button>
          </div>
        </header>
        {connection.error && (
          <div className="connection-error" role="alert">
            <span>{connection.error}</span>
            <button onClick={() => void connection.connect()}>
              Retry connection
            </button>
          </div>
        )}
        {connection.info?.pending && (
          <div className="inline-notice pending-notice">
            A command has an unknown outcome. Retrying uses its original
            operation key.
            <button
              onClick={() =>
                void connection.perform(() => call("retry_command"))
              }
              disabled={connection.busy}
            >
              Retry same command
            </button>
          </div>
        )}
        {selectedTask ? (
          <TaskView
            key={selectedTask.id}
            task={selectedTask}
            connection={connection}
          />
        ) : selection === "home" || selection === null ? (
          <main className="home">
            <div className="home-content">
              <Composer connection={connection} onCreated={select} />
              <RecentTasks
                tasks={tasks}
                connection={connection}
                select={select}
              />
              <div className="home-footer">
                <Server size={14} />
                <span>surajhomeserver + surajhomeserver2</span>
                <button onClick={() => select("servers")}>
                  View servers <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
          </main>
        ) : selection === "connection" ? (
          <ConnectionSettings connection={connection} appearance={appearance} />
        ) : selection === "servers" ? (
          <Servers connection={connection} select={select} />
        ) : selection === "decisions" ? (
          <main className="page">
            <div className="page-heading">
              <div>
                <h1>Approvals</h1>
                <p>
                  {pending.length
                    ? `${pending.length} actions waiting for you.`
                    : "Nothing is waiting for approval."}
                </p>
              </div>
              <Shield size={22} />
            </div>
            {connection.records
              .filter(
                (record) =>
                  record.kind === "action" &&
                  ["pending", "authorized"].includes(text(record, "state")),
              )
              .map((record) => (
                <Action
                  key={record.id}
                  record={record}
                  connection={connection}
                />
              ))}
            {pending.length === 0 && (
              <p className="empty-line">
                Full-control tasks execute without individual approvals. Change
                a task’s mode to Ask Permission when you want to review each
                action.
              </p>
            )}
          </main>
        ) : selection === "outputs" ? (
          <main className="page">
            <div className="page-heading">
              <div>
                <h1>Outputs</h1>
                <p>Files, screenshots and results produced by your agent.</p>
              </div>
            </div>
            <div className="outputs-grid">
              {connection.records
                .filter((record) => record.kind === "artifact")
                .map((record) => (
                  <Artifact
                    key={record.id}
                    record={record}
                  />
                ))}
            </div>
            {!connection.records.some(
              (record) => record.kind === "artifact",
            ) && (
              <p className="empty-line">
                No outputs yet. Start a task to produce a file or browser
                capture.
              </p>
            )}
          </main>
        ) : (
          <main className="page">
            <div className="page-heading">
              <div>
                <h1>{heading}</h1>
                <p>
                  {selection === "memory"
                    ? "Notes recorded by your private workspace."
                    : "Schedules recorded by the server."}
                </p>
              </div>
            </div>
            {connection.records
              .filter(
                (record) =>
                  record.kind ===
                  (selection === "memory" ? "memory" : "automation"),
              )
              .map((record) => (
                <article className="record-row" key={record.id}>
                  <h2>{title(record)}</h2>
                  <pre>{JSON.stringify(record.data, null, 2)}</pre>
                </article>
              ))}
            {!connection.records.some(
              (record) =>
                record.kind ===
                (selection === "memory" ? "memory" : "automation"),
            ) && (
              <p className="empty-line">
                No {selection === "memory" ? "saved memories" : "automations"}{" "}
                yet.
              </p>
            )}
          </main>
        )}
        <footer className="statusbar">
          <span>
            {connection.busy
              ? "Sending to server…"
              : connection.connected
                ? "Server-owned history"
                : "Last-known history"}
          </span>
          <span>
            {connection.lastSync
              ? `Updated ${connection.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for connection"}
          </span>
        </footer>
      </div>
    </div>
    </ImageViewerProvider>
  );
}
