import { useState } from 'react';
import { AnchorMenu, AnchorMenuTrigger, type AnchorMenuItem } from '../anchor-menu/AnchorMenu';
import type { Catalogue, ModelRef } from './types';
import { sameModel, providerLabel } from './types';

export default function ModelPicker({ catalogue, value, onChange, disabled = false }: {
  catalogue: Catalogue | null; value: ModelRef | null; onChange: (model: ModelRef) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const models = catalogue?.models ?? [];
  const items: AnchorMenuItem[] = models.map(model => ({
    key: JSON.stringify([model.providerId, model.modelId]),
    label: model.name,
    description: providerLabel(model.providerId),
    selected: sameModel(model, value),
  }));
  const label = value ? `${providerLabel(value.providerId)} · ${value.modelId}` : catalogue ? 'Choose model' : 'Models unavailable';
  return <>
    <AnchorMenuTrigger data-anchor-menu className="model-picker-trigger" aria-haspopup="dialog" aria-expanded={open}
      disabled={disabled || !catalogue } title={value ? `${providerLabel(value.providerId)} · ${value.modelId}` : 'Choose a provider and model'}
      onClick={() => setOpen(prev => !prev)}>
      <span>{label}</span>
    </AnchorMenuTrigger>
    {open && <AnchorMenu heading="Model" items={items} alignment="end" searchPlaceholder="Search models…" dismiss="select"
      onSelect={key => { const model = models.find(entry => JSON.stringify([entry.providerId, entry.modelId]) === key); if (model) onChange({ providerId: model.providerId, modelId: model.modelId }); }}
      onClose={() => setOpen(false)}
    />}
  </>;
}
