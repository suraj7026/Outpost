import type { AutomationAuthority, AutomationClient } from './automation-form';
import type { Json, ServerRecord } from './types';

export function workspaceBlocker(connection: AutomationAuthority | undefined, native: boolean, preview: boolean): string {
  if (!native || preview) return 'Read-only in browser previews. Open the desktop app to make changes.';
  if (!connection?.connected) return 'Connect this server to make changes.';
  if (connection.retired) return 'This connection is retired. Select its verified replacement.';
  if (!connection.info || connection.info.pending || connection.info.pendingError) return 'Resolve pending work in this server’s recovery settings first.';
  if (connection.busy) return 'Wait for this server’s current operation to finish.';
  return '';
}

export function serverNotePayload(value: string, project: string) {
  const text = value.trim();
  if (!text || text.length > 20000) throw new Error('Enter a note of at most 20,000 characters.');
  if (!project.trim()) throw new Error('Enter the project this note belongs to.');
  return { text, project: project.trim(), identityId: 'owner', source: 'Outpost desktop · server note', provenance: 'owner' as const };
}

export async function saveServerNote(client: AutomationClient | undefined, id: string, value: string, project: string, native: boolean, preview: boolean) {
  const blocked = workspaceBlocker(client, native, preview);
  if (blocked || !client) throw new Error(blocked);
  const payload = serverNotePayload(value, project);
  const result = await client.command('memory.save', id, 0, payload);
  // memory.save allocates its own record ID; the command aggregate ID is not the note ID.
  if (!result || result.kind !== 'memory' || !result.id || result.revision < 1 || result.data.shared === true || result.data.forgotten !== false || result.data.confirmed !== true ||
      Object.entries(payload).some(([key, value]) => result.data[key] !== value)) {
    throw new Error('Couldn’t confirm the save. Check this server’s notes and recovery before creating another note; the save may have succeeded.');
  }
  return result;
}

export function relativeTime(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Time unavailable';
  const seconds = (time - now) / 1000;
  if (Math.abs(seconds) < 60) return 'Just now';
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] = Math.abs(seconds) < 3600 ? ['minute', 60]
    : Math.abs(seconds) < 86400 ? ['hour', 3600] : Math.abs(seconds) < 604800 ? ['day', 86400]
      : Math.abs(seconds) < 2592000 ? ['week', 604800] : Math.abs(seconds) < 31536000 ? ['month', 2592000] : ['year', 31536000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.trunc(seconds / size), unit);
}

export function chatStatus(state: string): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  switch (state) {
    case 'completed': return { label: 'Finished', tone: 'success' };
    case 'running': return { label: 'Running', tone: 'neutral' };
    case 'verifying': return { label: 'Ready for your review', tone: 'warning' };
    case 'waiting_for_approval': return { label: 'Waiting for approval', tone: 'warning' };
    case 'waiting_for_login': return { label: 'Waiting for login', tone: 'warning' };
    case 'queued': return { label: 'Queued', tone: 'neutral' };
    case 'reconciling': return { label: 'Reconciling', tone: 'neutral' };
    case 'failed': return { label: 'Failed · needs attention', tone: 'danger' };
    case 'blocked': return { label: 'Blocked · needs attention', tone: 'warning' };
    case 'paused': return { label: 'Paused', tone: 'neutral' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' };
    default: return { label: state ? state.replaceAll('_', ' ') : 'Status unavailable', tone: 'neutral' };
  }
}

export function loadedMessageCount(records: ServerRecord[] | undefined, taskId: string): number | undefined {
  if (!records) return undefined;
  return new Set(records.filter(row => row.kind === 'message' && row.data.taskId === taskId).map(row => row.id)).size;
}

export function actionSummary(record: ServerRecord): string {
  const tool = typeof record.data.tool === 'string' ? record.data.tool : '';
  if (tool === 'command.run') return 'Run a command in the task’s workspace';
  if (tool === 'host.execute') return 'Run a privileged command on a host';
  if (tool.startsWith('browser.')) return 'Perform a browser action';
  return tool ? `Use the ${tool.replaceAll('.', ' ')} tool` : 'Review a proposed action';
}

export function exactValue(value: Json | undefined): string {
  return value === undefined || value === null || value === '' ? 'Not supplied by the server' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function displayTimeZones(current: string): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, current, ...supported])].filter(zone => {
    try { new Intl.DateTimeFormat(undefined, { timeZone: zone }); return true; } catch { return false; }
  }).sort();
}
