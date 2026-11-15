import { useState } from 'react';
import { ArrowLeft, Server, TerminalSquare } from 'lucide-react';
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
    <div className="page-heading"><div><h1>Machines</h1><p>Open a shell on the server you choose. Terminal sessions are shared with its chats.</p></div><a href="#settings/servers">Manage servers &amp; setup</a></div>
    <div className="machines-server-list">{groups.filter(group => !group.archived).map(group => <section className="machines-server-card" key={group.id ?? 'legacy'} aria-label={group.label}>
      <Server size={20} aria-hidden="true" /><div><h2>{group.label}</h2><p>{group.connected ? 'Outpost connected' : 'Outpost offline'} · SSH access checked separately</p></div>
      <button onClick={() => setSelected({ id: group.id, label: group.label })}><TerminalSquare size={16} />Open terminal</button>
    </section>)}</div>
    {!groups.some(group => !group.archived) && <p>No saved server connections. <a href="#settings/servers">Set up a server</a> to verify SSH access.</p>}
    <p className="small">Up to four shells stay open while you move between chats and Machines. Use Disconnect to release a shell; use tmux for work that must survive disconnects.</p>
  </main>;
}
