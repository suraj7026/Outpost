// Outpost design review — shared composer mock (GLM-5.3 Flash).
// One composer serves both the new-task and chat screens; only the surrounding
// content differs. Everything below is offline: every action simulates and
// reports through useNotice — no SSH, no network, no server mutation.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  Power,
  Unplug,
  Code2,
  Files,
  Globe,
  MessageSquare,
  Minus,
  Pause,
  Play,
  Plus,
  Server,
  Shield,
  SquareTerminal,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import OutpostMark from '../src/OutpostMark';
import { Badge, Button, EmptyState, Field, IconButton, Modal, SelectField, useNotice } from './ui';
import './composer.css';

type ComposerMode = 'new' | 'chat';
type Profile = 'code' | 'browser' | 'operations' | 'research' | 'chat';

type PreviewMessage = {
  id: string;
  author: 'owner' | 'outpost';
  at: string;
  paragraphs: string[];
  evidence?: string;
};

const PROFILE_TABS: { value: Profile; label: string; icon: LucideIcon }[] = [
  { value: 'code', label: 'Code', icon: Code2 },
  { value: 'browser', label: 'Browser', icon: Globe },
  { value: 'operations', label: 'Operations', icon: Server },
  { value: 'research', label: 'Research', icon: Globe },
  { value: 'chat', label: 'Chat', icon: MessageSquare },
];

const PLACEHOLDERS: Record<Profile, string> = {
  code: 'Describe a change, a problem, or something to build…',
  browser: 'Describe what you want done in the browser…',
  operations: 'Tell Outpost what to do across your servers…',
  research: 'Describe what to investigate or summarize…',
  chat: 'Describe what you want to talk through…',
};

const CHAT_PLACEHOLDER = 'Ask a follow-up, or give Outpost the next step…';

const CONTROL_MODES = [
  { value: 'full_control', label: 'Full control' },
  { value: 'ask_permission', label: 'Ask permission' },
  { value: 'auto', label: 'Auto review' },
];

const MODEL_OPTIONS = [
  { value: 'server-default', label: 'Server default' },
  { value: 'ollama/glm-5.3-flash', label: 'Ollama · glm-5.3-flash' },
  { value: 'openai/gpt-6.1-sol', label: 'OpenAI · GPT-6.1 Sol' },
];

const SERVERS = [
  { value: 'development', label: 'Development', connected: true },
  { value: 'home-server', label: 'Home server', connected: false },
];

const optionLabel = (list: { value: string; label: string }[], value: string) =>
  list.find(item => item.value === value)?.label ?? value;

const SEEDS: PreviewMessage[] = [
  {
    id: 'seed-1',
    author: 'owner',
    at: '09:38',
    paragraphs: ['The preview deploy failed twice last night. What broke?'],
  },
  {
    id: 'seed-2',
    author: 'outpost',
    at: '09:38',
    paragraphs: [
      'The build log points at a stale lockfile: the dependency resolver picked a newer transitive package than the one that shipped last week, and the image build rejects the drift.',
      'A lockfile refresh plus one re-run should confirm it. I have only read logs so far; nothing was changed.',
    ],
    evidence: 'Read-only log check · succeeded',
  },
  {
    id: 'seed-3',
    author: 'owner',
    at: '09:41',
    paragraphs: ['OK — try the refresh, then redeploy and tell me what changed.'],
  },
  {
    id: 'seed-4',
    author: 'outpost',
    at: '09:41',
    paragraphs: [
      'Proposing that as the next run: refresh the lockfile, redeploy preview, compare the build output. You approve each step before it executes.',
    ],
  },
];

const previewResponse = (isNew: boolean, profile: Profile): string[] => [
  isNew
    ? profile === 'browser'
      ? 'Outpost would open a supervised browser session, capture the current page state, and propose each navigation step for approval before acting. The Control mode select above decides which steps run without asking.'
      : profile === 'operations'
        ? 'Outpost would plan the work across the selected sample server, list every command it intends to run, and pause for approval when Control mode requires it. Output appears as plain text above.'
        : profile === 'research'
          ? 'Outpost would gather the sources you point it at, summarize findings in plain text, and propose follow-up work — without opening any network connection in this preview.'
          : profile === 'chat'
            ? 'Outpost would keep this conversational: plain text replies with an occasional proposed action for approval, like the sample transcript.'
            : 'Outpost would draft a plan: check the failing tests, propose a patch as a pending action for your approval, and stop for review before writing any file. The Control mode select above decides which steps can run without asking.'
    : 'Outpost would re-run the failed checks, compare the build log with the last successful run, and propose the lockfile refresh as a pending action. You approve each step before it runs — nothing has been sent.',
];

