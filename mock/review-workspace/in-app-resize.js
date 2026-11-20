export function installWorkspaceResize(columns, conversation, region) {
  // Keep the composer above its 560px single-row breakpoint, plus column padding.
  const defaultWidth = 600;
  const minChat = 600;
  const minWorkspace = 420;
  const maxChat = 760;
  let preferredWidth = defaultWidth;
  let actualWidth = defaultWidth;
  let drag = null;

  const divider = document.createElement('div');
  divider.className = 'in-app-resize-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Resize chat and workspace');
  conversation.id = 'in-app-chat-column';
  divider.setAttribute('aria-controls', `${conversation.id} ${region.id}`);
  divider.title = 'Drag to resize · Arrow keys to adjust · Double-click to reset';
  columns.append(divider);

  function limits() {
    const total = columns.getBoundingClientRect().width;
    return { total, min: minChat, max: Math.max(minChat, Math.min(maxChat, total - minWorkspace)) };
  }
  function layout() {
    const { total, min, max } = limits();
    const singlePane = innerWidth <= 900 || total < minChat + minWorkspace;
    columns.toggleAttribute('data-review-single', singlePane);
    actualWidth = Math.round(Math.min(max, Math.max(min, preferredWidth)));
    columns.style.setProperty('--review-chat-width', `${actualWidth}px`);
    divider.setAttribute('aria-valuemin', String(Math.round(min / total * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(max / total * 100)));
    divider.setAttribute('aria-valuenow', String(Math.round(actualWidth / total * 100)));
    divider.setAttribute('aria-valuetext', `Chat ${actualWidth} pixels, workspace ${Math.round(total - actualWidth)} pixels`);
    if (singlePane) finishDrag();
  }
  function setWidth(width) {
    const { min, max } = limits();
    preferredWidth = Math.min(max, Math.max(min, width));
    layout();
  }
  function finishDrag() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    document.documentElement.classList.remove('in-app-resizing');
    divider.removeAttribute('data-dragging');
    if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
  }
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, startX: event.clientX, width: actualWidth };
    divider.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('in-app-resizing');
    divider.setAttribute('data-dragging', '');
  });
  divider.addEventListener('pointermove', event => {
    if (drag?.pointerId === event.pointerId) setWidth(drag.width + event.clientX - drag.startX);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    divider.addEventListener(type, finishDrag);
  }
  divider.addEventListener('dblclick', () => setWidth(defaultWidth));
  divider.addEventListener('keydown', event => {
    const step = event.shiftKey ? 48 : 16;
    const { min, max } = limits();
    if (event.key === 'ArrowLeft') setWidth(actualWidth - step);
    else if (event.key === 'ArrowRight') setWidth(actualWidth + step);
    else if (event.key === 'Home') setWidth(min);
    else if (event.key === 'End') setWidth(max);
    else if (event.key === 'Escape' && drag) {
      setWidth(drag.width);
      finishDrag();
    } else return;
    event.preventDefault();
  });
  window.addEventListener('blur', finishDrag);
  const observer = new ResizeObserver(layout);
  observer.observe(columns);
  layout();
  return {
    stop: finishDrag,
    dispose() {
      finishDrag();
      observer.disconnect();
      window.removeEventListener('blur', finishDrag);
    },
  };
}
