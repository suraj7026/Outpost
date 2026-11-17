import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlarmClock,
  CalendarClock,
  ChevronRight,

  Globe,
  MessageSquare,
  NotebookPen,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Badge, Button, EmptyState, Field, IconButton, Modal, Section, SelectField, useNotice } from './ui';
import './workspace.css';

export type WorkspacePage = 'automations' | 'memory' | 'chats' | 'approvals';

/* ------------------------------------------------------------------ sample data */

type SampleServer = { id: string; label: string; detail: string; connected: boolean };

const sampleServers: SampleServer[] = [
  { id: 'development', label: 'Development', detail: 'Ubuntu', connected: true },
  { id: 'home-server', label: 'Home server', detail: 'Ubuntu · offline', connected: false },
];

const serverById = (id: string | null) => sampleServers.find(server => server.id === id);
const serverName = (id: string | null) => serverById(id)?.label ?? 'Unavailable server';

const timezones = ['Europe/London', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Asia/Singapore'];
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'hourly';
type Permission = 'full_control' | 'ask_permission' | 'auto';

const frequencies: { id: Frequency; label: string }[] = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'hourly', label: 'Every hour' },
];

const permissions: { id: Permission; label: string; summary: string }[] = [
  { id: 'full_control', label: 'Full control', summary: 'Authorizes actions within the task’s scope without asking. Server safety restrictions still apply.' },
  { id: 'ask_permission', label: 'Ask permission', summary: 'Each proposed action waits for your approval.' },
  { id: 'auto', label: 'Auto review', summary: 'A reviewer checks proposed actions. Uncertain or unavailable reviews require your decision.' },
];

const permissionById = (id: Permission) => permissions.find(item => item.id === id) ?? permissions[1];

