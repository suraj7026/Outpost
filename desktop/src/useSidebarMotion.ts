import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMediaQuery } from "./appearance";

export function useSidebarMotion(panel: RefObject<HTMLElement | null>, visible: boolean) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [present, setPresent] = useState(visible);
  const [settled, setSettled] = useState(visible);
  const animations = useRef<Animation[]>([]);
  const previousVisible = useRef(visible);
  const start = useRef<{ transform: string; opacity: string; columns: string } | null>(null);

  useLayoutEffect(() => {
    const node = panel.current, shell = node?.parentElement;
    if (!node || !shell) return;
    let current = true;
    if (visible && !present) { setPresent(true); return; }
    if (!present) { setSettled(false); return; }
    const wasVisible = previousVisible.current;
    previousVisible.current = visible;
    const interrupted = start.current;
    start.current = null;
    if (reduced || (wasVisible === visible && !interrupted)) {
      setPresent(visible); setSettled(visible);
      return;
    }
    setSettled(false);
    const offscreen = "translateX(calc(-100% - 24px))";
    const width = parseFloat(getComputedStyle(shell).getPropertyValue("--sidebar-width"));
    const pushed = matchMedia("(min-width: 781px)").matches;
    const columns = (size: number) => `${size}px minmax(0, 1fr)`;
    const initial = interrupted ?? {
      transform: wasVisible ? "translateX(0)" : offscreen,
      opacity: wasVisible ? "1" : "0.55",
      columns: columns(wasVisible ? width : 0),
    };
    const timing = { duration: visible ? 520 : 240, easing: visible ? "linear" : "cubic-bezier(.4,0,.8,.25)", fill: "both" as const };
    const motion = node.animate(visible ? [
      { transform: initial.transform, opacity: initial.opacity, offset: 0, easing: "cubic-bezier(.18,.8,.25,1)" },
      { transform: "translateX(7px)", opacity: 1, offset: .67, easing: "ease-in-out" },
      { transform: "translateX(-2px)", opacity: 1, offset: .86, easing: "ease-out" },
      { transform: "translateX(0)", opacity: 1, offset: 1 },
    ] : [{ transform: initial.transform, opacity: initial.opacity }, { transform: offscreen, opacity: 0 }], timing);
    const layout = pushed ? shell.animate(visible ? [
      { gridTemplateColumns: initial.columns, offset: 0, easing: "cubic-bezier(.18,.8,.25,1)" },
      { gridTemplateColumns: columns(width + 7), offset: .67, easing: "ease-in-out" },
      { gridTemplateColumns: columns(width - 2), offset: .86, easing: "ease-out" },
      { gridTemplateColumns: columns(width), offset: 1 },
    ] : [{ gridTemplateColumns: initial.columns }, { gridTemplateColumns: columns(0) }], timing) : null;
    animations.current = layout ? [motion, layout] : [motion];
    void Promise.all(animations.current.map(animation => animation.finished)).then(() => {
      if (!current) return;
      setPresent(visible); setSettled(visible);
      animations.current.forEach(animation => animation.cancel()); animations.current = [];
    }).catch(() => {});
    return () => {
      current = false;
      if (animations.current.length) {
        const style = getComputedStyle(node);
        start.current = { transform: style.transform, opacity: style.opacity, columns: `${parseFloat(getComputedStyle(shell).gridTemplateColumns)}px minmax(0, 1fr)` };
        animations.current.forEach(animation => animation.cancel()); animations.current = [];
      }
    };
  }, [visible, present, reduced, panel]);
  return { present, settled };
}
