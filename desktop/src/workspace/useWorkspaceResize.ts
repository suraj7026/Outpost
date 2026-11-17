import { useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";

const DEFAULT_CHAT_WIDTH = 600;
const MIN_CHAT_WIDTH = 600;
const MIN_WORKSPACE_WIDTH = 420;
const MAX_CHAT_WIDTH = 760;

/** Container constraints never overwrite the user's preferred width. */
export function getWorkspaceResizeLayout(totalWidth: number, preferredWidth = DEFAULT_CHAT_WIDTH) {
  const total = Number.isFinite(totalWidth) ? Math.max(0, totalWidth) : 0;
  const maxChatWidth = Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, Math.floor(total - MIN_WORKSPACE_WIDTH)));
  const preferred = Number.isFinite(preferredWidth) ? preferredWidth : DEFAULT_CHAT_WIDTH;
  return {
    totalWidth: total,
    minChatWidth: MIN_CHAT_WIDTH,
    maxChatWidth,
    chatWidth: Math.min(maxChatWidth, Math.max(MIN_CHAT_WIDTH, Math.round(preferred))),
    singlePane: total < MIN_CHAT_WIDTH + MIN_WORKSPACE_WIDTH,
  };
}

type ResizeLayout = ReturnType<typeof getWorkspaceResizeLayout>;
type ResizeStatus = ResizeLayout & { dragging: boolean };
type ResizeController = {
  columns: HTMLDivElement;
  open: boolean;
  scope: string;
  handlers: HTMLAttributes<HTMLDivElement>;
  dispose: () => void;
};

export type WorkspaceResize = {
  columnsRef: RefObject<HTMLDivElement | null>;
  chatWidth: number;
  singlePane: boolean;
  dragging: boolean;
  separatorProps: HTMLAttributes<HTMLDivElement>;
};

