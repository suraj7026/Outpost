import { useState } from 'react';
import { ArrowLeft, Plus, Server, Settings2, SquareTerminal } from 'lucide-react';
import type { ChatGroup } from '../ChatHistory';
import type { EnvironmentId } from '../api';
import { ServerUpdateIcon, ServerUpdateIndicator, useAutomaticUpdates } from '../AutomaticUpdates';
import TerminalPane from './TerminalPane';

export default function Machines({ groups }: { groups: ChatGroup[] }) {
  const updates = useAutomaticUpdates();
  const [selected, setSelected] = useState<{ id: EnvironmentId; label: string } | null>(null);
  if (selected) return <main className="machines-terminal-page">
    <header className="machines-terminal-heading"><div><button onClick={() => setSelected(null)}><ArrowLeft size={14} />Machines</button><h1>{selected.label}</h1></div><a href={`#settings/servers/${selected.id ?? 'legacy'}/setup`}>Connection settings</a></header>
    <TerminalPane key={selected.id ?? 'legacy'} environmentId={selected.id} label={selected.label} fullSize />
  </main>;
  return <main className="page machines-page">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><Server size={20} /></span><div><h1>Machines</h1><p>Your connected servers.</p></div><a className="settings-add" href="#settings/servers/new"><Plus size={16} />Add server</a></div>
    <div className="machines-server-list server-settings-list">{groups.filter(group => !group.archived).map(group => <section className="machines-server-card" key={group.id ?? 'legacy'} aria-label={group.label}>
      <Server size={20} aria-hidden="true" /><div><h2>{group.label}</h2><p>{!group.connected ? 'Offline' : updates?.status?.servers.find(server => server.environmentId === group.id)?.state === 'complete' ? 'Up to date' : 'Connected'}</p></div>
      <div className="machines-server-actions">{group.id && <a className="machine-update-link" aria-label={`Update ${group.label}`} title="Update server" href={`#settings/servers/${group.id}/runtime/update`}><ServerUpdateIcon size={18} /><ServerUpdateIndicator environmentId={group.id} /></a>}<a className="machine-settings-link" data-server-id={group.id ?? 'legacy'} href={`#settings/servers/${group.id ?? 'legacy'}/general`}><Settings2 size={16} />Manage server</a><button onClick={() => setSelected({ id: group.id, label: group.label })}><SquareTerminal size={18} />Open terminal</button></div>
    </section>)}</div>
    {!groups.some(group => !group.archived) && <p>No saved server connections. <a href="#settings/servers/new">Set up a server</a> to verify SSH access.</p>}
    <p className="small">Updates start automatically when an enrolled server connects.</p>
  </main>;
}
