import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

const RESUME_DISTANCE = 4;
const PAUSE_DISTANCE = 32;
const POSITION_EPSILON = 0.5;

type Anchor = {
  positions: { element: Element; offset: number }[];
  scrollTop: number;
};
type Disclosure = { open: boolean; anchor: Anchor };
type ScrollController = {
  update: (version: string) => void;
  jump: () => void;
};

export type ConversationScroll = {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  following: boolean;
  /** Number of committed contentVersion changes while paused, not message count. */
  unseen: number;
  jumpToLatest: () => void;
};

function viewportEdge(viewport: HTMLDivElement): number {
  return viewport.getBoundingClientRect().top + viewport.clientTop;
}

function captureAnchor(viewport: HTMLDivElement, content: HTMLDivElement, preferred?: Element): Anchor {
  const bounds = viewport.getBoundingClientRect();
  const edge = bounds.top + viewport.clientTop;
  const left = bounds.left + viewport.clientLeft;
  const view = content.ownerDocument.defaultView;
  let element = preferred ?? content;
  if (!preferred) {
    // Descend into the first visible branch, rather than anchoring a whole message
    // whose images or evidence above the visible paragraph can still grow.
    const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        const style = view?.getComputedStyle(node);
        // Pinned headers (including their SVG/text descendants) do not move with
        // reflow. Reject the entire branch rather than merely skipping its root.
        if (!style || style.position === "sticky" || style.position === "fixed" || style.display === "none") {
          return NodeFilter.FILTER_REJECT;
        }
        // A boxless wrapper can still contain normal-flow reading anchors. Other
        // empty/offscreen boxes are atomic rejects; do not descend into them.
        if (style.display === "contents") return NodeFilter.FILTER_SKIP;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return NodeFilter.FILTER_REJECT;
        return rect.bottom > edge + 1 && rect.top < edge + viewport.clientHeight
          && rect.right > left && rect.left < left + viewport.clientWidth
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode();
    while (node instanceof Element && element.contains(node)) {
      element = node;
      node = walker.nextNode();
    }
  }
  const positions: Anchor["positions"] = [];
  while (content.contains(element)) {
    positions.push({ element, offset: element.getBoundingClientRect().top - edge });
    if (element === content || !element.parentElement) break;
    element = element.parentElement;
  }
  return { positions, scrollTop: viewport.scrollTop };
}

/**
 * Native, instant tail following for a chronological, non-virtualized stream.
 * Attach both refs on mount, keep their nodes stable, and disable overflow-anchor
 * on the viewport in CSS. Stable React keys preserve reading anchors across updates.
 */
