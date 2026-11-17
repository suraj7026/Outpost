import { useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { Catalogue, ModelRef } from './types';
import { sameModel, providerLabel } from './types';
import './agent.css';

export default function ModelPicker({ catalogue, value, onChange, disabled = false }: {
  catalogue: Catalogue | null; value: ModelRef | null; onChange: (model: ModelRef) => void; disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const models = catalogue?.models.filter(model => `${model.providerId} ${model.name} ${model.modelId}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <>
    <button ref={trigger} type="button" className="model-picker-trigger" aria-haspopup="dialog" disabled={disabled || !catalogue}
      title={value ? `${providerLabel(value.providerId)} · ${value.modelId}` : 'Choose a provider and model'}
      onClick={() => { setSearch(''); dialog.current?.showModal(); searchInput.current?.focus({ preventScroll: true }); }}>
      <span>{value ? `${providerLabel(value.providerId)} · ${value.modelId}` : catalogue ? 'Choose model' : 'Models unavailable'}</span><ChevronDown size={12} />
    </button>
    <dialog ref={dialog} className="agent-dialog" aria-labelledby="model-picker-title" onCancel={close} onClose={() => trigger.current?.focus()}>
      <header className="agent-dialog-heading"><h2 id="model-picker-title">Model for the next instruction</h2><button type="button" className="ui-close" aria-label="Close model picker" title="Close model picker" onClick={close}><X size={18} aria-hidden="true" /></button></header>
      <p>Changing models does not interrupt the current response. Each request uses the provider you select.</p>
      <input ref={searchInput} autoFocus aria-label="Search models" placeholder="Search providers or models" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="model-results" role="group" aria-label="Available models">
        {models.map(model => <button type="button" key={JSON.stringify([model.providerId, model.modelId])} aria-pressed={sameModel(model, value)}
          onClick={() => { onChange({ providerId: model.providerId, modelId: model.modelId }); close(); }}>
          <span>{model.name}<small>{providerLabel(model.providerId)} · {model.modelId}</small></span>{sameModel(model, value) && <span>Selected</span>}
        </button>)}
        {!models.length && <p>{catalogue?.models.length ? 'No matching models.' : 'No available models. Add a provider in Settings, then refresh.'}</p>}
      </div>
    </dialog>
  </>;
}
