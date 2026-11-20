import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import { nativeApp, recordedPreview } from './api';
import type { ChatGroup } from './ChatHistory';
import type { Connection } from './useConnection';
import { title, type ServerRecord } from './types';
import {
  automationBlocker,
  buildSchedule,
  calendarWeekdays,
  compileCalendarExpression,
  deleteAutomation,
  formatCalendarSlot,
  legacyModelSelection,
  modelRefSelection,
  previewCalendarOnServer,
  readSchedule,
  saveAutomation,
  scheduleDraft,
  scheduleFrequencyLabel,
  scheduleTime,
  validNamedZone,
  type AutomationDraft,
  type AutomationSchedule,
  type CalendarFold,
  type CalendarPreset,
  type CalendarPreviewSlot,
} from './automation-form';
import { Badge, Button, Dialog } from './Interface';
import { ControlMode, ControlModeHelp } from './ComposerControls';
import { modeBlocker } from './control-mode';
import { displayTimeZones } from './workspace-presentation';
import './workspace-refinement.css';

type Editor = { server: string; id: string; revision: number; initial?: AutomationSchedule };
type DeleteTarget = { server: string; serverLabel: string; id: string; revision: number; name: string };
const serverKey = (group: ChatGroup) => group.id ?? 'legacy';

function modelOptions(connection: Connection | undefined) {
  return connection?.runtime?.piManagement
    ? (connection.agentCatalogue?.models ?? []).map(model => ({ value: modelRefSelection({ providerId: model.providerId, modelId: model.modelId }), label: `${model.name} · ${model.providerId}` }))
    : (connection?.models ?? []).map(model => ({ value: legacyModelSelection(model), label: model }));
}

