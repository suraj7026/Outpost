import { useState } from 'react';
import { ArrowLeft, Plus, Server, Settings2, SquareTerminal } from 'lucide-react';
import type { ChatGroup } from '../ChatHistory';
import type { EnvironmentId } from '../api';
import TerminalPane from './TerminalPane';

export default function Machines({ groups }: { groups: ChatGroup[] }) {
  const [selected, setSelected] = useState<{ id: EnvironmentId; label: string } | null>(null);
  if (selected) return <main className="machines-terminal-page">
    <header className="machines-terminal-heading"><div><button onClick={() => setSelected(null)}><ArrowLeft size={14} />Machines</button><h1>{selected.label}</h1></div><a href={`#settings/servers/${selected.id ?? 'legacy'}/setup`}>Connection settings</a></header>
    <TerminalPane key={selected.id ?? 'legacy'} environmentId={selected.id} label={selected.label} fullSize />
  </main>;
  return <main className="page machines-page">
    <div className="page-heading"><span className="page-header-icon" aria-hidden="true"><Server size={20} /></span><div><h1>Machines</h1><p>Manage each server’s connection, models, Pi, devices and recovery—or open its terminal.</p></div><a className="settings-add" href="#settings/servers/new"><Plus size={16} />Add server</a></div>
    <div className="machines-server-list server-settings-list">{groups.filter(group => !group.archived).map(group => <section className="machines-server-card" key={group.id ?? 'legacy'} aria-label={group.label}>
      <Server size={20} aria-hidden="true" /><div><h2>{group.label}</h2><p>{group.connected ? 'Outpost connected' : 'Outpost offline'} · SSH access checked separately</p></div>
      <div className="machines-server-actions"><a className="machine-settings-link" data-server-id={group.id ?? 'legacy'} href={`#settings/servers/${group.id ?? 'legacy'}/general`}><Settings2 size={16} />Manage server</a><button onClick={() => setSelected({ id: group.id, label: group.label })}><SquareTerminal size={18} />Open terminal</button></div>
    </section>)}</div>
    {!groups.some(group => !group.archived) && <p>No saved server connections. <a href="#settings/servers/new">Set up a server</a> to verify SSH access.</p>}
    <p className="small">Up to four shells stay open while you move between chats and Machines. Use Disconnect to release a shell; use tmux for work that must survive disconnects.</p>
  </main>;
}