const terminalLines = (host: string) => [
  `# ${host} · sample session (static, nothing executed)`,
  `outpost@${host}:~$ outpost status`,
  `agent running · server ${host} · 2 tasks active (sample)`,
  `outpost@${host}:~$ outpost task list --brief`,
  't-8f31  investigate the failed preview deploy    running   preview',
  't-4a9c  summarize overnight logs                 paused    preview',
  `outpost@${host}:~$ ▍`,
];

const terminalLineClass = (line: string) =>
  line.startsWith('#')
    ? 'composer-review-line composer-review-line-comment'
    : line.startsWith('outpost@')
      ? 'composer-review-line composer-review-line-input'
      : 'composer-review-line';

const clock = (date = new Date()) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function ComposerPages({ mode = 'new' }: { mode?: ComposerMode }) {
  // Keying on mode resets mock state when the shell switches screens.
  return <Screen key={mode} mode={mode} />;
}

function OwnerMessage({ message }: { message: PreviewMessage }) {
  return (
    <article className="composer-review-message composer-review-owner">
      <div className="composer-review-owner-body">
        <div className="composer-review-byline">
          <strong>You</strong>
          <span>{message.at}</span>
        </div>
        {message.paragraphs.map(paragraph => (
          <p className="composer-review-text" key={paragraph.slice(0, 24)}>{paragraph}</p>
        ))}
      </div>
      <span className="composer-review-message-avatar" aria-hidden="true">
        <UserRound />
      </span>
    </article>
  );
}

function OutpostMessage({ message }: { message: PreviewMessage }) {
  return (
    <article className="composer-review-message composer-review-reply">
      <div className="composer-review-reply-byline">
        <span className="composer-review-reply-logo" aria-hidden="true"><OutpostMark /></span>
        <strong className="composer-review-byline-name">Outpost</strong>
        <span>{message.at}</span>
      </div>
      <div className="composer-review-reply-content">
        {message.paragraphs.map(paragraph => (
          <p className="composer-review-text" key={paragraph.slice(0, 24)}>{paragraph}</p>
        ))}
        {message.evidence && (
          <div className="composer-review-entry">
            <Check aria-hidden="true" />
            <span>{message.evidence}</span>
            <Badge>Sample</Badge>
          </div>
        )}
      </div>
    </article>
  );
}