function ScheduleDialog({ editor, groups, connections, close, saved }: {
  editor: Editor; groups: ChatGroup[]; connections: Record<string, Connection>; close: () => void; saved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const [server, setServer] = useState(editor.server);
  const [draft, setDraft] = useState(() => scheduleDraft(editor.initial));
  const [zoneSearch, setZoneSearch] = useState('');
  const timeZones = useMemo(() => displayTimeZones(draft.timezone), [draft.timezone]);
  const zones = timeZones.filter(zone => zone === draft.timezone || zone.toLowerCase().includes(zoneSearch.trim().toLowerCase()));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [previewSlots, setPreviewSlots] = useState<CalendarPreviewSlot[]>([]);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [previewMessage, setPreviewMessage] = useState('');
  const writing = useRef(false), latest = useRef(connections); latest.current = connections;
  const owner = connections[server], options = modelOptions(owner);
  const serverAvailable = groups.some(group => !group.archived && serverKey(group) === server);
  const blocker = !serverAvailable ? 'This server was removed. Close this schedule.' : automationBlocker(owner, nativeApp(), recordedPreview()) || modeBlocker(draft.mode, owner?.runtime);
  const current = owner?.records.find(record => record.kind === 'automation' && record.id === editor.id);
  const stale = editor.revision > 0 && (!current || current.revision !== editor.revision);
  const unavailableModel = !!draft.model && !options.some(option => option.value === draft.model);
  const field = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const toggleWeekday = (day: number) => setDraft(previous => {
    const next = previous.calendarDays.includes(day)
      ? previous.calendarDays.filter(value => value !== day)
      : [...previous.calendarDays, day].sort((a, b) => a - b);
    return { ...previous, calendarDays: next };
  });

  useEffect(() => {
    const element = dialog.current, trigger = document.activeElement;
    element?.showModal();
    nameInput.current?.focus({ preventScroll: true });
    return () => { element?.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, []);

  useEffect(() => {
    if (draft.frequency !== 'calendar') {
      setPreviewSlots([]); setPreviewState('idle'); setPreviewMessage('');
      return;
    }
    if (!validNamedZone(draft.timezone)) {
      setPreviewSlots([]); setPreviewState('error'); setPreviewMessage('Choose a valid named IANA time zone.');
      return;
    }
    let expression: string;
    try {
      expression = compileCalendarExpression(draft.calendarPreset, draft.calendarTime, draft.calendarDays, draft.calendarExpression);
    } catch (cause) {
      setPreviewSlots([]); setPreviewState('error'); setPreviewMessage(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const connection = latest.current[server];
    if (!connection?.connected) {
      setPreviewSlots([]); setPreviewState('error'); setPreviewMessage('Connect this server to preview upcoming runs.');
      return;
    }
    let cancelled = false;
    setPreviewState('loading'); setPreviewMessage('');
    const timer = setTimeout(() => {
      void previewCalendarOnServer(latest.current[server], {
        kind: 'cron', expression, timezone: draft.timezone, gap: 'skip', fold: draft.calendarFold,
      }, 3).then(result => {
        if (cancelled) return;
        if (result.status === 'search-limit' || !result.occurrences.length) {
          setPreviewSlots([]); setPreviewState('empty');
          setPreviewMessage(result.status === 'search-limit' ? 'Calendar preview reached the server search limit.' : 'No upcoming runs found within the calendar horizon.');
          return;
        }
        setPreviewSlots(result.occurrences); setPreviewState('ready'); setPreviewMessage('');
      }).catch(cause => {
        if (cancelled) return;
        setPreviewSlots([]); setPreviewState('error');
        setPreviewMessage(cause instanceof Error ? cause.message : String(cause));
      });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft.frequency, draft.calendarPreset, draft.calendarTime, draft.calendarDays, draft.calendarExpression, draft.calendarFold, draft.timezone, server, owner?.connected]);

  const submit = async () => {
    if (writing.current) return;
    setError('');
    try {
      const connection = latest.current[server];
      if (!serverAvailable) throw new Error('This server was removed. Close this schedule.');
      if (draft.model && !modelOptions(connection).some(option => option.value === draft.model)) throw new Error('The selected model is unavailable on this server. Choose an available model or the server default.');
      const schedule = buildSchedule(draft, editor.initial);
      writing.current = true; setBusy(true);
      await saveAutomation(connection, editor.id, editor.revision, schedule, nativeApp(), recordedPreview());
      saved(editor.revision ? 'Schedule updated.' : 'Schedule created.'); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { writing.current = false; setBusy(false); }
  };
  const dismiss = () => { if (!writing.current) close(); };
  return <dialog className="workspace-dialog workspace-form-dialog schedule-dialog" ref={dialog} aria-labelledby="schedule-dialog-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header className="ui-dialog-heading"><h2 id="schedule-dialog-title">{editor.revision ? 'Edit schedule' : 'New schedule'}</h2><Button className="ui-close" variant="ghost" aria-label="Close dialog" title="Close dialog" disabled={busy} onClick={dismiss}><X size={18} aria-hidden="true" /></Button></header>
      <div className="dialog-form-body">
      <fieldset disabled={busy} className="workspace-fields">
        <label>Schedule name<input ref={nameInput} autoFocus required value={draft.name} onChange={event => field('name', event.target.value)} /></label>
        <label>What should it do?<textarea required maxLength={20000} rows={4} value={draft.goal} onChange={event => field('goal', event.target.value)} /></label>
        <label>Server<select value={server} disabled={!!editor.revision} onChange={event => { setServer(event.target.value); field('model', ''); }}>
          {groups.filter(group => !group.archived).map(group => <option key={serverKey(group)} value={serverKey(group)}>{group.label}{group.connected ? '' : ' · Offline'}</option>)}
        </select></label>
        <label>Task profile<select value={draft.profile} onChange={event => field('profile', event.target.value)}>{['code', 'browser', 'operations', 'research', 'cowork', 'chat'].map(profile => <option key={profile} value={profile}>{profile[0].toUpperCase() + profile.slice(1)}</option>)}</select></label>
        <ControlMode label="Schedule control mode" value={draft.mode} runtime={owner?.runtime} onModeChange={mode => field('mode', mode)} />
        <ControlModeHelp mode={draft.mode} runtime={owner?.runtime} />
        <label>Model<select value={draft.model} onChange={event => field('model', event.target.value)}>
          <option value="">Server default at run time</option>
          {unavailableModel && <option value={draft.model}>Previously selected model · unavailable</option>}
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <div className="workspace-two-col">
          <label>How often<select aria-label="How often" value={draft.frequency} onChange={event => {
            const value = event.target.value;
            field('frequency', value === 'once' || value === 'interval' || value === 'calendar' ? value : 'once');
          }}>
            <option value="once">One time</option>
            <option value="interval">Fixed interval</option>
            <option value="calendar">Calendar schedule</option>
          </select></label>
          {draft.frequency === 'interval' && <label>Interval in minutes<input type="number" min={1} step="any" required value={draft.intervalMinutes} onChange={event => field('intervalMinutes', event.target.value)} /></label>}
          {draft.frequency === 'calendar' && <label>Calendar preset<select aria-label="Calendar preset" value={draft.calendarPreset} onChange={event => field('calendarPreset', event.target.value as CalendarPreset)}>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Weekly on selected days</option>
            <option value="custom">Custom five-field cron</option>
          </select></label>}
        </div>
        {draft.frequency === 'calendar' ? <>
          {draft.calendarPreset !== 'custom' ? <label>Local time (HH:MM)<input type="time" required value={draft.calendarTime} onChange={event => field('calendarTime', event.target.value)} /></label>
            : <label>Five-field cron expression<input type="text" required placeholder="0 9 * * 1-5" value={draft.calendarExpression} onChange={event => field('calendarExpression', event.target.value)} /></label>}
          {draft.calendarPreset === 'weekly' && <div role="group" aria-label="Days of week">
            <span className="small">Days of week</span>
            <div className="workspace-weekday-picker">{calendarWeekdays.map(day => <button key={day.value} type="button" aria-pressed={draft.calendarDays.includes(day.value)} onClick={() => toggleWeekday(day.value)}>{day.label}</button>)}</div>
          </div>}
          <label>Find a time zone<input type="search" value={zoneSearch} placeholder="Search city or region" onChange={event => setZoneSearch(event.target.value)} /></label>
          <label>Schedule time zone<select aria-label="Schedule time zone" required value={draft.timezone} onChange={event => field('timezone', event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <p className="small">This IANA time zone controls when the schedule fires and keeps local time across daylight-saving changes. Non-existent spring-forward times are skipped.</p>
          <label>Repeated fall-back hour<select aria-label="Repeated fall-back hour" value={draft.calendarFold} onChange={event => field('calendarFold', event.target.value as CalendarFold)}>
            <option value="earlier">Run at the earlier time (default)</option>
            <option value="later">Run at the later time</option>
            <option value="both">Run at both times</option>
          </select></label>
          <div className="workspace-preview-box" aria-live="polite">
            <strong>Next 3 runs ({draft.timezone})</strong>
            {previewState === 'loading' && <p className="small">Calculating upcoming runs on server…</p>}
            {previewState === 'ready' && <ol className="workspace-preview-list">{previewSlots.map(slot => <li key={`${slot.scheduledAt}:${slot.fold}`}>{formatCalendarSlot(slot, draft.timezone)}</li>)}</ol>}
            {previewState === 'empty' && <p className="small">{previewMessage}</p>}
            {previewState === 'error' && <p className="small error-text">{previewMessage}</p>}
          </div>
          <label>Missed runs<select value={draft.missed} onChange={event => field('missed', event.target.value)}><option value="coalesce">Run one catch-up task</option><option value="skip">Skip missed occurrences</option></select></label>
        </> : <>
          <label>{editor.revision ? 'Next start' : 'First start'} · this Mac’s time ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input type="datetime-local" required value={draft.start} onChange={event => field('start', event.target.value)} /></label>
          <label>Find a time zone<input type="search" value={zoneSearch} placeholder="Search city or region" onChange={event => setZoneSearch(event.target.value)} /></label>
          <label>Display time zone<select aria-label="Display time zone" required value={draft.timezone} onChange={event => field('timezone', event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <p className="small">Start uses this Mac’s time zone; the display zone does not change the instant.{draft.frequency === 'interval' && ' Fixed intervals use elapsed time. Daylight-saving changes can shift the local hour.'}</p>
          <details className="workspace-sync"><summary>Timing and catch-up details</summary><p className="small">Every 1,440 minutes is every 24 hours, not daily at a local time. The display zone changes only how the saved instant is shown. Choose Calendar schedule for wall-clock times across daylight-saving changes. One-time schedules pause after firing. An overdue start may run as soon as the server scheduler resumes.</p></details>
          {draft.frequency === 'interval' && <label>Missed intervals<select value={draft.missed} onChange={event => field('missed', event.target.value)}><option value="coalesce">Run one catch-up task</option><option value="skip">Skip intervals overdue by a full interval</option></select></label>}
        </>}
        {editor.initial?.paused && <p className="small">Saving changes keeps this schedule paused.</p>}
      </fieldset>
      {blocker && <p className="small" role="status">{blocker}</p>}
      {stale && <p role="alert" className="error-text">This schedule changed on the server. Close and reopen it before saving.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <footer className="workspace-dialog-actions"><button type="button" disabled={busy} onClick={dismiss}>Cancel</button><button className="primary" disabled={busy || !!blocker || stale || unavailableModel}>{busy ? 'Saving…' : editor.revision ? 'Save changes' : 'Create schedule'}</button></footer>
    </form>
  </dialog>;
}

function DeleteScheduleDialog({ target, connections, close, deleted }: {
  target: DeleteTarget; connections: Record<string, Connection>; close: () => void; deleted: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const writing = useRef(false), latest = useRef(connections); latest.current = connections;
  const owner = connections[target.server];
  const blocker = automationBlocker(owner, nativeApp(), recordedPreview());
  const current = owner?.records.find(record => record.kind === 'automation' && record.id === target.id);
  const stale = !current || current.revision !== target.revision;
  const confirm = async () => {
    if (writing.current) return;
    setError('');
    try {
      writing.current = true; setBusy(true);
      await deleteAutomation(latest.current[target.server], target.id, target.revision, nativeApp(), recordedPreview());
      deleted('Schedule deleted. Tasks already started are not stopped.');
      close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { writing.current = false; setBusy(false); }
  };
  return <Dialog title="Delete schedule?" busy={busy} onClose={() => { if (!writing.current) close(); }} className="workspace-dialog"
    footer={<><Button variant="secondary" disabled={busy} onClick={() => { if (!writing.current) close(); }}>Cancel</Button><Button variant="danger" disabled={busy || !!blocker || stale} onClick={() => void confirm()}>{busy ? 'Deleting…' : 'Delete schedule'}</Button></>}>
    <p>Permanently delete <strong>{target.name}</strong> from {target.serverLabel}?</p>
    <p className="small">Future occurrences will stop. Tasks already queued or running are not cancelled.</p>
    {blocker && <p className="small" role="status">{blocker}</p>}
    {stale && <p role="alert" className="error-text">This schedule changed or was already deleted on the server. Close this dialog to review the latest list.</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </Dialog>;
}

export default function Automations({ groups, connections }: { groups: ChatGroup[]; connections: Record<string, Connection> }) {
  const [editor, setEditor] = useState<Editor | null>(null), [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [working, setWorking] = useState(false), writing = useRef(false);
  const latest = useRef(connections); latest.current = connections;
  const available = groups.filter(group => !group.archived);
  const first = available.find(group => !automationBlocker(connections[serverKey(group)], nativeApp(), recordedPreview()));
  const servers = available.map(group => ({ group, connection: connections[serverKey(group)], rows: connections[serverKey(group)]?.records.filter(row => row.kind === 'automation') ?? [] }));
  const count = servers.reduce((total, server) => total + server.rows.length, 0);
  const toggle = async (server: string, record: ServerRecord, schedule: AutomationSchedule) => {
    if (writing.current) return;
    writing.current = true; setWorking(true); setError(''); setNotice('');
    try {
      await saveAutomation(latest.current[server], record.id, record.revision, { ...schedule, paused: !schedule.paused }, nativeApp(), recordedPreview());
      setNotice(schedule.paused ? 'Schedule resumed. An overdue start may run immediately.' : 'Schedule paused. Tasks already started are not stopped.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { writing.current = false; setWorking(false); }
  };
  const modalOpen = !!editor || !!deleteTarget;
  return <main className="page workspace-refinement workspace-view">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><CalendarClock size={20} /></span><div><h1>Automations</h1><p>Scheduled tasks, kept on the server that runs them.</p></div><button className="primary" disabled={!first || working || modalOpen} onClick={() => first && setEditor({ server: serverKey(first), id: crypto.randomUUID(), revision: 0 })}><Plus size={15} /> New schedule</button></div>
    {!first && <p className="small">{automationBlocker(available.length ? connections[serverKey(available[0])] : undefined, nativeApp(), recordedPreview())} <a href="#settings/servers">Manage servers</a></p>}
    {notice && <p role="status">{notice}</p>}{error && <p className="error-text" role="alert">{error}</p>}
    {servers.map(({ group, connection, rows }) => <section key={serverKey(group)} className="workspace-server" aria-label={`${group.label} automations`}>
      <div className="section-heading"><h2>{group.label}</h2><span>{connection?.connected ? `${rows.length} schedules` : 'Offline · cached / read-only'}</span></div>
      {connection?.error && <p className="error-text" role="alert">{connection.error}</p>}
      {(connection?.info?.pending || connection?.info?.pendingError) && <p><a href={`#settings/servers/${serverKey(group)}/recovery`}>Resolve pending work on {group.label}</a></p>}
      <div className="workspace-list">{rows.map(record => {
        const schedule = readSchedule(record), blocked = automationBlocker(connection, nativeApp(), recordedPreview());
        const itemName = schedule?.name ?? title(record);
        return <article className="workspace-item" key={record.id}>
          <CalendarClock size={19} aria-hidden="true" /><div className="workspace-item-body">
            <div className="workspace-item-heading"><h3>{itemName}</h3>{schedule && <Badge tone={!connection?.connected ? 'neutral' : schedule.paused ? 'warning' : 'success'}>{!connection?.connected ? 'Last known: ' : ''}{schedule.paused ? !schedule.calendar && schedule.intervalMs === null && schedule.nextAt < Date.now() ? 'Paused · may have run' : 'Paused' : 'Scheduled'}</Badge>}</div>
            {schedule ? <><p className="small">{scheduleFrequencyLabel(schedule)} · {schedule.paused ? 'Saved start' : 'Next start'}: {scheduleTime(schedule)} ({schedule.timezone}) · {schedule.task.mode === 'auto' ? 'Auto' : 'Full control'}</p><p className="workspace-schedule-goal">{schedule.task.goal}</p>
              <details className="workspace-sync"><summary>Schedule details</summary><p className="workspace-note">{schedule.task.goal}</p><p className="small">Profile: {schedule.task.profile} · Model: {schedule.task.modelRef ? `${schedule.task.modelRef.providerId} / ${schedule.task.modelRef.modelId}` : schedule.task.model || 'Server default at run time'}</p>{schedule.calendar ? <p className="small">Calendar: <code>{schedule.calendar.expression}</code> in {schedule.calendar.timezone} (spring gap: {schedule.calendar.gap}, fall-back fold: {schedule.calendar.fold}). Missed runs: {schedule.missed === 'coalesce' ? 'Run one catch-up task' : 'Skip missed occurrences'}.</p> : <p className="small">Missed intervals: {schedule.missed === 'coalesce' ? 'Run one catch-up task' : 'Skip intervals overdue by a full interval'}. {schedule.intervalMs !== null && 'Elapsed-time intervals can shift the local hour at daylight-saving changes.'}</p>}</details>
              {schedule.paused && schedule.nextAt <= Date.now() && <p className="small">Resuming can start a task immediately. Edit the start first if you want a future run.</p>}
            </> : <p className="small">This record doesn’t match the supported server schedule format. It is read-only; no fields will be discarded.</p>}
            {schedule && modeBlocker(schedule.task.mode, connection?.runtime) && <p className="small" role="status">{modeBlocker(schedule.task.mode, connection?.runtime)}</p>}
            {blocked && <p className="small">{blocked}</p>}
          </div>
          <div className="workspace-item-actions">
            {schedule && <><button disabled={!!blocked || working || modalOpen} onClick={() => setEditor({ server: serverKey(group), id: record.id, revision: record.revision, initial: schedule })}>Edit</button><button disabled={!!blocked || working || modalOpen || !!modeBlocker(schedule.task.mode, connection?.runtime)} onClick={() => void toggle(serverKey(group), record, schedule)}>{schedule.paused ? <Play size={13} /> : <Pause size={13} />}{schedule.paused ? 'Resume' : 'Pause'}</button></>}
            <button disabled={!!blocked || working || modalOpen} onClick={() => setDeleteTarget({ server: serverKey(group), serverLabel: group.label, id: record.id, revision: record.revision, name: itemName })}><Trash2 size={13} aria-hidden="true" />Delete</button>
          </div>
        </article>;
      })}</div>
      {!rows.length && <p className="small">{connection?.connected ? 'No schedules on this server.' : 'Connect to load its schedules.'}</p>}
    </section>)}
    {!count && <div className="workspace-empty"><CalendarClock size={24} aria-hidden="true" /><h2>No automations yet</h2><p>Create a one-time, fixed-interval, or calendar schedule on a connected server.</p></div>}
    <p className="small">Fixed intervals use elapsed time, not a calendar: daylight-saving changes can shift the local hour. Calendar schedules stay on wall-clock time in their chosen IANA time zone.</p>
    <details className="workspace-sync"><summary>How schedules run, pause, and delete</summary><p className="small">Schedules run on their server even when this Mac is closed, while the scheduler is running. One-time schedules pause after firing. Calendar schedules stay on local time across daylight-saving changes in their chosen IANA time zone. Pausing does not delete a schedule or cancel tasks already started. Deleting permanently removes the schedule without cancelling tasks already started.</p></details>
    {editor && <ScheduleDialog editor={editor} groups={groups} connections={connections} close={() => setEditor(null)} saved={setNotice} />}
    {deleteTarget && <DeleteScheduleDialog target={deleteTarget} connections={connections} close={() => setDeleteTarget(null)} deleted={setNotice} />}
  </main>;
}
