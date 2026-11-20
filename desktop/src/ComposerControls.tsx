import { Children, isValidElement, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Shield, ShieldCheck } from 'lucide-react';
import { AnchorMenu, AnchorMenuTrigger, type AnchorMenuItem } from './anchor-menu/AnchorMenu';
import { autoUnavailable, modeHelp, supportsAuto, type ControlCapabilities, type ControlMode as Mode } from './control-mode';

const modes: { key: Mode; label: string; description: string }[] = [
  { key: 'full_control', label: 'Full control', description: 'Actions run without individual approval' },
  { key: 'auto', label: 'Auto', description: 'Pauses for approval on financial, destructive, security-sensitive, or unclassified actions' },
];

export function ControlMode({ label, value, runtime, reason, onModeChange, ...props }: {
  label: string; value: Mode; runtime: ControlCapabilities | null | undefined; reason?: string; onModeChange: (mode: Mode) => void;
} & { disabled?: boolean }) {
  const helpId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const supported = supportsAuto(runtime);
  const active = modes.find(mode => mode.key === value) ?? modes[0];
  const help = [reason, !supported ? autoUnavailable : '', supported || value !== 'auto' ? modeHelp[value] : ''].filter(Boolean).join(' ');
  const items: AnchorMenuItem[] = modes.map(mode => ({
    key: mode.key, label: mode.label,
    description: mode.key === 'auto' && !supported ? 'Requires a compatible server update' : mode.description,
    icon: mode.key === 'auto' ? <ShieldCheck size={18} /> : <Shield size={18} />,
    tone: mode.key === 'auto' ? 'positive' : 'warning',
    selected: mode.key === value,
    disabled: mode.key === 'auto' && !supported,
  }));
  return <>
    <AnchorMenuTrigger data-anchor-menu data-mode={value} className={value === 'auto' ? 'control-mode-picker control-mode-auto' : 'control-mode-picker'}
      title={help} aria-label={label} aria-describedby={helpId} aria-haspopup="dialog" aria-expanded={menuOpen}
      disabled={props.disabled} onClick={() => setMenuOpen(previous => !previous)}>
      <span className="control-mode-icon" aria-hidden="true">{value === 'auto' ? <ShieldCheck size={18} /> : <Shield size={18} />}</span>
      <span>{active.label}</span>
    </AnchorMenuTrigger>
    {menuOpen && <AnchorMenu heading="Control mode" items={items} dismiss="select"
      onSelect={key => { if (key === 'full_control' || key === 'auto' && supported) onModeChange(key); }}
      onClose={() => setMenuOpen(false)}
    />}
    <span id={helpId} className="sr-only">{help}</span>
  </>;
}

export function ControlModeHelp({ mode, runtime }: { mode: Mode; runtime: ControlCapabilities | null | undefined }) {
  return <p className="small">{mode === 'auto' && !supportsAuto(runtime) ? autoUnavailable : modeHelp[mode]}</p>;
}

export function ComposerModelSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const [open, setOpen] = useState(false);
  const [uncontrolledValue, setUncontrolledValue] = useState(props.defaultValue);
  const select = useRef<HTMLSelectElement>(null);
  const options: { value: string; label: string; disabled: boolean }[] = [];
  const text = (children: ReactNode): string => Children.toArray(children).map(child =>
    isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child),
  ).join('');
  const collect = (children: ReactNode, disabled = false) => {
    Children.forEach(children, child => {
      if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; selected?: boolean }>(child)) return;
      if (child.type === 'option') {
        const label = text(child.props.children);
        options.push({ value: String(child.props.value ?? label), label, disabled: disabled || !!child.props.disabled });
      } else collect(child.props.children, disabled || !!child.props.disabled);
    });
  };
  collect(props.children);
  const value = String(props.value ?? uncontrolledValue ?? options.find(option => !option.disabled)?.value ?? '');
  const items: AnchorMenuItem[] = options.map((option, index) => ({
    key: String(index), label: option.label, disabled: option.disabled, selected: option.value === value,
  }));
  return <>
    <select {...props} ref={select} hidden aria-hidden="true" tabIndex={-1} />
    <AnchorMenuTrigger data-anchor-menu className="model-picker-trigger composer-legacy-model"
      aria-label={props['aria-label'] ?? 'Model'} aria-describedby={props['aria-describedby']}
      aria-haspopup="dialog" aria-expanded={open} title={props.title}
      disabled={props.disabled || !options.length} onClick={() => setOpen(previous => !previous)}>
      <span>{options.find(option => option.value === value)?.label ?? 'Choose model'}</span>
    </AnchorMenuTrigger>
    {open && <AnchorMenu heading="Model" items={items} alignment="end" searchPlaceholder="Search models…" dismiss="select"
      onSelect={key => {
        const option = options[Number(key)];
        if (!option || option.disabled || !select.current) return;
        setUncontrolledValue(option.value);
        select.current.value = option.value;
        select.current.dispatchEvent(new Event('change', { bubbles: true }));
      }}
      onClose={() => setOpen(false)}
    />}
  </>;
}
