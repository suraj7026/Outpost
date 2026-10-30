import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  Code2,
  Globe,
  LayoutGrid,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Shield,
  Sparkles,
  X,
  FileText,
} from "lucide-react";
import { call, nativeApp, recordedPreview } from "./api";
import { useConnection, type Connection } from "./useConnection";
import { labelState, object, text, title, type ServerRecord } from "./types";
import ConnectionSettings from "./ConnectionSettings";
import TaskView, { Action, Artifact } from "./TaskView";

const navigation = [
  {
    id: "home",
    title: "Workspace",
    icon: "square.grid.2x2",
    glyph: LayoutGrid,
  },
  {
    id: "decisions",
    title: "Decisions",
    icon: "checkmark.shield",
    glyph: Shield,
  },
  { id: "outputs", title: "Outputs", icon: "doc.on.doc", glyph: FileText },
  { id: "servers", title: "Servers", icon: "server.rack", glyph: Server },
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
  const submit = async () => {
    if (
      !goal.trim() ||
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
      ...(model ? { model } : {}),
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
          <select
            aria-label="Ollama model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">
              {connection.runtime?.model ?? "Server default model"}
            </option>
            {connection.models
              .filter((name) => name !== connection.runtime?.model)
              .map((name) => (
                <option key={name}>{name}</option>
              ))}
          </select>
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
        {mode === "full_control"
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
  const [selection, setSelection] = useState("home"),
    [mobileMenu, setMobileMenu] = useState(false);
  const tasks = useMemo(
    () =>
      connection.records
        .filter((record) => record.kind === "task")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [connection.records],
  );
  const selectedTask = tasks.find((task) => task.id === selection);
  const nativeSidebar = connection.info?.nativeSidebar ?? nativeApp();
  const pending = connection.records.filter(
    (record) => record.kind === "action" && text(record, "state") === "pending",
  );
  const sidebarItems = [
    { id: "brand", title: "Outpost", icon: "", kind: "section" },
    ...navigation.map((item) => ({
      id: item.id,
      title:
        item.id === "decisions" && pending.length
          ? `Decisions (${pending.length})`
          : item.title,
      icon: item.icon,
      kind: "navigation",
    })),
    {
      id: "recent-section",
      title: "Recent sessions",
      icon: "",
      kind: "section",
    },
    ...tasks.slice(0, 16).map((task) => ({
      id: task.id,
      title: title(task),
      icon:
        text(task, "profile") === "code"
          ? "chevron.left.forwardslash.chevron.right"
          : "text.bubble",
      kind: "task",
    })),
    {
      id: "device-section",
      title: "Your workspace",
      icon: "",
      kind: "section",
    },
    {
      id: "connection",
      title: "Connection",
      icon: "network",
      kind: "navigation",
    },
  ];
  const sidebarJSON = JSON.stringify(sidebarItems);
  useEffect(() => {
    if (nativeApp())
      void call("update_sidebar", {
        items: JSON.parse(sidebarJSON) as unknown,
        selected: selection,
      }).catch((error) => connection.setError(String(error)));
  }, [sidebarJSON, selection]);
  useEffect(() => {
    if (!nativeApp()) return;
    const listener = listen<string>("outpost:navigate", (event) =>
      setSelection(event.payload),
    );
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, []);
  const select = (id: string) => {
    setSelection(id);
    setMobileMenu(false);
  };
  const heading = selectedTask
    ? "Session"
    : selection === "connection"
      ? "Connection"
      : (navigation.find((item) => item.id === selection)?.title ??
        "Workspace");
  return (
    <div
      className={`app-shell ${nativeSidebar ? "native-shell" : "web-shell"} ${mobileMenu ? "menu-open" : ""}`}
    >
      {!nativeSidebar && (
        <aside className="web-sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <strong>Outpost</strong>
          </div>
          <button className="new-task-button" onClick={() => select("home")}>
            <Plus size={16} />
            New task
          </button>
          <nav aria-label="Main navigation">
            {navigation.map((item) => (
              <button
                key={item.id}
                aria-current={selection === item.id ? "page" : undefined}
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
          <p className="nav-section-label">Recent sessions</p>
          <div className="sidebar-sessions">
            {tasks.slice(0, 16).map((task) => (
              <button
                key={task.id}
                aria-current={selection === task.id ? "page" : undefined}
                onClick={() => select(task.id)}
              >
                <MessageSquare size={14} />
                <span>{title(task)}</span>
              </button>
            ))}
          </div>
          <button
            className="connection-nav"
            aria-current={selection === "connection" ? "page" : undefined}
            onClick={() => select("connection")}
          >
            <Settings size={16} />
            Connection
          </button>
        </aside>
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="mobile-menu icon-button"
              aria-label="Toggle navigation"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              {mobileMenu ? <X size={17} /> : <Menu size={17} />}
            </button>
            <span>{heading}</span>
          </div>
          <div className="topbar-status">
            <span
              className={`status-dot ${connection.connected ? "online" : ""}`}
            />
            <span>
              {recordedPreview()
                ? "Recorded server preview"
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
              aria-label="Connection settings"
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
        ) : selection === "home" ? (
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
          <ConnectionSettings connection={connection} />
        ) : selection === "servers" ? (
          <Servers connection={connection} select={select} />
        ) : selection === "decisions" ? (
          <main className="page">
            <div className="page-heading">
              <div>
                <h1>Decisions</h1>
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
                    connection={connection}
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
  );
}
