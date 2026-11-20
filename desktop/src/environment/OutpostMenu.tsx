import { useState } from 'react';
import { AnchorMenu, AnchorMenuTrigger, type AnchorMenuItem } from '../anchor-menu/AnchorMenu';

export type OutpostMenuOwner = { environmentId: string | null; label: string; connected: boolean };

export default function OutpostMenu({ owners, selectedId, onSelect, disabled = false }: {
  owners: OutpostMenuOwner[]; selectedId: string | null; onSelect: (id: string | null) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const items: AnchorMenuItem[] = owners.map(owner => ({
    key: ownerKey(owner.environmentId),
    label: owner.label,
    description: owner.connected ? 'Connected' : 'Offline · cached records are read-only',
    icon: <span className={'environment-status ' + (owner.connected ? 'online' : '')} />,
    selected: owner.environmentId === selectedId,
  }));
  const selected = owners.find(owner => ownerKey(owner.environmentId) === ownerKey(selectedId));
  return <>
    <AnchorMenuTrigger data-anchor-menu aria-haspopup="dialog" aria-expanded={open}
      disabled={disabled} onClick={() => setOpen(previous => !previous)}>
      <span aria-hidden="true" className={'environment-status ' + (selected?.connected ? 'online' : '')}></span>
      <span className="environment-picker-label">{selected?.label ?? 'Outpost'}</span>
    </AnchorMenuTrigger>
    {open && <AnchorMenu heading="Choose Outpost" items={items} dismiss="select"
      onSelect={key => { const owner = owners.find(item => ownerKey(item.environmentId) === key); if (owner) onSelect(owner.environmentId); }}
      onClose={() => setOpen(false)}
    />}
  </>;
}

const ownerKey = (id: string | null) => id ?? 'legacy';
