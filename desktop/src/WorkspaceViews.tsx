import { useState, type ReactNode } from 'react';
import { ArrowUpRight, FileText, NotebookPen } from 'lucide-react';
import type { ChatGroup, OpenChat } from './ChatHistory';
import { EnvironmentContext } from './EnvironmentContext';
import Automations from './Automations';
import { ServerNotes } from './SharedMemory';
import { Button } from './Interface';
import './workspace-refinement.css';
import Artifact from './image-viewer/Artifact';
import { ImageViewerProvider } from './image-viewer/ImageViewer';
import { text, title } from './types';
import type { Connection } from './useConnection';

export type WorkspaceSection = 'outputs' | 'automations' | 'memory';
export const isWorkspaceSection = (section: string): section is WorkspaceSection =>
  section === 'outputs' || section === 'automations' || section === 'memory';
const serverKey = (group: ChatGroup) => group.id ?? 'legacy';
type WorkspaceProps = { groups: ChatGroup[]; connections: Record<string, Connection>; sharedMemory: ReactNode; openChat?: OpenChat };

function MemoryView({ groups, connections, sharedMemory }: WorkspaceProps) {
  const [scope, setScope] = useState<'shared' | 'server'>('shared');
  const [selection, setSelection] = useState('');
  const available = groups.filter(group => !group.archived);
  const server = selection || (available[0] ? serverKey(available[0]) : '');
  return <main className="page workspace-view workspace-refinement">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><NotebookPen size={20} /></span><div><h1>Memory</h1><p>Keep notes for every server or just one.</p></div></div>
    <div className="workspace-toolbar workspace-scope-row">
      <div className="workspace-scope" role="group" aria-label="Where the note is kept">
        <Button aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}>All servers</Button>
        <Button aria-pressed={scope === 'server'} onClick={() => setScope('server')}>One server</Button>
      </div>
      {scope === 'server' && <label><span className="sr-only">Server</span><select aria-label="Server" value={server} onChange={event => setSelection(event.target.value)}>
        {!available.some(group => serverKey(group) === server) && <option value={server}>Select a server</option>}
        {available.map(group => <option key={serverKey(group)} value={serverKey(group)}>{group.label}{connections[serverKey(group)]?.connected ? '' : ' · Offline'}</option>)}
      </select></label>}
    </div>
    {scope === 'shared' ? sharedMemory : <ServerNotes key={server} server={server} groups={groups} connections={connections} />}
  </main>;
}

export default function WorkspaceView({ section, groups, connections, sharedMemory, openChat }: WorkspaceProps & { section: WorkspaceSection }) {
  if (section === 'automations') return <Automations groups={groups} connections={connections} />;
  if (section === 'memory') return <MemoryView groups={groups} connections={connections} sharedMemory={sharedMemory} />;
  const servers = groups.flatMap(group => {
    if (group.archived) return [];
    const key = serverKey(group), connection = connections[key];
    const rows = connection?.records.filter(row => row.kind === 'artifact') ?? [];
    return rows.length && connection ? [{ key, group, connection, rows }] : [];
  });
  const unavailable = groups.filter(group => !connections[serverKey(group)]?.connected && !group.archived);
  return <main className="page workspace-view workspace-refinement">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><FileText size={20} /></span><div><h1>Library</h1><p>Files, screenshots and results from all your servers.</p></div></div>
    {!!unavailable.length && <p className="small">Offline: {unavailable.map(group => group.label).join(', ')}. Previously loaded records may be out of date.</p>}
    {servers.map(({ key, group, connection: owner, rows }) => <section className="workspace-server" key={key} data-server-id={key} aria-label={`${group.label} library`}>
      <div className="section-heading"><h2>{group.label}</h2><span>{owner.connected ? 'Connected' : 'Offline · read-only'}</span></div>
      <EnvironmentContext.Provider value={owner}><ImageViewerProvider records={owner.records}>
        <div className="outputs-grid">{rows.map(record => {
          const taskId = text(record, 'taskId');
          const task = owner.records.find(item => item.kind === 'task' && item.id === taskId);
          const mime = text(record, 'mime');
          const format = mime === 'text/markdown' || /\.(md|markdown)$/i.test(text(record, 'name')) ? 'Markdown' : mime || 'File';
          const size = typeof record.data.size === 'number' && record.data.size >= 0 ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(record.data.size / 1024)} KB` : '';
          return <Artifact key={record.id} record={record} context={[format, size, task ? title(task) : 'Chat not loaded'].filter(Boolean).join(' · ')} action={openChat && <button type="button" className="library-open-chat" disabled={!task} onClick={() => task && openChat(group.id, task.id)}>Open chat<ArrowUpRight size={14} aria-hidden="true" /></button>} />;
        })}</div>
      </ImageViewerProvider></EnvironmentContext.Provider>
    </section>)}
    {!servers.length && <p className="empty-line">{unavailable.length ? 'No records from the servers loaded so far.' : 'No outputs yet.'}</p>}
  </main>;
}