/* ------------------------------------------------------------------ helpers */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeTime(timestamp: number, now: number) {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) {
    const minutes = Math.round(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.round(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(elapsed / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`;

function PageHeading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <header className="workspace-review-heading">
    <div className="grow">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {action && <div className="inline workspace-review-heading-actions">{action}</div>}
  </header>;
}


/* ------------------------------------------------------------------ automations */

type Schedule = {
  id: string;
  name: string;
  prompt: string;
  serverId: string;
  frequency: Frequency;
  day: string;
  time: string;
  timezone: string;
  permission: Permission;
  status: 'active' | 'paused';
};

const initialSchedules: Schedule[] = [
  {
    id: 'schedule-audit',
    name: 'Nightly dependency audit',
    prompt: 'Look through this project for outdated dependencies and write a short summary of what could be upgraded.',
    serverId: 'development',
    frequency: 'daily',
    day: 'Monday',
    time: '02:15',
    timezone: 'Europe/London',
    permission: 'ask_permission',
    status: 'active',
  },
  {
    id: 'schedule-backup',
    name: 'Weekly backup check',
    prompt: 'Check that last night’s backup finished and report the newest backup file and its size.',
    serverId: 'home-server',
    frequency: 'weekly',
    day: 'Monday',
    time: '09:00',
    timezone: 'America/New_York',
    permission: 'ask_permission',
    status: 'paused',
  },
];

function scheduleWhen(schedule: Schedule) {
  const frequency = frequencies.find(item => item.id === schedule.frequency)?.label ?? 'Every day';
  const day = schedule.frequency === 'weekly' ? ` on ${schedule.day}` : '';
  const time = schedule.frequency === 'hourly' ? '' : ` at ${schedule.time}`;
  return `${frequency}${day}${time}`;
}

function ScheduleDialog({ initial, onClose, onSave }: {
  initial: Schedule | null;
  onClose: () => void;
  onSave: (schedule: Schedule) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [serverId, setServerId] = useState(initial?.serverId ?? sampleServers[0].id);
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? 'daily');
  const [day, setDay] = useState(initial?.day ?? 'Monday');
  const [time, setTime] = useState(initial?.time ?? '09:00');
  const [timezone, setTimezone] = useState(initial?.timezone ?? timezones[0]);
  const [permission, setPermission] = useState<Permission>(initial?.permission ?? 'ask_permission');
  const ready = name.trim().length > 1 && prompt.trim().length > 3 && (frequency === 'hourly' || !!time);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    onSave({
      id: initial?.id ?? nextId('schedule'),
      name: name.trim(),
      prompt: prompt.trim(),
      serverId,
      frequency,
      day,
      time,
      timezone,
      permission,
      status: initial?.status ?? 'active',
    });
  };
  return <Modal title={initial ? 'Edit schedule' : 'New schedule'} onClose={onClose}>
    <form className="form-grid workspace-review-dialog" onSubmit={submit}>
      <Field label="Schedule name" placeholder="Nightly dependency audit" maxLength={60} required value={name} onChange={event => setName(event.target.value)} />
      <label className="field workspace-review-field">
        <span className="workspace-review-field-label">What should it do?</span>
        <textarea className="text-field" rows={3} maxLength={400} required value={prompt}
          placeholder="Describe the task this schedule should run."
          onChange={event => setPrompt(event.target.value)} />
      </label>
      <SelectField label="Server" icon={<Server size={16} />} value={serverId} onChange={event => setServerId(event.target.value)}>
        {sampleServers.map(server => <option key={server.id} value={server.id}>{server.label} · {server.detail}</option>)}
      </SelectField>
      <div className="workspace-review-two-col">
        <SelectField label="How often" value={frequency} onChange={event => setFrequency(event.target.value as Frequency)}>
          {frequencies.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </SelectField>
        {frequency === 'weekly' && <SelectField label="Day" value={day} onChange={event => setDay(event.target.value)}>
          {weekdays.map(value => <option key={value} value={value}>{value}</option>)}
        </SelectField>}
        {frequency !== 'hourly' && <Field label="Time" type="time" required value={time} onChange={event => setTime(event.target.value)} />}
        <SelectField label="Time zone" icon={<Globe size={16} />} value={timezone} onChange={event => setTimezone(event.target.value)}>
          {timezones.map(value => <option key={value} value={value}>{value}</option>)}
        </SelectField>
      </div>
      <SelectField label="Permission" value={permission} onChange={event => setPermission(event.target.value as Permission)}>
        {permissions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </SelectField>
      <p className="workspace-review-hint">{permissionById(permission).summary}</p>
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>{initial ? 'Save changes' : 'Create schedule'}</Button>
      </div>
    </form>
  </Modal>;
}

function AutomationsPage() {
  const notice = useNotice();
  const [schedules, setSchedules] = useState<Schedule[]>(initialSchedules);
  const [dialog, setDialog] = useState<{ schedule: Schedule | null } | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);

  const save = (schedule: Schedule) => {
    setSchedules(current => current.some(item => item.id === schedule.id)
      ? current.map(item => item.id === schedule.id ? schedule : item)
      : [schedule, ...current]);
    setDialog(null);
    notice(`Schedule saved for ${serverName(schedule.serverId)} in preview.`);
  };
  const toggle = (schedule: Schedule) => {
    const paused = schedule.status === 'paused';
    setSchedules(current => current.map(item => item.id === schedule.id ? { ...item, status: paused ? 'active' : 'paused' } : item));
    notice(paused ? 'Schedule resumed in preview.' : 'Schedule paused in preview.');
  };

  return <div className="workspace-review-page">
    <PageHeading title="Automations" description="Schedules that run the same task on a server at a time you choose."
      action={<Button variant="primary" onClick={() => setDialog({ schedule: null })}><Plus size={16} />New schedule</Button>} />


    <Section title="Schedules" description={`${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'} across your servers.`}>
      {schedules.length ? <div className="workspace-review-list">
        {schedules.map(schedule => <article className="row workspace-review-item" key={schedule.id}>
          <span className="workspace-review-item-icon"><AlarmClock size={18} /></span>
          <div className="grow">
            <div className="workspace-review-item-title">
              <span className="list-title">{schedule.name}</span>
              <Badge tone={schedule.status === 'active' ? 'success' : 'warning'}>{schedule.status === 'active' ? 'Active' : 'Paused'}</Badge>
            </div>
            <div className="detail-text">{serverName(schedule.serverId)} · {scheduleWhen(schedule)} · {schedule.timezone} · {permissionById(schedule.permission).label}</div>
            <p className="workspace-review-item-text">{schedule.prompt}</p>
          </div>
          <div className="inline workspace-review-item-actions">
            <Button onClick={() => toggle(schedule)}>
              {schedule.status === 'paused' ? <Play size={16} /> : <Pause size={16} />}
              {schedule.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <IconButton label={`Edit ${schedule.name}`} onClick={() => setDialog({ schedule })}><Pencil size={18} /></IconButton>
            <IconButton label={`Delete ${schedule.name}`} onClick={() => setRemoving(schedule)}><Trash2 size={18} /></IconButton>
          </div>
        </article>)}
      </div> : <EmptyState icon={<CalendarClock size={22} />} title="No schedules yet"
        description="A schedule repeats one task on a server at a time you pick. Create your first one to see how it looks."
        action={<Button variant="primary" onClick={() => setDialog({ schedule: null })}><Plus size={16} />New schedule</Button>} />}
    </Section>

    {dialog && <ScheduleDialog initial={dialog.schedule} onClose={() => setDialog(null)} onSave={save} />}
    {removing && <Modal title="Delete this schedule?" onClose={() => setRemoving(null)}>
      <div className="stack workspace-review-dialog">
        <p>Remove “{removing.name}” from {serverName(removing.serverId)}? In the app, this would stop future scheduled runs, not cancel tasks already started.</p>
        <p className="workspace-review-hint">This confirmation only removes the sample schedule.</p>
        <div className="dialog-actions">
          <Button onClick={() => setRemoving(null)}>Keep schedule</Button>
          <Button variant="danger" onClick={() => {
            setSchedules(current => current.filter(item => item.id !== removing.id));
            notice(`Sample schedule “${removing.name}” deleted from this preview.`);
            setRemoving(null);
          }}>Delete schedule</Button>
        </div>
      </div>
    </Modal>}
  </div>;
}

/* ------------------------------------------------------------------ memory */

type Note = { id: string; text: string; scope: 'shared' | 'server'; serverId: string | null; updatedAt: number };

const initialNotes: Note[] = [
  { id: 'note-deploy', scope: 'shared', serverId: null, updatedAt: Date.now() - 2 * HOUR, text: 'Before shipping: run the smoke tests on Development, then tag the release in git.' },
  { id: 'note-secrets', scope: 'shared', serverId: null, updatedAt: Date.now() - 26 * HOUR, text: 'Never paste production credentials into a chat. Use the server’s provider settings.' },
  { id: 'note-staging', scope: 'server', serverId: 'development', updatedAt: Date.now() - 40 * MINUTE, text: 'The staging database is restored nightly at 03:00 UTC. Do not start migrations before that finishes.' },
  { id: 'note-cache', scope: 'server', serverId: 'home-server', updatedAt: Date.now() - 5 * DAY, text: 'The build cache lives at /var/cache/outpost/builds. Check active builds before cleaning it.' },
];

function NoteDialog({ note, defaultScope, defaultServerId, onClose, onSave }: {
  note: Note | null;
  defaultScope: 'shared' | 'server';
  defaultServerId: string;
  onClose: () => void;
  onSave: (note: Note) => void;
}) {
  const [text, setText] = useState(note?.text ?? '');
  const [target, setTarget] = useState(note
    ? (note.scope === 'shared' ? 'shared' : note.serverId ?? defaultServerId)
    : (defaultScope === 'shared' ? 'shared' : defaultServerId));
  const ready = text.trim().length > 2;
  return <Modal title={note ? 'Edit note' : 'Add a note'} onClose={onClose}>
    <form className="form-grid workspace-review-dialog" onSubmit={event => {
      event.preventDefault();
      if (!ready) return;
      onSave({
        id: note?.id ?? nextId('note'),
        text: text.trim(),
        scope: target === 'shared' ? 'shared' : 'server',
        serverId: target === 'shared' ? null : target,
        updatedAt: Date.now(),
      });
    }}>
      <label className="field workspace-review-field">
        <span className="workspace-review-field-label">Note</span>
        <textarea className="text-field" rows={4} maxLength={2000} required value={text}
          placeholder="Something worth remembering next time you work here."
          onChange={event => setText(event.target.value)} />
      </label>
      <SelectField label="Save to" icon={<Server size={16} />} value={target} onChange={event => setTarget(event.target.value)}>
        <option value="shared">All servers (shared)</option>
        {sampleServers.map(server => <option key={server.id} value={server.id}>{server.label} only</option>)}
      </SelectField>
      <p className="workspace-review-hint">
        {target === 'shared'
          ? 'Shared notes are kept on every server, so they follow you wherever the task runs.'
          : `This note is kept on ${serverName(target)} only. It is never copied to your other servers.`}
      </p>
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready}>{note ? 'Save changes' : 'Add note'}</Button>
      </div>
    </form>
  </Modal>;
}

function MemoryPage() {
  const notice = useNotice();
  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const [scope, setScope] = useState<'shared' | 'server'>('shared');
  const [serverId, setServerId] = useState(sampleServers[0].id);
  const [dialog, setDialog] = useState<{ note: Note | null } | null>(null);
  const [removing, setRemoving] = useState<Note | null>(null);
  const [now] = useState(() => Date.now());

  const visible = scope === 'shared'
    ? notes.filter(note => note.scope === 'shared')
    : notes.filter(note => note.scope === 'server' && note.serverId === serverId);
  const offline = sampleServers.filter(server => !server.connected);
  const sharedWhere = () => offline.length
    ? `Saved on ${sampleServers.length - offline.length} of ${sampleServers.length} servers · waiting for ${offline.map(item => item.label).join(', ')}`
    : `Saved on all ${sampleServers.length} servers`;

  const save = (note: Note) => {
    setNotes(current => current.some(item => item.id === note.id)
      ? current.map(item => item.id === note.id ? note : item)
      : [note, ...current]);
    setDialog(null);
    notice(note.scope === 'shared'
      ? `Shared note saved in preview. ${sharedWhere()}.`
      : `Sample note saved to ${serverName(note.serverId)} only.`);
  };

  return <div className="workspace-review-page">
    <PageHeading title="Memory" description="Keep notes for every server or just one."
      action={<Button variant="primary" onClick={() => setDialog({ note: null })}><Plus size={16} />Add note</Button>} />

    <div className="workspace-review-scope-row">
      <div className="workspace-review-scope" role="group" aria-label="Where the note is kept">
        <button type="button" aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}>All servers</button>
        <button type="button" aria-pressed={scope === 'server'} onClick={() => setScope('server')}>One server</button>
      </div>
      {scope === 'server' && <SelectField label="Server" icon={<Server size={16} />} value={serverId} onChange={event => setServerId(event.target.value)}>
        {sampleServers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
      </SelectField>}
    </div>

    {scope === 'shared' ? <>
      <Section title="All servers" description="Shared notes travel with you. Change one and it updates on every server that is reachable.">
        {visible.length ? <div className="workspace-review-list">
          {visible.map(note => <article className="row workspace-review-item" key={note.id}>
            <span className="workspace-review-item-icon"><NotebookPen size={18} /></span>
            <div className="grow">
              <p className="workspace-review-item-text workspace-review-note-text">{note.text}</p>
              <div className="detail-text">{sharedWhere()} · edited {relativeTime(note.updatedAt, now)}</div>
            </div>
            <div className="inline workspace-review-item-actions">
              <IconButton label="Edit note" onClick={() => setDialog({ note })}><Pencil size={18} /></IconButton>
              <IconButton label="Delete note" onClick={() => setRemoving(note)}><Trash2 size={18} /></IconButton>
            </div>
          </article>)}
        </div> : <EmptyState icon={<NotebookPen size={22} />} title="No shared notes yet"
          description="Shared notes are kept on every server, so the next task already knows the context."
          action={<Button variant="primary" onClick={() => setDialog({ note: null })}><Plus size={16} />Add a shared note</Button>} />}
      </Section>
    </> : <>
      <Section title={serverName(serverId)} description="These notes stay on this server.">
        {visible.length ? <div className="workspace-review-list">
          {visible.map(note => <article className="row workspace-review-item" key={note.id}>
            <span className="workspace-review-item-icon"><Server size={18} /></span>
            <div className="grow">
              <p className="workspace-review-item-text workspace-review-note-text">{note.text}</p>
              <div className="detail-text">Kept on {serverName(note.serverId)} only · edited {relativeTime(note.updatedAt, now)}</div>
            </div>
            <div className="inline workspace-review-item-actions">
              <IconButton label="Edit note" onClick={() => setDialog({ note })}><Pencil size={18} /></IconButton>
              <IconButton label="Delete note" onClick={() => setRemoving(note)}><Trash2 size={18} /></IconButton>
            </div>
          </article>)}
        </div> : <EmptyState icon={<Server size={22} />} title={`No notes on ${serverName(serverId)} yet`}
          description="Server notes are handy for local details: paths, ports, downtimes, anything specific to one machine."
          action={<Button variant="primary" onClick={() => setDialog({ note: null })}><Plus size={16} />Add a note to {serverName(serverId)}</Button>} />}
      </Section>
    </>}

    {dialog && <NoteDialog note={dialog.note} defaultScope={scope} defaultServerId={serverId} onClose={() => setDialog(null)} onSave={save} />}
    {removing && <Modal title="Delete this note?" onClose={() => setRemoving(null)}>
      <div className="stack workspace-review-dialog">
        <p>Remove this note from {removing.scope === 'shared' ? 'all servers, including offline servers when they reconnect' : serverName(removing.serverId)}?</p>
        <p className="workspace-review-hint">This confirmation only removes the sample note.</p>
        <div className="dialog-actions">
          <Button onClick={() => setRemoving(null)}>Keep note</Button>
          <Button variant="danger" onClick={() => {
            setNotes(current => current.filter(item => item.id !== removing.id));
            notice('Sample note deleted from this preview.');
            setRemoving(null);
          }}>Delete note</Button>
        </div>
      </div>
    </Modal>}
  </div>;
}

/* ------------------------------------------------------------------ chats */

type ChatStatus = 'running' | 'review' | 'done' | 'attention';

type Chat = { id: string; title: string; serverId: string; status: ChatStatus; updatedAt: number; messages: number };

const statusLabels: Record<ChatStatus, { label: string; tone: 'neutral' | 'success' | 'warning' }> = {
  running: { label: 'Running', tone: 'neutral' },
  review: { label: 'Ready for your review', tone: 'warning' },
  done: { label: 'Finished', tone: 'success' },
  attention: { label: 'Needs attention', tone: 'warning' },
};

const initialChats: Chat[] = [
  { id: 'chat-audit', title: 'Nightly dependency audit', serverId: 'development', status: 'done', updatedAt: Date.now() - 2 * HOUR, messages: 14 },
  { id: 'chat-dashboard', title: 'Screenshot the new dashboard', serverId: 'home-server', status: 'running', updatedAt: Date.now() - 8 * MINUTE, messages: 6 },
  { id: 'chat-auth', title: 'Refactor the auth helper', serverId: 'development', status: 'review', updatedAt: Date.now() - 25 * MINUTE, messages: 21 },
  { id: 'chat-migration', title: 'Explain the failing migration', serverId: 'home-server', status: 'attention', updatedAt: Date.now() - 30 * HOUR, messages: 9 },
  { id: 'chat-incidents', title: 'Summarise last week’s incidents', serverId: 'home-server', status: 'done', updatedAt: Date.now() - 3 * DAY, messages: 11 },
  { id: 'chat-preview-env', title: 'Set up the preview environment', serverId: 'development', status: 'done', updatedAt: Date.now() - 6 * DAY, messages: 18 },
  { id: 'chat-release-notes', title: 'Draft the release notes', serverId: 'home-server', status: 'running', updatedAt: Date.now() - 15 * MINUTE, messages: 4 },
];

function ChatsPage() {
  const [query, setQuery] = useState('');
  const [serverFilter, setServerFilter] = useState('all');
  const [selected, setSelected] = useState<Chat | null>(null);
  const [now] = useState(() => Date.now());

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return initialChats.filter(chat => {
      const matchesServer = serverFilter === 'all' || chat.serverId === serverFilter;
      const matchesQuery = !needle || chat.title.toLowerCase().includes(needle) || serverName(chat.serverId).toLowerCase().includes(needle);
      return matchesServer && matchesQuery;
    });
  }, [query, serverFilter]);

  const openChat = (chat: Chat) => setSelected(chat);

  return <div className="workspace-review-page">
    <PageHeading title="All chats" description="Every conversation, kept with the server that owns it." />

    <div className="workspace-review-toolbar">
      <div className="workspace-review-search">
        <Field label="Search chats" type="search" placeholder="Search by title or server" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <SelectField label="Server" icon={<Server size={16} />} value={serverFilter} onChange={event => setServerFilter(event.target.value)}>
        <option value="all">All servers</option>
        {sampleServers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
      </SelectField>
    </div>

    <Section title="Conversations" description={`${results.length} of ${initialChats.length} chats · ${new Set(results.map(chat => chat.serverId)).size} ${new Set(results.map(chat => chat.serverId)).size === 1 ? 'server' : 'servers'}`}>
      {results.length ? <div className="workspace-review-list">
        {results.map(chat => {
          const status = statusLabels[chat.status];
          return <article className="workspace-review-chat" key={chat.id}>
            <button type="button" className="workspace-review-chat-open" onClick={() => openChat(chat)}>
              <MessageSquare size={16} className="workspace-review-chat-icon" />
              <span className="grow workspace-review-chat-body">
                <span className="workspace-review-chat-title">{chat.title}</span>
                <span className="detail-text">{serverName(chat.serverId)} · {chat.messages} messages · {relativeTime(chat.updatedAt, now)}</span>
              </span>
              <span className="workspace-review-chat-status"><Badge tone={serverById(chat.serverId)?.connected ? status.tone : 'neutral'}>{serverById(chat.serverId)?.connected ? status.label : 'Cached'}</Badge></span>
              <ChevronRight size={16} className="workspace-review-chat-chevron" />
            </button>
          </article>;
        })}
      </div> : <EmptyState icon={<Search size={22} />} title="No chats match your search"
        description="Try a shorter search, or switch back to all servers."
        action={<Button onClick={() => { setQuery(''); setServerFilter('all'); }}>Clear search and filters</Button>} />}
    </Section>

    <p className="workspace-review-hint">Offline servers show history cached on this Mac.</p>
    {selected && <Modal title="Conversation details" onClose={() => setSelected(null)}>
      <div className="stack workspace-review-dialog">
        <h3 className="workspace-review-chat-title">{selected.title}</h3>
        <dl className="workspace-review-facts">
          <div><dt>Server</dt><dd>{serverName(selected.serverId)}</dd></div>
          <div><dt>{serverById(selected.serverId)?.connected ? 'Status' : 'Last known status'}</dt><dd>{statusLabels[selected.status].label}</dd></div>
          <div><dt>Messages</dt><dd>{selected.messages}</dd></div>
          <div><dt>Last activity</dt><dd>{relativeTime(selected.updatedAt, now)}</dd></div>
        </dl>
        <p className="workspace-review-hint">This preview shows the selected conversation’s details, not its transcript.{!serverById(selected.serverId)?.connected && ' Home server is offline; cached history is read-only.'}</p>
        <div className="dialog-actions"><Button onClick={() => setSelected(null)}>Back to chats</Button></div>
      </div>
    </Modal>}
  </div>;
}

/* ------------------------------------------------------------------ approvals */

type Decision = 'pending' | 'approved' | 'declined';

function ApprovalsPage() {
  const notice = useNotice();
  const [showExample, setShowExample] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [decision, setDecision] = useState<Decision>('pending');

  return <div className="workspace-review-page">
    <PageHeading title="Approvals" description="Actions that need your yes before they run."
      action={<label className="workspace-review-switch">
        <input type="checkbox" role="switch" checked={showExample} onChange={event => {
          setShowExample(event.target.checked);
          setDecision('pending');
        }} />
        <span className="workspace-review-switch-track" aria-hidden="true"><span className="workspace-review-switch-thumb" /></span>
        <span>Show example</span>
      </label>} />

    <Section title="Waiting for you" description={showExample ? 'One action to review.' : undefined}>
      {!showExample ? <EmptyState icon={<ShieldCheck size={22} />} title="Nothing needs your approval"
        description="When a task needs your decision, the action appears here with its purpose and effects."
        action={<Button variant="primary" onClick={() => setShowExample(true)}>Show an example</Button>} />
        : <div className="workspace-review-example">
          <div className="workspace-review-example-head">
            <span className="workspace-review-item-icon"><ShieldCheck size={18} /></span>
            <div className="grow">
              <div className="workspace-review-item-title">
                <span className="list-title">Install a test dependency</span>
                <Badge tone="warning">Example</Badge>
                {decision !== 'pending' && <Badge tone={decision === 'approved' ? 'success' : 'neutral'}>{decision === 'approved' ? 'Approved' : 'Declined'}</Badge>}
              </div>
              <div className="detail-text">Development · {decision === 'pending' ? 'waiting for your review' : decision === 'approved' ? 'approved just now' : 'declined just now'}</div>
            </div>
          </div>
          <p className="workspace-review-item-text">The task wants to add a test runner to the demo project so it can run its own test suite.</p>
          <dl className="workspace-review-facts">
            <div><dt>Server</dt><dd>Development</dd></div>
            <div><dt>Folder</dt><dd>/srv/outpost-demo</dd></div>
            <div><dt>Why it needs you</dt><dd>Task uses Ask permission</dd></div>
          </dl>
          <pre className="workspace-review-command">npm install --save-dev vitest</pre>
          <div className="inline workspace-review-example-actions">
            <Button variant="primary" onClick={() => setReviewing(true)} disabled={decision !== 'pending'}>Review this action</Button>
            <Button variant="ghost" onClick={() => {
              setDecision('declined');
              notice('Example declined in this preview. Nothing ran on Development.');
            }} disabled={decision !== 'pending'}>Decline</Button>
            {decision !== 'pending' && <Button variant="ghost" onClick={() => {
              setDecision('pending');
              setShowExample(false);
            }}>Hide example</Button>}
          </div>

        </div>}
    </Section>

    {!showExample && <p className="workspace-review-hint">What needs a decision depends on the task’s control mode. Ask permission reviews each proposed action; Auto review may also send actions here.</p>}

    {reviewing && <Modal title="Review this action" onClose={() => setReviewing(false)}>
      <div className="stack workspace-review-dialog">
        <p className="workspace-review-hint">Example only. Approval does not run this command.</p>
        <dl className="workspace-review-facts">
          <div><dt>What it does</dt><dd>Adds a test runner to the demo project.</dd></div>
          <div><dt>Where</dt><dd>Development · /srv/outpost-demo</dd></div>
          <div><dt>Why it needs approval</dt><dd>This task uses Ask permission.</dd></div>
        </dl>
        <pre className="workspace-review-command">npm install --save-dev vitest</pre>
        <p>In the app, approving would authorize this dependency installation on Development. If the result is unclear, check the original action status before taking another action. Do not submit a new copy or assume nothing happened.</p>
        <div className="dialog-actions">
          <Button onClick={() => setReviewing(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => {
            setDecision('approved');
            setReviewing(false);
            notice('Example approved in this preview. Nothing ran on Development.');
          }}>Approve example</Button>
        </div>
      </div>
    </Modal>}
  </div>;
}

/* ------------------------------------------------------------------ entry */

export default function WorkspacePages({ page }: { page: WorkspacePage }) {
  if (page === 'automations') return <AutomationsPage />;
  if (page === 'memory') return <MemoryPage />;
  if (page === 'chats') return <ChatsPage />;
  return <ApprovalsPage />;
}
