import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowUp,
  ArrowUpRight,
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
  NotebookPen,
  CalendarClock,
  ShieldCheck,
  FileText,
  Search,
  Pin,
  PanelLeftClose,
  SquareTerminal,
} from "lucide-react";
import { nativeApp, recordedPreview } from "./api";
import type { Connection } from "./useConnection";
import { labelState, text, title, type ServerRecord } from "./types";
import { SidebarHistory, type ChatGroup, type OpenChat } from "./ChatHistory";
import TaskView from "./TaskView";
import Machines from "./server-terminal/Machines";
import { retainTerminals } from "./server-terminal/controller";
import { ImageViewerProvider } from "./image-viewer/ImageViewer";

import { preferredCloudModel } from "./models";
import { useAppearance, useMediaQuery, type Appearance } from "./appearance";
import { ConversationDetailContext } from './conversation-detail';
import { useSidebar } from "./useSidebar";
import ComposerContext from "./ComposerContext";
import { ControlMode, ComposerModelSelect } from './ComposerControls';
import TerminalPane from './server-terminal/TerminalPane';
import WorkspaceView, { isApproval, isWorkspaceSection } from "./WorkspaceViews";

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
    glyph: ShieldCheck,
  },
  { id: "machines", title: "Machines", icon: "server.rack", glyph: Server },
  { id: "outputs", title: "Library", icon: "doc.on.doc", glyph: FileText },
  { id: "automations", title: "Automations", icon: "clock", glyph: CalendarClock },
  {
    id: "memory",
    title: "Memory",
    icon: "square.stack.3d.up",
    glyph: NotebookPen,
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
  contextBar,
}: {
  contextBar: ReactNode;
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
      connection.info?.pending || connection.retired || !!connection.info?.pendingError
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
      <h1 className="sr-only">New task</h1>
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
      <div className="composer-stack">
      {contextBar}
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
                : profile === "chat" ? "Describe what you want to talk through…"
                  : profile === "research" ? "Describe what to investigate or summarize…"
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
          <ControlMode label="Control mode" value={mode} onChange={(event) => setMode(event.target.value)} />
          <div className="composer-model-control">
          {managed ? <ModelPicker catalogue={connection.agentCatalogue} value={selectedRef} onChange={setModelRef} disabled={!connection.connected || connection.busy || !!connection.info?.pending || connection.retired || !!connection.info?.pendingError} /> : <ComposerModelSelect
            aria-label="Ollama model"
            title="Cloud models advertised by your connected Ollama server"
            value={selectedModel}
            disabled={!connection.models.length}
            onChange={(event) => setModel(event.target.value)}
          >
            {!connection.models.length && <option value="">No cloud models available</option>}
            {connection.models.map((name) => <option key={name} value={name}>{name}</option>)}
          </ComposerModelSelect>}
          </div>
          <button
            type="submit"
            className="send-button"
            aria-label="Start task"
            title="Start task"
            disabled={
              !goal.trim() ||
              !modelReady ||
              !connection.connected ||
              connection.busy ||
              connection.info?.pending || connection.retired || !!connection.info?.pendingError
            }
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
      </div>
      <p className="composer-note">
        {connection.retired ? "This connection is read-only. Choose a verified server in Machines." : !connection.connected ? "Connect this server to start a task." : !modelReady ? "Choose an available model to start. Manage providers in Machines." : null}
      </p>
    </div>
  );
}

const locationSnapshot = () => window.location.hash;
const subscribeLocation = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

function settingsSelection() {
  const hash = window.location.hash;
  return hash === "#machines" || /^#settings\/servers(?:\/|$)/.test(hash) ? "machines" : hash.startsWith("#settings") ? "connection" : null;
}

