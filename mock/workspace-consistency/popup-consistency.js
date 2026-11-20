const closeGlyph = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

export function normalizePopups() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.classList.add('preview-standard-dialog');
    const form = dialog.querySelector(':scope > form');
    if (form?.querySelector(':scope > h2')) {
      dialog.classList.add('preview-form-dialog');
      let close = form.querySelector(':scope > .preview-dialog-close');
      if (!close) {
        close = document.createElement('button');
        close.type = 'button'; close.className = 'preview-dialog-close';
        close.setAttribute('aria-label', 'Close dialog'); close.title = 'Close dialog';
        close.innerHTML = closeGlyph;
        close.onclick = () => {
          const cancel = [...form.querySelectorAll('.workspace-dialog-actions button')].find(button => button.textContent.trim() === 'Cancel');
          if (cancel && !cancel.disabled) cancel.click();
        };
        form.append(close);
      }
      const cancel = [...form.querySelectorAll('.workspace-dialog-actions button')].find(button => button.textContent.trim() === 'Cancel');
      close.disabled = !cancel || cancel.disabled;
    }
    const modelDone = dialog.querySelector('.agent-dialog-heading > button');
    if (modelDone && !modelDone.querySelector('svg')) {
      modelDone.classList.add('preview-model-close');
      modelDone.setAttribute('aria-label', 'Close model picker');
      modelDone.title = 'Close model picker';
      modelDone.insertAdjacentHTML('beforeend', closeGlyph);
    }
    if (dialog.classList.contains('action-review-dialog')) {
      const footer = dialog.querySelector('.modal-actions');
      if (!footer) continue;
      const candidates = [...dialog.querySelectorAll('.action-body .button-row > button, .action-body > button')];
      const actions = candidates.filter(button => ['Approve', 'Deny', 'Run approved action', 'Dispatch approved action', 'Dispatch'].includes(button.textContent.trim()));
      const rank = button => button.textContent.trim() === 'Deny' ? 0 : 1;
      actions.sort((a, b) => rank(a) - rank(b));
      for (const proxy of footer.querySelectorAll('.preview-action-proxy')) {
        if (!actions.includes(proxy.sourceAction)) proxy.remove();
      }
      for (const action of actions) {
        action.classList.add('preview-original-action');
        let proxy = [...footer.querySelectorAll('.preview-action-proxy')].find(button => button.sourceAction === action);
        if (!proxy) {
          proxy = document.createElement('button'); proxy.type = 'button';
          proxy.className = 'preview-action-proxy ' + (action.textContent.trim() === 'Deny' ? 'preview-button-danger' : 'primary');
          proxy.sourceAction = action;
          proxy.onclick = () => { if (!action.disabled && action.isConnected) action.click(); };
          footer.append(proxy);
        }
        if (proxy.textContent !== action.textContent) proxy.textContent = action.textContent;
        if (proxy.disabled !== action.disabled) proxy.disabled = action.disabled;
      }
      for (const row of dialog.querySelectorAll('.action-body .button-row')) {
        row.classList.toggle('preview-original-action-row', [...row.children].every(child => child.classList.contains('preview-original-action')));
      }
    }
  }
}

let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; normalizePopups(); });
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
normalizePopups();
