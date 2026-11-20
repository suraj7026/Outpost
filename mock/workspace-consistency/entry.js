import { owners, states } from './fixture.js';
import '../../desktop/src/main.tsx';
import './preview.css';
import './controls.css';
import './theme.css';
import './popup-consistency.js';

document.body.classList.add('consistency-preview');
const shield = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c3 2 6 3 8 3v6c0 5-5 8-8 10-3-2-8-5-8-10V6c2 0 5-1 8-3Z"/><path d="m8 12 3 3 5-6"/></svg>';
const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10M7 17 17 7"/></svg>';
let started = false;
function attention(owner, taskId) {
  const actions = (states[owner]?.records ?? []).filter(row => row.kind === 'action' && row.data.taskId === taskId && ['pending', 'authorized'].includes(row.data.state));
  const waiting = actions.filter(row => row.data.state === 'pending');
  return { count: actions.length, label: waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'approval' : 'approvals'} needed` : `${actions.length} ready to run`, actions, first: waiting[0] ?? actions[0] };
}
function text(element, value) { if (element.textContent !== value) element.textContent = value; }
function chatButton(owner, taskId) { return document.querySelector(`.chat-server-group[data-server-id="${owner}"] button[data-task-id="${taskId}"]`); }
function decorate() {
  const main = document.querySelector('.main-shell');
  if (!main) return;
  const pageHeading = main.querySelector(':scope > .page > .page-heading');
  if (pageHeading && !pageHeading.querySelector('.preview-page-icon')) {
    const existing = pageHeading.querySelector('.settings-header-icon');
    if (existing) existing.classList.add('preview-page-icon');
    else {
      const title = pageHeading.querySelector('h1')?.textContent.trim();
      const navigation = [...document.querySelectorAll('nav[aria-label="Main navigation"] > button')].find(button => button.textContent.trim() === title);
      const glyph = navigation?.querySelector('svg');
      if (glyph) {
        const icon = document.createElement('span');
        icon.className = 'preview-page-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.append(glyph.cloneNode(true));
        pageHeading.prepend(icon);
      }
    }
  }
  for (const button of document.querySelectorAll('nav[aria-label="Main navigation"] > button')) {
    if (button.textContent.trim().startsWith('Approvals')) button.hidden = true;
  }
  const footer = document.querySelector('.sidebar-bottom');
  if (footer && !footer.querySelector('.preview-build-note')) {
    const note = document.createElement('div'); note.className = 'preview-build-note';
    note.innerHTML = '<strong>Design preview</strong>Actual Outpost UI · Sample data'; footer.prepend(note);
  }
  for (const button of document.querySelectorAll('.chat-server-threads > button[data-task-id]')) {
    const owner = button.closest('[data-server-id]').dataset.serverId;
    const status = attention(owner, button.dataset.taskId);
    let badge = button.querySelector('.preview-attention-count');
    if (!status.count) { badge?.remove(); continue; }
    if (!badge) {
      badge = document.createElement('span'); badge.className = 'preview-attention-count';
      badge.innerHTML = shield + '<b></b>'; button.append(badge);
    }
    text(badge.querySelector('b'), String(status.count));
    if (badge.title !== status.label) badge.title = status.label;
    const task = states[owner].records.find(row => row.kind === 'task' && row.id === button.dataset.taskId);
    const label = `${task.data.goal} · ${status.label}`;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
  }
  const history = main.querySelector('.all-chats-page');
  if (history) {
    const toolbar = history.querySelector('.workspace-toolbar');
    let filter = toolbar.querySelector('.preview-attention-filter');
    if (!filter) {
      filter = document.createElement('button'); filter.type = 'button'; filter.className = 'preview-attention-filter';
      filter.innerHTML = shield + '<span>Needs attention</span><b></b>';
      filter.setAttribute('aria-pressed', 'false');
      filter.onclick = () => { const pressed = filter.getAttribute('aria-pressed') !== 'true'; filter.setAttribute('aria-pressed', String(pressed)); decorate(); };
      toolbar.append(filter);
    }
    let count = 0, visible = 0;
    const rows = [...history.querySelectorAll('.workspace-chat')];
    for (const row of rows) {
      const status = attention(row.dataset.serverId, row.dataset.taskId);
      if (status.count) count++;
      const marked = status.count > 0;
      if (row.dataset.attention !== String(marked)) row.dataset.attention = String(marked);
      const hide = filter.getAttribute('aria-pressed') === 'true' && !marked;
      if (row.hidden !== hide) row.hidden = hide;
      if (!hide) visible++;
      const badge = row.querySelector('.ui-badge');
      if (marked && badge) {
        badge.classList.add('preview-status');
        text(badge, status.label);
      }
    }
    text(filter.querySelector('b'), String(count));
    const summary = history.querySelector('.section-heading > span');
    if (summary) text(summary, `${visible} of ${rows.length} chats`);
  }
  const selectedButton = document.querySelector('.chat-server-threads > button[aria-current="page"]');
  const heading = main.querySelector('.task-workspace-heading');
  if (heading && selectedButton) {
    const status = attention(main.dataset.ownerId, selectedButton.dataset.taskId);
    let badge = heading.querySelector('.preview-chat-attention');
    if (!status.count) badge?.remove();
    else {
      if (!badge) {
        badge = document.createElement('button'); badge.type = 'button'; badge.className = 'preview-chat-attention';
        badge.innerHTML = shield + '<span></span>'; heading.insertBefore(badge, heading.querySelector('.task-workspace-toggle'));
      }
      text(badge.querySelector('span'), status.label);
      badge.onclick = () => {
        const review = main.querySelector(`.execution-entry[data-record-id="${status.first.id}"] .execution-review`);
        review?.click();
      };
    }
  }
  const library = [...main.querySelectorAll('.workspace-view')].find(page => page.querySelector('h1')?.textContent === 'Library');
  if (library) {
    for (const section of library.querySelectorAll('.workspace-server')) {
      const owner = section.dataset.serverId;
      for (const card of section.querySelectorAll('.artifact')) {
        const label = card.querySelector('.artifact-row > span');
        const record = states[owner]?.records.find(row => row.kind === 'artifact' && row.data.name === label?.textContent);
        if (!record || card.querySelector('.preview-file-meta')) continue;
        const task = states[owner].records.find(row => row.kind === 'task' && row.id === record.data.taskId);
        const meta = document.createElement('p'); meta.className = 'preview-file-meta';
        meta.textContent = `Markdown · ${(record.data.size / 1024).toFixed(1)} KB · ${task.data.goal}`;
        card.append(meta);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'preview-file-open';
        open.innerHTML = 'Open chat' + arrow; open.onclick = () => chatButton(owner, record.data.taskId)?.click();
        card.querySelector('.artifact-row').insertBefore(open, card.querySelector('.artifact-row > .icon-button'));
      }
    }
  }
  if (!started && document.querySelector('.connection-nav[aria-label="Settings"]')) {
    started = true;
    document.querySelector('.connection-nav[aria-label="Settings"]').click();
  }
}
let pending = false;
new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; decorate(); });
}).observe(document.getElementById('root'), { childList: true, subtree: true });
let noticeTimer;
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || !['Open terminal', 'New task'].some(name => button.textContent.trim().startsWith(name))) return;
  event.preventDefault(); event.stopPropagation();
  let notice = document.querySelector('.preview-local-notice');
  if (!notice) { notice = document.createElement('div'); notice.className = 'preview-local-notice'; notice.setAttribute('role', 'status'); document.body.append(notice); }
  notice.textContent = 'Design preview only — no terminal or agent task is started.';
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.remove(), 3000);
}, true);
decorate();
