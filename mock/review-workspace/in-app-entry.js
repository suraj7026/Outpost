import './in-app-fixture.js';
import '../../desktop/src/main.tsx';
import './in-app.css';
import { installWorkspaceResize } from './in-app-resize.js';

const workspaceIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M16 8v8"/></svg>';

let openedInitialChat = false;
let workspaceResize;
function mountReview() {
  if (!openedInitialChat) {
    const chat = document.querySelector('[data-task-id="bitchat-research"]');
    if (chat) { openedInitialChat = true; chat.click(); }
  }
  const columns = document.querySelector('.task-columns');
  if (!columns) {
    workspaceResize?.dispose();
    workspaceResize = undefined;
    return;
  }
  if (columns.querySelector('.in-app-review')) return;
  workspaceResize?.dispose();
  const region = document.createElement('section');
  region.className = 'in-app-review';
  region.id = 'in-app-review-workspace';
  region.setAttribute('aria-label', 'Document and browser review preview');
  const frame = document.createElement('iframe');
  frame.title = 'Document reviewer and browser';
  frame.srcdoc = __REVIEW_DOCUMENT__;
  region.append(frame);
  columns.append(region);
  columns.classList.add('review-preview-open');
  const conversation = columns.querySelector('.conversation-column');
  const resize = installWorkspaceResize(columns, conversation, region);
  workspaceResize = resize;
  const heading = document.createElement('div');
  heading.className = 'in-app-workspace-heading';
  const title = document.createElement('span');
  title.textContent = 'BitChat protocol research';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'workspace-toggle';
  toggle.innerHTML = workspaceIcon;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-controls', region.id);
  function toggleReview(force) {
    const open = typeof force === 'boolean' ? force : !columns.classList.contains('review-preview-open');
    columns.classList.toggle('review-preview-open', open);
    region.hidden = !open;
    if (!open) resize.stop();
    toggle.setAttribute('aria-label', open ? 'Close workspace' : 'Open workspace');
    toggle.title = open ? 'Close workspace' : 'Open workspace';
    toggle.setAttribute('aria-expanded', String(open));
    const composerToggle = columns.querySelector('button[aria-label="Files, changes and browser"]');
    composerToggle?.setAttribute('aria-expanded', String(open));
    composerToggle?.setAttribute('aria-controls', region.id);
    if (!open) toggle.focus({ preventScroll: true });
  }
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    const tabs = doc.querySelector('.tabs');
    const files = doc.createElement('button');
    files.className = 'workspace-files-toggle';
    files.type = 'button';
    files.innerHTML = '<svg aria-hidden="true"><use href="#glyph-panel"/></svg>Files';
    files.title = 'Hide file list';
    files.setAttribute('aria-label', 'Toggle file list');
    files.setAttribute('aria-expanded', 'true');
    files.setAttribute('aria-controls', 'workspace-file-list');
    doc.querySelector('.explorer').id = 'workspace-file-list';
    files.onclick = () => {
      const collapsed = doc.documentElement.toggleAttribute('data-files-collapsed');
      files.setAttribute('aria-expanded', String(!collapsed));
      files.title = collapsed ? 'Show file list' : 'Hide file list';
    };
    tabs.append(files);
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        toggleReview(false);
      }
    });
  });
  toggle.onclick = () => toggleReview();
  heading.append(title, toggle);
  columns.before(heading);
  toggleReview(true);
  const response = columns.querySelector('.run-content');
  if (response) {
    const card = document.createElement('button');
    card.className = 'in-app-file-card';
    card.innerHTML = '<span><strong>README.md</strong><small>bitchat-protocol-research/</small></span><span>Review file<svg class="review-file-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 7h10v10M7 17 17 7"/></svg></span>';
    card.onclick = () => { toggleReview(true); frame.contentWindow?.document.querySelector('#doc-tab')?.click(); };
    response.append(card);
  }
  columns.addEventListener('click', event => {
    if (event.target.closest('button[aria-label="Files, changes and browser"]')) {
      event.preventDefault();
      event.stopPropagation();
      toggleReview();
    }
  }, true);
  const label = document.createElement('div');
  label.className = 'in-app-preview-label';
  label.textContent = 'Design preview · Actual Outpost UI · Sample data';
  document.querySelector('.sidebar-bottom')?.prepend(label);
  requestAnimationFrame(() => {
    const transcript = columns.querySelector('.conversation');
    if (transcript) transcript.scrollTop = 0;
  });
}
new MutationObserver(mountReview).observe(document.getElementById('root'), { childList: true, subtree: true });
mountReview();
