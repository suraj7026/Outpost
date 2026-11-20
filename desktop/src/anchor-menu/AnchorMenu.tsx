import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import './anchor-menu.css';

export function AnchorMenuTrigger({ children, chevron, ...props }: { children: ReactNode; chevron?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={'anchor-menu-trigger' + (props.className ? ' ' + props.className : '')}>
    {children}{chevron !== false && <ChevronDown size={14} aria-hidden="true" className="anchor-menu-chevron" />}
  </button>;
}

export type AnchorMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  tone?: 'positive' | 'warning' | 'danger' | 'muted';
  selected: boolean;
  disabled?: boolean;
};

export function AnchorMenu({ heading, items, onSelect, onClose, alignment = 'start', searchPlaceholder, children, dismiss = 'close' }: {
  heading: string; items: AnchorMenuItem[]; onSelect: (key: string) => void; onClose: (restoreFocus: boolean) => void;
  alignment?: 'start' | 'end'; searchPlaceholder?: string; children?: ReactNode;
  dismiss?: 'close' | 'select';
}) {
  const menu = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState('');
  useLayoutEffect(() => {
    const panel = menu.current;
    if (!panel) return;
    const host = panel.previousElementSibling instanceof HTMLButtonElement ? panel.previousElementSibling : document.activeElement instanceof HTMLButtonElement ? document.activeElement : document.querySelector<HTMLButtonElement>("[data-anchor-menu][aria-expanded=\"true\"]");
    anchor.current = host;
    if (!host) return;
    const position = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.min(340, innerWidth - 24);
      panel.style.width = width + "px";
      panel.style.maxHeight = Math.max(80, innerHeight - 24) + "px";
      const height = panel.offsetHeight;
      const below = rect.bottom + 6, above = rect.top - height - 6;
      let top = heading === "Choose Outpost" ? below : above;
      if (top < 12) top = below;
      if (top + height > innerHeight - 12 && above >= 12) top = above;
      const left = alignment === "end" ? rect.right - width : rect.left;
      panel.style.left = Math.max(12, Math.min(left, innerWidth - width - 12)) + "px";
      panel.style.top = Math.max(12, Math.min(top, innerHeight - height - 12)) + "px";
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [alignment, heading, search]);
  useEffect(() => {
    const panel = menu.current, host = anchor.current;
    if (!panel || !host) return;
    host.dispatchEvent(new CustomEvent("outpost-menu-open", { bubbles: true }));
    const close = (restore: boolean) => { onClose(restore); if (restore && host.isConnected) host.focus({ preventScroll: true }); };
    const pointer = (event: PointerEvent) => { if (event.target instanceof Node && !panel.contains(event.target) && !host.contains(event.target)) close(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !panel.contains(event.target) && !host.contains(event.target)) close(false); };
    const other = (event: Event) => { if (event.target !== host) close(false); };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("outpost-menu-open", other);
    (panel.querySelector<HTMLInputElement>("input") ?? panel.querySelector<HTMLButtonElement>("[aria-selected=\"true\"]:not(:disabled), button:not(:disabled)"))?.focus({ preventScroll: true });
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus); document.removeEventListener("outpost-menu-open", other); };
  }, []);
  const filtered = items.filter(item => !search || `${item.label} ${item.description ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const rows = [...menu.current?.querySelectorAll<HTMLButtonElement>('.anchor-menu-row:not([disabled])') ?? []];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? (current + 1) % rows.length : (current <= 0 ? rows.length : current) - 1;
    rows[next].focus();
  };
  return <div ref={menu} className="anchor-menu" role="dialog" aria-label={heading} onKeyDown={onKeyDown} data-alignment={alignment}
    onMouseDown={event => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (!button || !event.currentTarget.contains(button) || button.disabled) return;
      // WebKit otherwise focuses the surrounding panel and dismisses the menu before click.
      event.preventDefault();
      button.focus({ preventScroll: true });
    }}
  >
    {searchPlaceholder && <label className="anchor-menu-search">
      <Search size={16} aria-hidden="true" />
      <input autoFocus type="search" placeholder={searchPlaceholder} value={search} onChange={event => setSearch(event.target.value)} aria-label={(searchPlaceholder.endsWith('…') ? searchPlaceholder.slice(0, -1) : searchPlaceholder).trim()} />
    </label>}
    <p className="anchor-menu-heading">{heading}</p>
    <div className="anchor-menu-list" role="listbox" aria-label={heading}>
      {filtered.map(item => <button
        type="button" key={item.key} role="option" aria-selected={item.selected} className={'anchor-menu-row' + (item.tone ? ' anchor-menu-' + item.tone : '')}
        disabled={item.disabled}
        onClick={() => {
          onSelect(item.key);
          onClose(true);
          anchor.current?.focus({ preventScroll: true });
        }}
      >
        {item.icon && <span className={'anchor-menu-icon' + (item.tone ? ' anchor-menu-' + item.tone : '')} aria-hidden="true">{item.icon}</span>}
        <span className="anchor-menu-copy"><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
        <Check size={16} aria-hidden="true" className="anchor-menu-check" />
      </button>)}
      {!filtered.length && <p className="anchor-menu-empty">No matches.</p>}
    </div>
    {children && <div className="anchor-menu-footer">{children}</div>}
  </div>;
}