/** Attach columnsRef to the grid and spread separatorProps on its divider. */
export function useWorkspaceResize({ open, scope }: { open: boolean; scope: string }): WorkspaceResize {
  const columnsRef = useRef<HTMLDivElement>(null);
  const preferred = useRef({ scope, width: DEFAULT_CHAT_WIDTH });
  const controller = useRef<ResizeController | null>(null);
  const [status, setStatus] = useState<ResizeStatus>(() => ({ ...getWorkspaceResizeLayout(0), dragging: false }));

  // Check the object ref after every commit so conditional mounts/replaced grids
  // are observed too, without reconnecting the observer on ordinary drag renders.
  useLayoutEffect(() => {
    const columns = columnsRef.current;
    const previous = controller.current;
    if (previous && previous.columns === columns && previous.open === open && previous.scope === scope) return;
    controller.current = null;
    previous?.dispose();
    if (preferred.current.scope !== scope) preferred.current = { scope, width: DEFAULT_CHAT_WIDTH };
    if (!columns) {
      setStatus(current => current.totalWidth === 0 && !current.dragging && current.chatWidth === MIN_CHAT_WIDTH
        ? current : { ...getWorkspaceResizeLayout(0, preferred.current.width), dragging: false });
      return;
    }

    const document = columns.ownerDocument;
    const view = document.defaultView;
    let disposed = false;
    let drag: { pointerId: number; startX: number; width: number; preferredWidth: number; target: HTMLDivElement; restoreSelection: () => void } | null = null;
    const layout = () => getWorkspaceResizeLayout(columns.getBoundingClientRect().width, preferred.current.width);
    const publish = (next = layout()) => {
      if (disposed) return;
      const dragging = drag !== null;
      setStatus(current => current.totalWidth === next.totalWidth && current.chatWidth === next.chatWidth
        && current.maxChatWidth === next.maxChatWidth && current.singlePane === next.singlePane && current.dragging === dragging
        ? current : { ...next, dragging });
    };
    const finishDrag = () => {
      const active = drag;
      if (!active) return;
      drag = null;
      active.restoreSelection();
      view?.removeEventListener("blur", finishDrag);
      try {
        if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
      } catch {
        // The pointer or element may already be gone during React teardown.
      }
      publish();
    };
    const measure = () => {
      if (disposed) return;
      const next = layout();
      if (next.singlePane) finishDrag();
      publish(next);
    };
    const canResize = () => {
      if (disposed || !open) return false;
      if (layout().singlePane) {
        finishDrag();
        return false;
      }
      return true;
    };
    const setWidth = (width: number) => {
      const next = getWorkspaceResizeLayout(columns.getBoundingClientRect().width, width);
      preferred.current.width = next.chatWidth;
      publish(next);
    };
    const finishPointer: NonNullable<HTMLAttributes<HTMLDivElement>["onPointerUp"]> = event => {
      if (drag?.pointerId === event.pointerId) finishDrag();
    };
    const handlers: HTMLAttributes<HTMLDivElement> = {
      onPointerDown: event => {
        if (event.button !== 0 || !event.isPrimary || drag || !canResize()) return;
        event.preventDefault();
        const target = event.currentTarget;
        target.focus({ preventScroll: true });
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // A pointer that is no longer active must not leave selection locked.
          return;
        }
        const rootStyle = document.documentElement.style;
        const properties = ["user-select", "-webkit-user-select"].map(name => ({
          name, value: rootStyle.getPropertyValue(name), priority: rootStyle.getPropertyPriority(name),
        }));
        for (const { name } of properties) rootStyle.setProperty(name, "none", "important");
        const preventSelection = (selection: Event) => selection.preventDefault();
        document.addEventListener("selectstart", preventSelection, true);
        drag = {
          pointerId: event.pointerId, startX: event.clientX, width: layout().chatWidth,
          preferredWidth: preferred.current.width, target,
          restoreSelection: () => {
            document.removeEventListener("selectstart", preventSelection, true);
            for (const { name, value, priority } of properties) {
              if (value) rootStyle.setProperty(name, value, priority);
              else rootStyle.removeProperty(name);
            }
          },
        };
        view?.addEventListener("blur", finishDrag);
        publish();
      },
      onPointerMove: event => {
        if (drag?.pointerId !== event.pointerId || !canResize() || !drag) return;
        event.preventDefault();
        setWidth(drag.width + event.clientX - drag.startX);
      },
      onPointerUp: finishPointer,
      onPointerCancel: finishPointer,
      onLostPointerCapture: finishPointer,
      onBlur: finishDrag,
      onDoubleClick: () => {
        if (!canResize()) return;
        finishDrag();
        setWidth(DEFAULT_CHAT_WIDTH);
      },
      onKeyDown: event => {
        if (!canResize()) return;
        const current = layout();
        const step = event.shiftKey ? 48 : 16;
        let width: number;
        if (event.key === "Escape" && drag) {
          preferred.current.width = drag.preferredWidth;
          finishDrag();
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowLeft") width = current.chatWidth - step;
        else if (event.key === "ArrowRight") width = current.chatWidth + step;
        else if (event.key === "Home") width = current.minChatWidth;
        else if (event.key === "End") width = current.maxChatWidth;
        else return;
        event.preventDefault();
        finishDrag();
        setWidth(width);
      },
    };
    const observer = new ResizeObserver(measure);
    controller.current = {
      columns, open, scope, handlers,
      dispose: () => {
        disposed = true;
        observer.disconnect();
        finishDrag();
      },
    };
    observer.observe(columns, { box: "border-box" });
    measure();
  });

  useLayoutEffect(() => () => {
    const active = controller.current;
    controller.current = null;
    active?.dispose();
  }, []);

  const total = Math.max(status.totalWidth, status.chatWidth);
  return {
    columnsRef,
    chatWidth: status.chatWidth,
    singlePane: status.singlePane,
    dragging: status.dragging,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": "Resize chat and workspace",
      "aria-orientation": "vertical",
      "aria-valuemin": Math.round(status.minChatWidth / total * 100),
      "aria-valuemax": Math.round(status.maxChatWidth / total * 100),
      "aria-valuenow": Math.round(status.chatWidth / total * 100),
      "aria-valuetext": `Chat ${status.chatWidth} pixels, workspace ${Math.max(0, Math.round(status.totalWidth - status.chatWidth))} pixels`,
      title: "Drag to resize · Arrow keys to adjust · Double-click to reset",
      style: { touchAction: "none", userSelect: "none" },
      onPointerDown: event => controller.current?.handlers.onPointerDown?.(event),
      onPointerMove: event => controller.current?.handlers.onPointerMove?.(event),
      onPointerUp: event => controller.current?.handlers.onPointerUp?.(event),
      onPointerCancel: event => controller.current?.handlers.onPointerCancel?.(event),
      onLostPointerCapture: event => controller.current?.handlers.onLostPointerCapture?.(event),
      onBlur: event => controller.current?.handlers.onBlur?.(event),
      onDoubleClick: event => controller.current?.handlers.onDoubleClick?.(event),
      onKeyDown: event => controller.current?.handlers.onKeyDown?.(event),
    },
  };
}
