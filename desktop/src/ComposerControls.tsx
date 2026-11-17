import type { SelectHTMLAttributes } from 'react';
import { Shield } from 'lucide-react';

export function ControlMode({ label, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <label className="composer-permission composer-select-field">
    <Shield size={18} aria-hidden="true" />
    <select aria-label={label} {...props}>
      <option value="full_control">Full control</option>
      <option value="ask_permission">Ask permission</option>
      <option value="auto">Auto review</option>
    </select>

  </label>;
}

export function ComposerModelSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="composer-select-field composer-legacy-model"><select {...props} /></span>;
}
