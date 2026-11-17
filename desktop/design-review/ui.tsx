import { createContext, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown, X } from 'lucide-react';

export function Button({ variant = 'secondary', className = '', type = 'button', onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`review-button ${variant} ${className}`} {...props} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onClick?.(event); }} />;
}
export function IconButton({ label, active, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <Button className={`review-icon-button ${active ? 'is-active' : ''} ${className}`} variant="ghost" aria-label={label} title={label} {...props} />;
}
export function Field({ label, id, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const generated = useId();
  return <label className="field" htmlFor={id ?? generated}><span>{label}</span><input id={id ?? generated} className={`review-input ${className}`} {...props} /></label>;
}
export function SelectField({ label, icon, compact = false, className = '', children, id, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; icon?: ReactNode; compact?: boolean }) {
  const generated = useId();
  return <label className={`field review-select ${compact ? 'compact' : ''} ${className}`} htmlFor={id ?? generated}>
    {label && !compact && <span>{label}</span>}
    <span className={`review-select-surface ${props.disabled ? 'is-disabled' : ''}`}>
      {icon && <span className="review-select-icon" aria-hidden="true">{icon}</span>}
      <select id={id ?? generated} aria-label={props['aria-label'] ?? label} {...props}>{children}</select>
      <ChevronDown className="review-select-chevron" size={14} aria-hidden="true" />
    </span>
  </label>;
}
export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return <section className="review-section"><div className="review-section-heading"><div className="grow"><h2>{title}</h2>{description && <p className="muted small">{description}</p>}</div>{action}</div>{children}</section>;
}
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning'; children: ReactNode }) {
  return <span className={`review-badge ${tone}`}>{children}</span>;
}
export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="review-empty"><span className="review-empty-icon">{icon}</span><h2>{title}</h2><p>{description}</p>{action}</div>;
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="review-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRef.current(); } }}>
    <div className="review-dialog-heading"><h2 id={titleId}>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X /></IconButton></div>
    <div className="review-dialog-body">{children}</div>
  </dialog>;
}
const NoticeContext = createContext<(message: string) => void>(() => {});
export const useNotice = () => useContext(NoticeContext);
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timeout); }, [notice]);
  return <NoticeContext.Provider value={setNotice}>{children}<div className={`review-toast ${notice ? 'visible' : ''}`} role="status">{notice}</div></NoticeContext.Provider>;
}