export default function App({ connection, initialTask, environmentNavigation, newTaskNavigation, draftConnection, draftLabel, renderSettings, groups, connections, sharedMemory, openChat, showHistory, history, dismissHistory, ownerLabel }: {
  connection: Connection; initialTask: string | null; environmentNavigation: ReactNode; newTaskNavigation: ReactNode; renderSettings: (appearance: Appearance) => ReactNode;
  draftConnection: Connection | undefined; draftLabel: string; connections: Record<string, Connection>; sharedMemory: ReactNode;
  groups: ChatGroup[]; openChat: OpenChat; showHistory: () => void;
  history: ReactNode; dismissHistory: () => void; ownerLabel: string;
}) {
  const mounted = useRef(true);
  useEffect(retainTerminals, []);
  useEffect(() => () => { mounted.current = false; }, []);
  const appearance = useAppearance();
  const narrow = useMediaQuery("(max-width: 780px)");
  const [selection, setSelection] = useState<string | null>(settingsSelection() ?? initialTask),
    [searchOpen, setSearchOpen] = useState(false),
    [taskSearch, setTaskSearch] = useState("");
  const locationHash = useSyncExternalStore(subscribeLocation, locationSnapshot);
  const dismissHistoryRef = useRef(dismissHistory);
  dismissHistoryRef.current = dismissHistory;
  const [draftTerminalOpen, setDraftTerminalOpen] = useState(false);
  const draftTerminalButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setDraftTerminalOpen(false), [draftConnection?.environmentId, selection, history]);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  useEffect(() => { if (initialTask && !settingsSelection()) setSelection(initialTask); }, [initialTask]);
  useEffect(() => {
    const update = () => { dismissHistoryRef.current(); setSelection(settingsSelection() ?? "home"); };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const sidebar = useSidebar(appearance, narrow);
  const showingHistory = !!history;
  useEffect(() => { if (showingHistory) sidebar.dismiss(); }, [showingHistory]);
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
  const pending = groups.filter(group => !group.archived).reduce((count, group) =>
    count + (connections[group.id ?? "legacy"]?.records.filter(record => isApproval(record) && text(record, "state") === "pending").length ?? 0), 0);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") sidebar.dismiss();
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        dismissHistory();
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
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
  const select = (id: string, settingsPath?: string) => {
    if (!mounted.current) return;
    dismissHistory();
    if (id === "connection" || id === "servers") window.location.hash = settingsPath ?? (id === "servers" ? "machines" : "settings");
    else if (id === "machines") window.location.hash = "machines";
    else window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setSelection(id === "servers" ? "machines" : id);
    sidebar.dismiss();
  };

  const composerConnection = selectedTask ? connection : draftConnection;
  const composerContext = <ComposerContext environmentNavigation={selectedTask ? environmentNavigation : newTaskNavigation}
    connected={!!composerConnection?.connected}
    terminalToggle={!selectedTask && draftConnection && <button ref={draftTerminalButton} type="button" className="composer-terminal" aria-label="Terminal" title="Terminal" aria-expanded={draftTerminalOpen} aria-controls="draft-server-terminal" onClick={() => setDraftTerminalOpen(open => !open)}><SquareTerminal size={18} aria-hidden="true" /></button>}
    onReconnect={composerConnection ? () => void composerConnection.connect() : undefined}
    onSettings={() => select("servers", `settings/servers/${composerConnection?.environmentId ?? "legacy"}/models`)} />;
  const showingComposer = !history && (!!selectedTask || selection === "home" || selection === null);
  const showingSettings = !history && selection === "connection";
  const showingMachineSettings = selection === "machines" && /^#settings\/servers\/[^/]+/.test(locationHash);
  const status = showingComposer ? composerConnection : undefined;
  return (
    <ConversationDetailContext.Provider value={appearance.conversationDetail}>
    <div
      data-tauri-drag-region
      className={`app-shell web-shell ${nativeApp() && navigator.userAgent.includes("Macintosh") ? "desktop-window" : ""} ${narrow ? "sidebar-overlay" : "sidebar-push"} ${sidebar.present ? "sidebar-present" : ""} ${sidebar.visible ? "sidebar-visible" : "sidebar-hidden"}`}
    >
        {!sidebar.docked && <button className="sidebar-edge" aria-label="Show sidebar" aria-controls="app-sidebar" aria-expanded={sidebar.visible} onPointerEnter={() => { sidebar.enter(); sidebar.reveal(); }} onPointerLeave={sidebar.leave} onClick={() => sidebar.reveal(true)} onFocus={() => sidebar.reveal(true)} />}
        <aside className="web-sidebar" id="app-sidebar" ref={sidebar.panel} inert={!sidebar.visible} aria-hidden={!sidebar.visible} data-motion={sidebar.settled && sidebar.visible ? "open" : sidebar.visible ? "opening" : sidebar.present ? "closing" : "closed"} onPointerEnter={sidebar.enter} onPointerLeave={sidebar.leave} onPointerDownCapture={sidebar.pointerInteraction} onFocusCapture={sidebar.focus} onBlurCapture={() => requestAnimationFrame(sidebar.blur)}>
          <div className="sidebar-chrome" data-tauri-drag-region>
            <button className="icon-button" aria-label={sidebar.pinned ? "Collapse sidebar" : "Pin sidebar"} aria-controls="app-sidebar" title={sidebar.pinned ? "Collapse sidebar (⌘B)" : "Pin sidebar · keep open"} onClick={sidebar.pinned ? sidebar.close : sidebar.pin}>{sidebar.pinned ? <PanelLeftClose size={16} /> : <Pin size={15} />}</button>
          </div>

          <button className="new-task-button" onClick={() => select("home")}>
            <Plus size={16} />
            New task <span className="shortcut">⌘ N</span>
          </button>
          <div className="sidebar-content">
          <nav aria-label="Main navigation">
            {navigation.map((item) => (
              <button
                key={item.id}
                aria-current={!history && (selection === item.id || (item.id === "home" && selectedTask)) ? "page" : undefined}
                onClick={() => select(item.id)}
              >
                <item.glyph size={16} />
                {item.title}
                {item.id === "decisions" && pending > 0 && (
                  <span className="nav-count">{pending}</span>
                )}
              </button>
            ))}
            <button aria-current={history ? "page" : undefined} onClick={showHistory}><MessageSquare size={16} />All chats</button>
          </nav>
          <div className="sidebar-section"><span>Chats by server</span><button className="icon-button" aria-label="Find a task" title="Find a task" onClick={() => setSearchOpen(!searchOpen)}><Search size={14} /></button></div>
          {searchOpen && <input id="task-search" className="task-search" aria-label="Find a task" placeholder="Find a task…" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} autoFocus />}
          <SidebarHistory groups={groups} selectedServer={connection.environmentId} selectedTask={!history ? selectedTask?.id : undefined} search={taskSearch} open={openChat} />
          </div>
          <div className="sidebar-bottom">{sidebar.nativeError && <p role="status">{sidebar.nativeError}</p>}{recordedPreview() && <p>Recorded server preview</p>}
          <button
            className="connection-nav"
            aria-label="Settings"
            aria-current={!history && selection === "connection" ? "page" : undefined}
            onClick={() => select("connection")}
          >
            <Settings size={16} aria-hidden="true" /><span>Settings</span><ChevronRight size={14} aria-hidden="true" />
          </button></div>
        </aside>
      <div data-owner-id={connection.environmentId ?? "legacy"} className={`main-shell ${selectedTask && !history ? "task-active" : ""}`} tabIndex={-1} onPointerDown={() => { if (!sidebar.docked) sidebar.dismiss(); }}>

        {status?.reconnecting && <div className="inline-notice" role="status">Reconnecting securely… Your saved server access is being restored automatically.</div>}
        {status?.error && (
          <div className="connection-error" role="alert">
            <span>{status.error}</span>
            <button onClick={() => void status.connect()}>
              Retry connection
            </button>
          </div>
        )}
        {status?.info?.pending && (
          <div className="inline-notice pending-notice">
            A command has an unknown outcome. Retrying uses its original
            operation key.
            <button
              onClick={() =>
                void status.perform(() => status.api.call("retry_command"), true)
              }
              disabled={status.busy || status.retired || !!status.info?.pendingError}
            >
              Retry same command
            </button>
          </div>
        )}
        {history ? history : selectedTask ? (
          <ImageViewerProvider key={connection.info?.deviceId} records={connection.records}>
            <TaskView
              key={`${connection.environmentId ?? 'legacy'}:${selectedTask.id}`}
              task={selectedTask}
              ownerLabel={ownerLabel}
              contextBar={composerContext}
              connection={connection}
            />
          </ImageViewerProvider>
        ) : selection === "home" || selection === null ? (
          <><main className="home">
            <div className="home-content">
              {draftConnection && <Composer connection={draftConnection} onCreated={id => {
                if (mounted.current && (currentSelection.current === "home" || currentSelection.current === null)) {
                  openChat(draftConnection.environmentId, id);
                }
              }} contextBar={composerContext} />}

            </div>
          </main>
          {draftTerminalOpen && draftConnection && <TerminalPane key={draftConnection.environmentId ?? 'legacy'} id="draft-server-terminal" environmentId={draftConnection.environmentId} label={draftLabel} onCollapse={() => { setDraftTerminalOpen(false); draftTerminalButton.current?.focus({ preventScroll: true }); }} />}
          </>
        ) : selection === "machines" ? (
          showingMachineSettings ? renderSettings(appearance) : <Machines groups={groups} />
        ) : showingSettings ? (
          renderSettings(appearance)
        ) : isWorkspaceSection(selection) ? (
          <WorkspaceView section={selection} groups={groups} connections={connections} sharedMemory={sharedMemory} />
        ) : (
          <main className="page"><p role="status">This chat is not available yet.</p></main>
        )}

      </div>
    </div>
    </ConversationDetailContext.Provider>
  );
}
