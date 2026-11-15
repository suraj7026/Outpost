// Temporary stub of the shared ui contract from design-review/BRIEF.md.
// Used only to typecheck WorkspacePages.tsx; deleted after the check.
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export function Button({ variant = 'secondary', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type="button" data-variant={variant} {...rest}>{children}</button>;
}

export function IconButton({ label, children, active, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={active} {...rest}>{children}</button>;
}

export function SelectField({ label, icon, children, ...rest }:
  SelectHTMLAttributes<HTMLSelectElement> & { label?: string; icon?: ReactNode }) {
  return <label>{icon}{label}{<select {...rest}>{children}</select>}</label>;
}

export function Field({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label>{label}<input {...rest} /></label>;
}

export function Section({ title, description, action, children }: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return <section><header><h2>{title}</h2>{description && <p>{description}</p>}{action}</header>{children}</section>;
}

export function EmptyState({ icon, title, description, action }: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return <div>{icon}<h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' }) {
  return <span data-tone={tone}>{children}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2>{title}</h2>
    {children}
  </dialog>;
}

export function useNotice(): (message: string) => void {
  const [, setMessage] = useState('');
  return (message: string) => setMessage(message);
}