export function useConversationScroll(taskKey: string, contentVersion: string): ConversationScroll {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ScrollController | null>(null);
  const [status, setStatus] = useState({ following: true, unseen: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || !viewport.contains(content)) return;
    const view = viewport.ownerDocument.defaultView;
    if (!view) return;

    let following = true;
    let unseen = 0;
    let version: string | undefined;
    let anchor: Anchor | null = null;
    let pendingDisclosure: Anchor | null = null;
    let disclosures = new Map<HTMLDetailsElement, Disclosure>();
    let observedTop = viewport.scrollTop;
    let writtenTop: number | null = null;
    let height = viewport.scrollHeight;
    let viewportHeight = viewport.clientHeight;
    let touch: { id: number; y: number } | null = null;
    let frame: number | null = null;
    let disposed = false;

    const publish = () => setStatus(previous =>
      previous.following === following && previous.unseen === unseen
        ? previous : { following, unseen });
    const maximum = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const distance = () => maximum() - Math.max(0, viewport.scrollTop);
    const samePosition = (a: number, b: number) => Math.abs(a - b) < POSITION_EPSILON;
    const pause = (position?: Anchor) => {
      if (position) anchor = position;
      else if (following || !anchor) anchor = captureAnchor(viewport, content);
      following = false;
      publish();
    };
    const resume = () => {
      following = true;
      unseen = 0;
      anchor = null;
      publish();
    };
    const writeTop = (top: number) => {
      const target = Math.max(0, Math.min(maximum(), top));
      if (!samePosition(viewport.scrollTop, target)) {
        // Explicit instant behavior also overrides an inherited scroll-behavior:
        // smooth. A position token, not a timer, identifies our queued scroll event.
        viewport.scrollTo({ top: target, left: viewport.scrollLeft, behavior: "instant" });
        writtenTop = viewport.scrollTop;
      }
      observedTop = viewport.scrollTop;
    };
    const preserve = () => {
      if (!anchor) return;
      const position = anchor.positions.find(({ element }) =>
        content.contains(element) && element.getBoundingClientRect().height > 0);
      writeTop(position
        ? viewport.scrollTop + position.element.getBoundingClientRect().top - viewportEdge(viewport) - position.offset
        : anchor.scrollTop);
    };
    const snapshotDisclosures = () => {
      const next = new Map<HTMLDetailsElement, Disclosure>();
      for (const details of content.querySelectorAll("details")) {
        const summary = details.querySelector(":scope > summary");
        if (summary) next.set(details, { open: details.open, anchor: captureAnchor(viewport, content, summary) });
      }
      disclosures = next;
    };
    const changedDisclosure = (): Anchor | null => {
      for (const [details, previous] of disclosures) {
        if (content.contains(details) && details.open !== previous.open) return previous.anchor;
      }
      return null;
    };
    const layoutChanged = () => height !== viewport.scrollHeight || viewportHeight !== viewport.clientHeight;

    const readManualScroll = (duringLayout = false) => {
      const top = viewport.scrollTop;
      if (writtenTop !== null && samePosition(top, writtenTop)) {
        writtenTop = null;
        observedTop = top;
        return;
      }
      if (samePosition(top, observedTop)) return;
      writtenTop = null;
      // Content shrinking (including a details close) can clamp scrollTop without
      // user input. That must not re-arm a paused reader at the new bottom.
      if (pendingDisclosure || (layoutChanged() && observedTop > maximum() && samePosition(top, maximum()))) return;
      const delta = top - observedTop;
      const previousAnchor = anchor;
      observedTop = top;
      if (distance() < RESUME_DISTANCE && delta > 0) resume();
      else if (distance() > PAUSE_DISTANCE) pause();
      if (!following) {
        // A commit can reflow content before the native scroll event is delivered.
        // Keep its pre-layout anchor, incorporating only the user's scroll delta.
        anchor = duringLayout && previousAnchor
          ? {
            positions: previousAnchor.positions.map(position => ({ ...position, offset: position.offset - delta })),
            scrollTop: previousAnchor.scrollTop + delta,
          }
          : captureAnchor(viewport, content);
      }
      if (!duringLayout) snapshotDisclosures();
    };

    const reconcile = () => {
      if (disposed) return;
      const disclosure = pendingDisclosure ?? changedDisclosure();
      if (disclosure) {
        pendingDisclosure = disclosure;
        pause(disclosure);
      }
      readManualScroll(true);
      if (following) writeTop(maximum());
      else preserve();
      pendingDisclosure = null;
      height = viewport.scrollHeight;
      viewportHeight = viewport.clientHeight;
      snapshotDisclosures();
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        reconcile();
      });
    };
    const intent = (towardHistory: boolean) => {
      // Account for native scrolling that happened before its scroll event arrived.
      readManualScroll();
      if (towardHistory) pause();
      else if (distance() < RESUME_DISTANCE) resume();
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.deltaY !== 0) intent(event.deltaY < 0);
    };
    const onTouchStart = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      touch = point ? { id: point.identifier, y: point.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined;
      if (point && touch?.id === point.identifier && point.clientY !== touch.y) {
        intent(point.clientY > touch.y);
      }
      touch = point ? { id: point.identifier, y: point.clientY } : null;
    };
    const onTouchEnd = () => { touch = null; };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (target instanceof Element && target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"]',
      )) return;
      if (["Home", "PageUp", "ArrowUp"].includes(event.key) || (event.key === " " && event.shiftKey)) intent(true);
      else if (["End", "PageDown", "ArrowDown"].includes(event.key) || event.key === " ") intent(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      // Scrollbar drags have no wheel/key precursor. The viewport itself also
      // covers overlay scrollbars; descendants remain ordinary content targets.
      if (event.target === viewport && event.button === 0) {
        readManualScroll();
        pause();
      }
    };
    const onClick = (event: MouseEvent) => {
      const summary = event.target instanceof Element ? event.target.closest("summary") : null;
      if (!summary || !content.contains(summary) || !(summary.parentElement instanceof HTMLDetailsElement)) return;
      pendingDisclosure = captureAnchor(viewport, content, summary);
      pause(pendingDisclosure);
      // Capture runs before native activation. Do not preventDefault, change open,
      // or focus anything: the browser retains disclosure and keyboard semantics.
      schedule();
    };
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement && content.contains(event.target)) reconcile();
    };
    const onScroll = () => {
      if (layoutChanged() || pendingDisclosure || changedDisclosure()) reconcile();
      else readManualScroll();
    };

    const controller: ScrollController = {
      update(nextVersion) {
        reconcile();
        if (version !== undefined && version !== nextVersion && !following) {
          unseen += 1;
          publish();
        }
        version = nextVersion;
      },
      jump() {
        pendingDisclosure = null;
        // Consume outstanding disclosure changes so their delayed toggle event
        // cannot undo an explicit jump to latest.
        snapshotDisclosures();
        resume();
        writeTop(maximum());
        height = viewport.scrollHeight;
        viewportHeight = viewport.clientHeight;
        snapshotDisclosures();
      },
    };
    controllerRef.current = controller;

    const passiveCapture = { passive: true, capture: true };
    viewport.addEventListener("wheel", onWheel, passiveCapture);
    viewport.addEventListener("touchstart", onTouchStart, passiveCapture);
    viewport.addEventListener("touchmove", onTouchMove, passiveCapture);
    viewport.addEventListener("touchend", onTouchEnd, passiveCapture);
    viewport.addEventListener("touchcancel", onTouchEnd, passiveCapture);
    viewport.addEventListener("keydown", onKeyDown, true);
    viewport.addEventListener("pointerdown", onPointerDown, true);
    viewport.addEventListener("click", onClick, true);
    viewport.addEventListener("toggle", onToggle, true);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(reconcile);
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    // Native details toggles are queued tasks. Observe open mutations as well so
    // a resize cannot pin the viewport before that toggle event is delivered.
    const mutationObserver = new MutationObserver(reconcile);
    mutationObserver.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    publish();
    writeTop(maximum());
    snapshotDisclosures();

    return () => {
      disposed = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (frame !== null) view.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener("wheel", onWheel, true);
      viewport.removeEventListener("touchstart", onTouchStart, true);
      viewport.removeEventListener("touchmove", onTouchMove, true);
      viewport.removeEventListener("touchend", onTouchEnd, true);
      viewport.removeEventListener("touchcancel", onTouchEnd, true);
      viewport.removeEventListener("keydown", onKeyDown, true);
      viewport.removeEventListener("pointerdown", onPointerDown, true);
      viewport.removeEventListener("click", onClick, true);
      viewport.removeEventListener("toggle", onToggle, true);
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [taskKey]);

  useLayoutEffect(() => {
    controllerRef.current?.update(contentVersion);
  }, [taskKey, contentVersion]);

  const jumpToLatest = useCallback(() => { controllerRef.current?.jump(); }, []);
  return { viewportRef, contentRef, ...status, jumpToLatest };
}
