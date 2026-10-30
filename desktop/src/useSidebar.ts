import { useEffect, useRef, useState } from "react";
import { call, nativeApp, recordedPreview } from "./api";
import type { Appearance } from "./appearance";
import { useSidebarMotion } from "./useSidebarMotion";

export function useSidebar(appearance: Appearance, narrow: boolean) {
  const [peek, setPeek] = useState(false);
  const [nativeError, setNativeError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const keyboard = useRef(false);
  const chromeQueue = useRef<Promise<void>>(Promise.resolve());
  const pinned = !appearance.sidebarCollapsed;
  const docked = pinned && !narrow;
  const visible = docked || peek;
  const motion = useSidebarMotion(panel, visible);
  const native = nativeApp() && !recordedPreview() && navigator.userAgent.includes("Macintosh");
  const latest = useRef({ pinned, visible });
  latest.current = { pinned, visible };
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; };
  const dismiss = () => {
    cancel(); keyboard.current = false; setPeek(false);
    if (panel.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>(".main-shell")?.focus({ preventScroll: true });
    }
  };
  const reveal = (fromKeyboard = false) => {
    if (document.querySelector("dialog[open]")) return;
    cancel(); keyboard.current = fromKeyboard; setPeek(true);
    if (fromKeyboard) requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
  };
  const hasKeyboardFocus = () => keyboard.current && panel.current?.contains(document.activeElement);
  const scheduleDismiss = () => {
    cancel();
    if (latest.current.pinned || hasKeyboardFocus()) return;
    timer.current = setTimeout(() => {
      if (!pointerInside.current && !hasKeyboardFocus() && !latest.current.pinned) dismiss();
    }, 350);
  };
  useEffect(() => { dismiss(); }, [narrow]);
  useEffect(() => () => cancel(), []);
  useEffect(() => {
    const blur = () => { if (!latest.current.pinned) dismiss(); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, []);
  useEffect(() => {
    if (!native) return;
    let current = true, revision = 0, lastRequest = "";
    const update = () => {
      const row = panel.current?.querySelector('.sidebar-chrome')?.getBoundingClientRect();
      const show = visible && motion.settled && !!row;
      const x = row && show ? Math.max((panel.current?.getBoundingClientRect().left ?? 0) + 12, row.left) : 24;
      const y = row && show ? row.top + row.height / 2 : 35;
      const key = `${show}:${x}:${y}`;
      if (key === lastRequest) return;
      lastRequest = key;
      const request = ++revision;
      chromeQueue.current = chromeQueue.current.catch(() => {}).then(() => {
        if (!current || request !== revision) return;
        return call<void>("set_sidebar_window_controls", { visible: show, x, y });
      }).then(() => { if (current && request === revision) setNativeError(""); }).catch(() => {
        if (current && request === revision) {
          lastRequest = "";
          setNativeError("Window controls could not be updated. Reopen the sidebar to retry.");
        }
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", update);
    window.addEventListener("focus", update);
    return () => { current = false; observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("focus", update); };
  }, [visible, native, motion.settled, narrow]);
  useEffect(() => {
    if (!native || !visible || pinned) return;
    let current = true;
    let pollTimer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const inside = await call<boolean>("sidebar_pointer_inside", { width: (panel.current ? panel.current.offsetLeft + panel.current.offsetWidth : 235) + 6 });
        if (!current) return;
        if (inside) { pointerInside.current = true; cancel(); }
        else if (pointerInside.current || !timer.current) { pointerInside.current = false; scheduleDismiss(); }
      } catch { /* DOM leave/blur handling remains available if native tracking fails. */ }
      if (current) pollTimer = setTimeout(poll, 120);
    };
    void poll();
    return () => { current = false; clearTimeout(pollTimer); };
  }, [native, visible, pinned]);
  return {
    panel, pinned, docked, visible, nativeError, ...motion,
    reveal, dismiss,
    close: () => { appearance.setSidebarCollapsed(true); dismiss(); },
    toggle: () => visible ? (appearance.setSidebarCollapsed(true), dismiss()) : reveal(true),
    pin: () => { appearance.setSidebarCollapsed(false); setPeek(true); },
    pointerInteraction: () => { keyboard.current = false; },
    enter: () => { pointerInside.current = true; cancel(); },
    leave: () => { pointerInside.current = false; scheduleDismiss(); },
    focus: () => { keyboard.current = !!panel.current?.querySelector(":focus-visible"); cancel(); },
    blur: () => { if (!panel.current?.contains(document.activeElement)) { keyboard.current = false; scheduleDismiss(); } },
  };
}