function Screen({ mode }: { mode: ComposerMode }) {
  const isNew = mode === 'new';
  const notify = useNotice();

  const [profile, setProfile] = useState<Profile>('code');
  const [controlMode, setControlMode] = useState(CONTROL_MODES[0].value);
  const [model, setModel] = useState('ollama/glm-5.3-flash');
  const [server, setServer] = useState(SERVERS[0].value);
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<PreviewMessage[]>(isNew ? [] : SEEDS);
  const [pending, setPending] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => new URLSearchParams(location.search).get('terminal') === 'open');
  const [terminalHelp, setTerminalHelp] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(true);
  const [rebootOpen, setRebootOpen] = useState(false);
  const [rebootConfirm, setRebootConfirm] = useState('');

  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => {
    for (const timer of timersRef.current) clearTimeout(timer);
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [messages, pending]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 64), 224)}px`;
  }, [draft]);

  const send = () => {
    const value = draft.trim();
    if (!value) return;
    idRef.current += 1;
    const ownerId = `preview-${idRef.current}`;
    setMessages(list => [...list, { id: ownerId, author: 'owner', at: clock(), paragraphs: [value] }]);
    setDraft('');
    setPending(true);
    const timer = setTimeout(() => {
      setPending(false);
      idRef.current += 1;
      const replyId = `preview-${idRef.current}`;
      setMessages(list => [
        ...list,
        { id: replyId, author: 'outpost', at: clock(), paragraphs: previewResponse(isNew, profile) },
      ]);
    }, 700);
    timersRef.current.push(timer);
  };

  const closeTerminal = () => {
    setTerminalOpen(false);
    requestAnimationFrame(() => {
      document.getElementById('composer-review-terminal-toggle')?.focus({ preventScroll: true });
    });
  };

  const serverEntry = SERVERS.find(item => item.value === server) ?? SERVERS[0];
  const host = serverEntry.value;

  let content: ReactNode = null;
  if (messages.length) {
    content = (
      <div className="composer-review-transcript" role="log" aria-label="Conversation preview">
        {messages.map(message =>
          message.author === 'owner'
            ? <OwnerMessage key={message.id} message={message} />
            : <OutpostMessage key={message.id} message={message} />)}
        {pending && (
          <div className="composer-review-pending" role="status">
            Outpost is drafting a preview response…
          </div>
        )}
      </div>
    );
  } else if (!isNew) {
    content = (
      <div className="composer-review-empty">
        <EmptyState
          icon={<MessageSquare />}
          title="No messages in this preview yet"
          description="This transcript is sample data. Sending below only adds preview text here — nothing is delivered to any server."
        />
      </div>
    );
  }

  return (
    <div
      className={`composer-review composer-review-${mode}${isNew && !messages.length ? ' composer-review-center' : ''}`}
    >
      <div className="composer-review-column">
        <div className="composer-review-body" ref={bodyRef}>{content}</div>

        <div className="composer-review-dock">
          {isNew && (
            <div className="composer-review-tabs" role="group" aria-label="Task profile">
              {PROFILE_TABS.map(tab => (
                <button
                  type="button"
                  key={tab.value}
                  className="composer-review-tab"
                  aria-pressed={profile === tab.value}
                  onClick={() => setProfile(tab.value)}
                >
                  <tab.icon aria-hidden="true" />
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <div className="composer-review-context">
            <div className="composer-review-server">
              <span
                className={`composer-review-server-dot${serverEntry.connected ? ' is-ok' : ''}`}
                aria-hidden="true"
              />
              <span className="composer-review-server-name">{serverEntry.label}</span>
              <ChevronDown size={12} aria-hidden="true" />
              <select
                aria-label="Server"
                value={server}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const { value } = event.currentTarget;
                  setServer(value);
                  notify(`Preview: server switching is simulated. ${optionLabel(SERVERS, value)} is a sample server; only text in this window changes.`);
                }}
              >
                {SERVERS.map(item => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <span className="composer-review-connection" role="status" data-connected={serverEntry.connected}>
              <span className="composer-review-connection-dot" aria-hidden="true" />
              {serverEntry.connected ? 'Connected' : 'Not connected (sample)'}
            </span>
            <IconButton
              id="composer-review-terminal-toggle"
              label="Terminal (sample session)"
              aria-expanded={terminalOpen}
              aria-controls="composer-review-terminal"
              onClick={() => setTerminalOpen(open => !open)}
            >
              <SquareTerminal size={18} />
            </IconButton>
          </div>
          <div className="composer-review-composer">
            <textarea
              ref={textareaRef}
              className="composer-review-textarea"
              aria-label={isNew ? 'Task goal' : 'Message Outpost'}
              placeholder={isNew ? PLACEHOLDERS[profile] : CHAT_PLACEHOLDER}
              autoFocus={isNew}
              value={draft}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-review-toolbar">
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) notify(`Preview: “${file.name}” would be attached. Nothing was uploaded.`);
                  event.target.value = '';
                }}
              />
              <IconButton label="Attach file (preview)" onClick={() => fileInputRef.current?.click()}>
                <Plus size={18} />
              </IconButton>
              {!isNew && (
                <IconButton
                  label={paused ? 'Resume task (preview)' : 'Pause task (preview)'}
                  onClick={() => {
                    setPaused(value => !value);
                    notify(paused
                      ? 'Preview: task resumed (sample only — nothing was sent).'
                      : 'Preview: task paused (sample only — nothing was sent).');
                  }}
                >
                  {paused ? <Play size={18} /> : <Pause size={18} />}
                </IconButton>
              )}
              <IconButton
                label="Files & changes (preview)"
                onClick={() => notify('Preview: “Files & changes” opens here in the app — 1 screenshot and deploy.log so far (sample).')}
              >
                <Files size={18} />
              </IconButton>
              <div className="composer-review-cell composer-review-cell-permission">
                <SelectField
                  compact
                  icon={<Shield size={15} aria-hidden="true" />}
                  aria-label="Control mode"
                  value={controlMode}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    const { value } = event.currentTarget;
                    setControlMode(value);
                    notify(`Preview: control mode set to ${optionLabel(CONTROL_MODES, value)}. Nothing was sent to a server.`);
                  }}
                >
                  {CONTROL_MODES.map(item => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </SelectField>
              </div>
              <div className="composer-review-cell composer-review-cell-model">
                <SelectField
                  compact
                  aria-label="Model"
                  value={model}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    const { value } = event.currentTarget;
                    setModel(value);
                    notify(`Preview: model set to ${optionLabel(MODEL_OPTIONS, value)}. Nothing was sent to a server.`);
                  }}
                >
                  {MODEL_OPTIONS.map(item => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </SelectField>
              </div>
              <button
                type="button"
                className="composer-review-send"
                aria-label={isNew ? 'Start task (preview)' : 'Send message (preview)'}
                title={isNew ? 'Start task (preview)' : 'Send message (preview)'}
                disabled={!draft.trim()}
                onClick={send}
              >
                <ArrowUp aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

      </div>
        {terminalOpen && (
          <section
            id="composer-review-terminal"
            className="composer-review-terminal"
            aria-label="Sample server terminal"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeTerminal();
              }
            }}
          >
            <div className="composer-review-terminal-header">
              <div className="composer-review-terminal-identity">
                <SquareTerminal size={18} aria-hidden="true" />
                <strong>Terminal</strong>
                <span className="composer-review-terminal-dot" data-connected={sessionOpen} role="img" aria-label={sessionOpen ? 'Shell connected (preview)' : 'Shell disconnected (preview)'} title={sessionOpen ? 'Connected · sample session' : 'Disconnected · sample session'} />
                <div className="composer-review-terminal-host">
                  <span>outpost@{host}</span>
                  <small><span>{serverEntry.label}</span><span>SSH · port 22</span></small>
                </div>
              </div>
              <div className="composer-review-terminal-actions">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSessionOpen(open => !open);
                    notify(sessionOpen
                      ? 'Preview: disconnect simulated. No real session existed.'
                      : 'Preview: reconnect simulated. No real connection exists.');
                  }}
                >
                  <Unplug size={16} />{sessionOpen ? 'Disconnect' : 'Reconnect'}
                </Button>
                <Button variant="danger" onClick={() => setRebootOpen(true)}><Power size={16} />Reboot server…</Button>
                <IconButton label="Terminal help" onClick={() => setTerminalHelp(true)}><CircleHelp size={18} /></IconButton>
                <IconButton label="Close terminal" onClick={closeTerminal}>
                  <Minus size={18} />
                </IconButton>
              </div>
            </div>
            <div className="composer-review-terminal-frame" data-connected={sessionOpen}>
              <pre
                className="composer-review-screen"
                tabIndex={0}
                aria-label="Terminal output preview (static sample)"
              >
                {terminalLines(host).map((line, index) => (
                  <span key={index} className={terminalLineClass(line)}>{line}</span>
                ))}
              </pre>

            </div>
          </section>
        )}
      {terminalHelp && <Modal title="Terminal shortcuts" onClose={() => setTerminalHelp(false)}><div className="stack"><p><strong>Escape</strong> collapses the terminal. The shell stays open until you disconnect.</p><p><strong>Control C</strong> interrupts a command. <strong>Command V</strong> pastes into the shell.</p><p className="muted small">This is a design preview with static sample output. No SSH connection, shell command or server reboot is performed.</p><Button onClick={() => setTerminalHelp(false)}>Done</Button></div></Modal>}

      {rebootOpen && (
        <Modal
          title={`Reboot ${serverEntry.label}? (preview)`}
          onClose={() => {
            setRebootOpen(false);
            setRebootConfirm('');
          }}
        >
          <div className="form-grid">
            <p className="composer-review-modal-copy">
              Preview only — no machine exists to restart. In the installed app, rebooting stops every agent task
              and terminal session on that server and interrupts unsaved shell work. Outpost reports success only
              after verifying a changed boot ID; a requested or uncertain reboot is never reported as completed.
            </p>
            <Field
              label={`Type “${host}” to confirm, as you would in the app`}
              value={rebootConfirm}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setRebootConfirm(event.target.value)}
            />
            <div className="dialog-actions">
              <Button
                type="button"
                onClick={() => {
                  setRebootOpen(false);
                  setRebootConfirm('');
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={rebootConfirm.trim() !== host}
                onClick={() => {
                  setRebootOpen(false);
                  setRebootConfirm('');
                  notify(`Preview: the reboot would stop all tasks and sessions and wait for a verified boot ID. Nothing happened.`);
                }}
              >
                Simulate reboot (preview)
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
