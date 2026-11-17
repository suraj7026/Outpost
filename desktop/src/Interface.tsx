import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './interface.css';

export function Button({ variant = 'secondary', className = '', type = 'button', onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`ui-button ui-button-${variant} ${className}`} {...props} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onClick?.(event); }} />;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={`ui-badge ui-badge-${tone}`}>{children}</span>;
}
export function Section({ title, description, action, children, className = '' }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`ui-section ${className}`}><div className="ui-section-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}
export function SettingRow({ title, description, icon, children, className = '' }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={`ui-row ${className}`}>{icon && <span className="ui-row-icon" aria-hidden="true">{icon}</span>}<div className="ui-row-content"><strong>{title}</strong>{description && <div className="ui-row-description">{description}</div>}</div>{children && <div className="ui-row-actions">{children}</div>}</div>;
}
export function Dialog({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current, previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={element} className={`ui-dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="ui-dialog-heading"><h2 id={titleId}>{title}</h2><Button className="ui-close" variant="ghost" aria-label="Close dialog" title="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></Button></header>
    <div className="ui-dialog-body">{children}</div>
  </dialog>;
}
