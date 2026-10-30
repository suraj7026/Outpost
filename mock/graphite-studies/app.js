const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  tasks: '<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M9 9h6M9 13h6M9 17h3"/>',
  inbox: '<path d="m4 5-2 11v4h20v-4L20 5Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  file: '<path d="M14 2H5v20h14V7Zm0 0v6h5M8 13h8M8 17h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  play: '<path d="m9 5 10 7-10 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7c0 7-12 3-12 10"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  undo: '<path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12"/>',
  attach: '<path d="m8 14 7-7a3 3 0 0 1 4 4L9 21a5 5 0 0 1-7-7L13 3"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.tasks}</svg>`;
const mark = (cls = '') => `<svg class="outpost-mark ${cls}" width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 25V7h22v18M11 25V13h10v12" stroke="currentColor" stroke-width="2"/><path class="mark-door" d="M16 18v7" stroke="currentColor" stroke-width="2"/></svg>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fixtures = [
  { id:'backup', title:'Make the nightly backup reliable', short:'Nightly backup', group:'Infrastructure', prompt:'The nightly backup has missed two runs. Find out why, and prepare a safe fix. Ask me before changing anything.', headline:'The backup is healthy.\nThe schedule isn’t.', answer:'The worker was still finishing its snapshot when the backup started. I found the overlap, verified the last archive, and prepared one small schedule change.', finding:'Move the backup from 02:00 to 02:30 UTC. The snapshot finishes at 02:18, leaving a 12-minute buffer.', approval:true, host:'worker', file:'backup.timer', artifact:'backup-review.md', time:'09:41', duration:'48 s', result:'Archive verified', detail:'Checksum matches the source', scope:'One timer on worker', messages:[] },
  { id:'disk', title:'Review storage on the worker', short:'Worker storage report', group:'Infrastructure', prompt:'Check the worker’s storage and tell me what can be safely cleaned up. Do not remove anything.', headline:'Room to breathe.\nNothing to remove yet.', answer:'The worker has 84 GB available. The largest directory is the browser cache, but it is still in active use. I would leave it in place for now.', finding:'No cleanup is needed. Revisit storage when free space falls below 40 GB.', approval:false, host:'worker', file:'storage-report.json', artifact:'storage-review.md', time:'09:18', duration:'22 s', result:'84 GB available', detail:'116 GB used of 200 GB', scope:'Read-only inspection', messages:[] },
  { id:'research', title:'Compare browser automation options', short:'Browser research', group:'Research', prompt:'Compare the browser tools in our workspace. Give me a short recommendation with the source evidence.', headline:'Two tools.\nDifferent kinds of work.', answer:'Use Playwright for repeatable flows with known selectors. Use Browser-Use when a task needs to interpret a page and adapt its next action.', finding:'Keep both tools available. Start with Playwright for the nightly checks; reserve Browser-Use for open-ended research.', approval:false, host:'workspace', file:'browser-comparison.md', artifact:'research-notes.md', time:'Yesterday', duration:'1 m 12 s', result:'Sources reviewed', detail:'Two tool references compared', scope:'Read-only research', messages:[] },
];
const params = new URLSearchParams(location.search);
let design = ['studio','precision','quiet'].includes(params.get('design')) ? params.get('design') : 'studio';
let taskId = 'backup', tab = 'overview', compare = params.has('compare'), evidenceOpen = false, menuOpen = false;
let light = params.get('theme') === 'light';
let motion = !matchMedia('(prefers-reduced-motion: reduce)').matches && params.get('motion') !== 'off';
let runTimer, toastTimer, runStep = -1;
const approved = new Set();
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const task = () => fixtures.find(t => t.id === taskId);
const pending = t => t.approval && !approved.has(t.id);
const status = t => pending(t) ? 'Needs your review' : approved.has(t.id) ? 'Approved in mock' : 'Completed';
const descriptions = {studio:'Graphite Studio / A comfortable split workbench.',precision:'Ink Precision / Every action, in context.',quiet:'Quiet Workspace / More room for the work.'};
if (params.has('embed')) document.body.classList.add('embedded');
const iconButton = (action, name, label) => `<button class="icon-button" data-action="${action}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
function badge(t = task()) { return `<span class="status ${pending(t) ? 'waiting' : 'complete'}"><span class="status-dot"></span>${status(t)}</span>`; }
function taskRows() {
  return fixtures.map(t => `<button class="task-row ${t.id === taskId ? 'selected' : ''}" data-task="${t.id}" ${t.id === taskId ? 'aria-current="true"' : ''}><span class="task-row-top"><span class="task-indicator ${pending(t)?'waiting':'complete'}">${icon(pending(t)?'clock':'check')}</span><span>${esc(t.short)}</span></span><span class="task-row-meta">${esc(t.group)}<span>${esc(t.time)}</span></span></button>`).join('');
}
function nav() {
 return `<div class="brand">${mark()}<span>Outpost</span></div><button class="workspace-switch" data-action="workspace"><span class="workspace-initial">S</span><span>Personal workspace<small>Local & private</small></span>${icon('down')}</button><button class="new-task" data-action="new">${icon('plus')}New task<span class="shortcut">⌘ N</span></button><nav class="side-nav" aria-label="Workspace"><button data-action="tasks" class="current">${icon('tasks')}Tasks</button><button data-action="approvals">${icon('inbox')}Approvals<span class="count">${fixtures.filter(pending).length}</span></button><button data-action="machines">${icon('server')}Machines</button><button data-action="library">${icon('file')}Library</button></nav><div class="sidebar-section"><span>Recent tasks</span>${iconButton('search','search','Find a task')}</div><div class="task-list">${taskRows()}</div><div class="sidebar-bottom"><div class="connection">${icon('shield')}Private workspace</div><button class="profile" data-action="workspace"><span class="avatar">S</span><span>Suraj<small>Personal account</small></span>${icon('down')}</button></div>`;
}
function topnav() {
 return `<div class="brand">${mark()}<span>Outpost</span></div><nav class="horizontal-nav" aria-label="Workspace"><button class="current" data-action="tasks">Workspace</button><button data-action="approvals">Approvals ${fixtures.filter(pending).length ? '<span class="count">1</span>' : ''}</button><button data-action="library">Library</button></nav><div class="topnav-end">${iconButton('search','search','Find a task')}<button class="avatar" data-action="workspace" aria-label="Personal workspace">S</button></div>`;
}
function titlebar() {
 return `<header class="task-header"><div class="title-left">${iconButton('menu','menu','Open task navigation')}<span class="breadcrumb">${esc(task().group)}</span>${icon('chevron')}<h1>${esc(task().short)}</h1></div><div class="title-actions">${badge()}${pending(task())?'<button class="text-button review-shortcut" data-action="review">Review</button>':''}${iconButton('replay','play','Replay inspection animation')}${iconButton('inspector','panel','Toggle evidence')}</div></header>`;
}
function routeGraphic() {
 const labels = task().approval ? ['Inspect','Find cause','Prepare fix','Your review'] : ['Inspect','Gather evidence','Write report','Complete'];
 return `<div class="handoff ${runStep >= 0 ? 'running' : ''}" aria-label="${runStep >= 0 ? 'Sample inspection playing' : 'Three inspection steps complete; decision '+(pending(task())?'pending':'complete')}">${labels.map((label,i)=>`<div class="handoff-step ${i<3 || !pending(task())?'done':'pending'} ${runStep===i?'now':''}"><span class="handoff-node">${i<3 || !pending(task()) ? icon('check') : icon('pause')}</span><span>${label}</span>${i<3?'<span class="handoff-line"></span>':''}</div>`).join('')}</div>`;
}
function findings() {
 const t = task();
 return `<div class="findings"><div>${icon('shield')}<span>${esc(t.result)}<small>${esc(t.detail)}</small></span>${icon('check','positive')}</div><div>${icon('server')}<span>${esc(t.host)}<small>${esc(t.scope)}</small></span><span class="small">${esc(t.duration)}</span></div></div>`;
}
function decision() {
 const t = task();
 if (!t.approval) return `<div class="decision done-decision">${icon('check')}<div><strong>Inspection complete</strong><p>No changes were made to your workspace.</p></div><button class="subtle-button" data-action="artifact">Read report ${icon('chevron')}</button></div>`;
 if (approved.has(t.id)) return `<div class="decision done-decision">${icon('check','check-draw')}<div><strong>Approved in this mock</strong><p>No command was sent. Your real server is unchanged.</p></div><button class="subtle-button" data-action="undo">Undo</button></div>`;
 return `<div class="decision"><div class="decision-heading"><span class="decision-symbol">${icon('shield')}</span><span>One change. Your call.</span><span class="small">Ask permission</span></div><h3>Update the backup schedule</h3><p>02:00 → 02:30 UTC <span class="separator">/</span> worker</p><div class="decision-bottom"><span class="small">Nothing changes until you approve.</span><button class="primary" data-action="review">Review change ${icon('chevron')}</button></div></div>`;
}
function conversation() {
 const t = task();
 return `<div class="conversation"><div class="user-message"><span class="avatar">S</span><div><div class="message-byline"><strong>You</strong><span>${esc(t.time)}</span></div><p>${esc(t.prompt)}</p></div></div><article class="agent-message"><div class="message-byline">${mark()}<strong>Outpost</strong><span>Finished inspecting</span><button class="text-button" data-action="replay">${icon('play')}Replay</button></div>${design === 'quiet' ? routeGraphic() : ''}<h2>${esc(t.headline).replace('\n','<br>')}</h2><p class="answer">${esc(t.answer)}</p>${findings()}<p class="recommendation">${esc(t.finding)}</p>${design === 'quiet' ? `<button class="evidence-fold" data-action="fold" aria-expanded="${evidenceOpen}">${icon('branch')}Evidence & proposed change<span>${icon(evidenceOpen?'down':'chevron')}</span></button>${evidenceOpen?`<div class="inline-evidence">${diff()}</div>`:''}` : ''}${decision()}</article><div class="followups">${t.messages.map(message => `<div class="followup"><span class="avatar">S</span><p>${esc(message)}</p></div><p class="sample-response">This is a local preview. In the live app, Outpost would continue from your message.</p>`).join('')}</div></div>`;
}
function composer() {
 return `<form class="composer"><label for="message" class="sr-only">Follow-up message</label><textarea id="message" rows="2" placeholder="Ask a follow-up, or take it somewhere new…"></textarea><div class="composer-tools"><button type="button" class="text-button" data-action="attach">${icon('attach')}<span>Attach</span></button><span class="composer-model">Ollama <span class="separator">/</span> Ask permission</span><button type="submit" class="send" aria-label="Send sample message">${icon('arrow')}</button></div></form>`;
}
function diff() {
 if (task().id !== 'backup') return `<div class="report-preview"><span class="file-label">${icon('file')}${esc(task().file)}</span><p>${esc(task().finding)}</p><p class="small">Illustrative report · No external sources fetched</p></div>`;
 return `<div class="diff"><div class="file-label">${icon('file')}backup.timer<span class="small">1 change</span></div><pre aria-label="Proposed timer change"><code><span class="code-neutral">[Timer]</span><span class="code-delete">− OnCalendar=*-*-* 02:00:00</span><span class="code-add">+ OnCalendar=*-*-* 02:30:00</span><span class="code-neutral">  Persistent=true</span></code></pre><div class="diff-note">${icon('shield')}Scope limited to this timer.</div></div>`;
}
function events() {
 return `<div class="event-ledger">${[
 ['09:41:02','Connected to worker','Read-only inspection','server'],
 ['09:41:08','Read the timer configuration','systemctl cat backup.timer','file'],
 ['09:41:24','Verified the latest archive','Checksum matches','shield'],
 ['09:41:50','Prepared a schedule change',pending(task())?'Waiting for your review':'Approved in this mock','branch'],
 ].map(([time,title,detail,symbol],i)=>`<div class="event-row ${runStep===i?'now':''}"><time>${time}</time><span class="event-node">${icon(symbol)}</span><div><strong>${title}</strong><small>${detail}</small></div>${icon(i<3?'check':'clock',i<3?'positive':'warning')}</div>`).join('')}</div>`;
}
function files() {
 return `<div class="files">${[task().artifact,task().file].map((file,i)=>`<button data-action="artifact" data-file="${esc(file)}">${icon('file')}<span>${esc(file)}<small>${i?'Proposed configuration':'Inspection notes'} · Sample</small></span>${icon('chevron')}</button>`).join('')}</div>`;
}
function inspector() {
 return `<aside class="inspector"><div class="inspector-title"><h2>Evidence</h2>${iconButton('inspector','panel','Close evidence')}</div><div class="evidence-tabs" role="tablist" aria-label="Evidence view">${['overview','changes','activity'].map(value=>`<button role="tab" data-tab="${value}" aria-selected="${tab===value}" aria-controls="evidence-content" id="tab-${value}">${value[0].toUpperCase()+value.slice(1)}</button>`).join('')}</div><div id="evidence-content" role="tabpanel" aria-labelledby="tab-${tab}">${tab==='overview'?`<div class="section-label">The handoff<span class="small">${task().duration}</span></div>${routeGraphic()}<div class="inspector-section"><div class="section-label">${task().id==='backup'?'Proposed change':'Findings'}</div>${diff()}</div><div class="inspector-section"><div class="section-label">Artifacts<span class="small">2 files</span></div>${files()}</div>`:tab==='changes'?diff():task().id==='backup'?events():`<p class="small">Inspection completed in ${task().duration}. ${esc(task().result)}.</p>`}</div><div class="evidence-foot">${icon('shield')}Every action leaves a record.</div></aside>`;
}
function studio() {
 return `<div class="shell studio ${evidenceOpen?'evidence-hidden':''}"><aside class="sidebar ${menuOpen?'mobile-open':''}">${nav()}</aside><main class="studio-main">${titlebar()}<div class="workbench"><div class="conversation-pane"><div class="conversation-scroll">${conversation()}</div>${composer()}</div>${inspector()}</div></main></div>`;
}
function precision() {
 return `<div class="shell precision"><header class="app-topnav">${topnav()}</header><div class="precision-body"><aside class="queue ${menuOpen?'mobile-open':''}"><div class="queue-heading"><h2>Tasks <span class="small">${fixtures.length}</span></h2>${iconButton('new','plus','New sample task')}</div><div class="queue-filter">${icon('search')}<label class="sr-only" for="filter">Filter tasks</label><input id="filter" placeholder="Filter tasks…"></div><div class="task-list">${taskRows()}</div><div class="queue-bottom">${icon('shield')}Private workspace</div></aside><main class="precision-main">${titlebar()}<div class="precision-scroll"><div class="precision-title"><span class="small">${esc(task().group)} / ${esc(task().host)}</span><h2>${esc(task().title)}</h2><div class="run-facts"><span>${icon('clock')}${task().duration}</span><span>${icon('shield')}${task().scope}</span><button class="text-button" data-action="replay">${icon('play')}Replay run</button></div></div>${routeGraphic()}<div class="precision-columns"><section class="execution"><div class="section-label">Execution record<span class="small">${task().time}</span></div>${task().id==='backup'?events():findings()}<div class="execution-answer"><h3>Agent’s conclusion</h3><p>${esc(task().answer)}</p></div></section><section class="patch"><div class="section-label">${task().id==='backup'?'Proposed patch':'Report'}</div>${diff()}${files()}</section></div>${decision()}<div class="precision-followups">${task().messages.map(m=>`<p>${esc(m)}</p>`).join('')}</div></div>${composer()}</main></div></div>`;
}
function quiet() {
 return `<div class="shell quiet"><header class="app-topnav">${topnav()}</header><main class="quiet-main"><div class="quiet-toolbar"><div class="title-left"><span class="breadcrumb">${esc(task().group)}</span>${icon('chevron')}<h1>${esc(task().short)}</h1></div><div class="title-actions">${badge()}${pending(task())?'<button class="text-button review-shortcut" data-action="review">Review</button>':''}${iconButton('search','tasks','Choose a task')}</div></div><div class="quiet-scroll">${conversation()}</div><div class="quiet-composer">${composer()}</div></main><footer class="task-shelf"><span class="small">In your workspace</span>${fixtures.slice(0,3).map(t=>`<button data-task="${t.id}" class="${t.id===taskId?'selected':''}">${icon(pending(t)?'clock':'check')}<span>${esc(t.short)}</span></button>`).join('')}${iconButton('new','plus','New sample task')}</footer></div>`;
}
function comparison() {
 return `<main class="comparison"><div class="comparison-intro"><div><h1>Same ink. Three different rhythms.</h1><p>A comfortable workbench, a precise execution desk, or a quieter place to think.</p></div><span class="small">Choose a direction to explore it.</span></div><div class="comparison-grid">${Object.entries(descriptions).map(([key,description])=>`<article class="comparison-card"><div class="preview-frame"><iframe title="${description.split(' / ')[0]} preview" tabindex="-1" inert aria-hidden="true" src="index.html?design=${key}&embed=1&motion=off${light?'&theme=light':''}"></iframe></div><div class="comparison-copy"><h2>${description.split(' / ')[0]}</h2><p>${key==='studio'?'A conversation with its evidence close by. Rounded, spacious, and quietly capable.':key==='precision'?'The full chain of events, without the noise. Compact tools and exact changes.':'A single thread of thought. Open space, a readable answer, and detail on demand.'}</p><button class="primary" data-design="${key}">Explore ${key==='studio'?'Studio':key==='precision'?'Precision':'Quiet'} ${icon('chevron')}</button></div></article>`).join('')}</div><div class="comparison-note">All three include interactive approvals, sample messages, task switching, and replayable motion. Nothing connects to your servers.</div></main>`;
}
function render(animate = false) {
 document.body.dataset.design = design;
 document.body.dataset.theme = light ? 'light' : 'dark';
 document.body.dataset.motion = motion ? 'on' : 'off';
 document.querySelectorAll('.design-tabs button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.design===design && !compare));
 document.querySelector('.tab-slider').style.setProperty('--index',['studio','precision','quiet'].indexOf(design));
 document.querySelector('.tab-slider').style.opacity = compare ? 0 : 1;
 const themeButton = document.querySelector('[data-action="theme"]');
 themeButton.innerHTML = icon(light?'moon':'sun');
 themeButton.setAttribute('aria-label',`Switch to ${light?'dark':'light'} appearance`);
 const motionButton = document.querySelector('[data-action="motion"]');
 motionButton.innerHTML = icon(motion?'pause':'play');
 motionButton.setAttribute('aria-label',`Turn motion ${motion?'off':'on'}`);
 motionButton.setAttribute('aria-pressed',motion);
 document.querySelector('#direction-caption').textContent = compare ? 'Outpost / A study in Graphite Ink.' : descriptions[design];
 const focused = document.activeElement;
 const focusSelector = focused?.id ? `#${CSS.escape(focused.id)}` : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]` : null;
 const draft = task().draft || '';
 const scrollTop = document.querySelector('.conversation-scroll, .quiet-scroll, .precision-scroll')?.scrollTop;
 app.innerHTML = compare ? comparison() : ({studio,precision,quiet}[design])();
 if (draft && document.querySelector('#message')) document.querySelector('#message').value = draft;
 if (focusSelector && !compare) app.querySelector(focusSelector)?.focus({preventScroll:true});
 if (scrollTop && !animate) document.querySelector('.conversation-scroll, .quiet-scroll, .precision-scroll')?.scrollTo(0,scrollTop);
 if (animate && motion) app.animate([{opacity:.45,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});
}
function notify(message) {
 clearTimeout(toastTimer);
 const toast = document.querySelector('#toast');
 toast.textContent = message;
 toast.classList.add('visible');
 toastTimer = setTimeout(()=>toast.classList.remove('visible'),3500);
}
function openModal(title, content) {
 modal.innerHTML = `<div class="modal-top"><h2 id="modal-title">${title}</h2>${iconButton('close','close','Close dialog')}</div>${content}`;
 modal.showModal();
}
function review() {
 openModal('Review the exact change',`<div class="modal-status">${icon('shield')}Approval preview · No live action</div><h3>Update the backup schedule</h3><p>Move the daily backup to 02:30 UTC so the snapshot can finish first.</p><dl class="action-facts"><div><dt>Machine</dt><dd>worker</dd></div><div><dt>File</dt><dd><code>/etc/systemd/system/backup.timer</code></dd></div><div><dt>Effect</dt><dd>Reload and restart the timer, not the server.</dd></div></dl>${diff()}<p class="small">This mock only changes the preview state. It cannot execute commands, edit files, or approve a real action.</p><div class="modal-actions"><button data-action="close">Not now</button><button class="primary" data-action="approve">${icon('check')}Simulate approval</button></div>`);
}
function stopReplay() { clearInterval(runTimer); runStep = -1; }
function replay() {
 stopReplay();
 if (!motion) { notify('Inspection complete. Motion is turned off.'); return; }
 runStep = 0;
 render();
 runTimer = setInterval(()=>{runStep++; if(runStep>3){stopReplay();notify('Sample inspection complete. No server was contacted.');} render();},650);
}
const actions = {
 compare(){stopReplay();compare=!compare;render(true);},
 theme(){light=!light;render();},
 motion(){if(!motion && matchMedia('(prefers-reduced-motion: reduce)').matches){notify('Reduced motion is enabled in your system settings.');return;}motion=!motion;stopReplay();if(!motion)document.getAnimations().forEach(a=>a.cancel());render();},
 replay,
 close(){modal.close();},
 review,
 approve(){approved.add(taskId);modal.close();render(true);notify('Approved in preview only. No server changes.');},
 undo(){approved.delete(taskId);render(true);notify('Preview approval undone.');},
 inspector(){ if(design==='studio'){evidenceOpen=!evidenceOpen;render(true);}else{openModal('Evidence',`${diff()}${files()}`);} },
 fold(){evidenceOpen=!evidenceOpen;render();if(motion)document.querySelector('.inline-evidence')?.animate([{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'translateY(0)'}],{duration:240});document.querySelector('.evidence-fold')?.focus();},
 menu(){menuOpen=!menuOpen;render();},
 tasks(){actions.search();},
 search(){openModal('Your tasks',`<div class="modal-task-list">${taskRows()}</div><p class="small">Sample workspace · ${fixtures.length} tasks</p>`);},
 approvals(){const waiting=fixtures.filter(pending);openModal('Approvals',waiting.length?`<p>One exact action is waiting for your decision.</p><button class="approval-list-item" data-action="open-approval">${icon('shield')}<span>Update the backup schedule<small>worker · 02:00 → 02:30 UTC</small></span>${icon('chevron')}</button>`:'<p>No pending approvals in this sample workspace.</p>');},
 'open-approval'(){taskId='backup';modal.close();render();review();},
 machines(){openModal('Machines',`<p>Illustrative connections, not live telemetry.</p><div class="machine-row">${icon('server')}<div><strong>main</strong><small>Coordinator · Sample connection</small></div><span>Ready</span></div><div class="machine-row">${icon('server')}<div><strong>worker</strong><small>Browser & execution · Sample connection</small></div><span>Ready</span></div>`);},
 library(){openModal('Workspace library',`<p>Files from the selected sample task.</p>${files()}`);},
 artifact(button){const file=button?.dataset.file || task().artifact;openModal(esc(file),`<div class="report-preview"><p class="small">Illustrative artifact · Read-only preview</p><h3>${esc(task().short)}</h3><p>${esc(task().answer)}</p><p>${esc(task().finding)}</p></div><div class="modal-actions"><button data-action="close">Close preview</button></div>`);},
 workspace(){openModal('Personal workspace',`<p>This design study is local and disconnected.</p><dl class="action-facts"><div><dt>Account</dt><dd>Suraj / Personal</dd></div><div><dt>Mode</dt><dd>Sample data only</dd></div><div><dt>Servers</dt><dd>No live connection</dd></div></dl><p class="small">Your production account, keys, and server data are untouched.</p>`);},
 new(){openModal('Start a sample task',`<form id="new-task-form"><label for="task-name">What would you like to work on?</label><input id="task-name" name="title" placeholder="For example, review the morning logs" required maxlength="100"><p class="small">Creates a local preview only. No agent will run.</p><div class="modal-actions"><button type="button" data-action="close">Cancel</button><button class="primary" type="submit">Create sample task</button></div></form>`);},
 attach(){openModal('Add context',`<p>Choose a sample attachment. No files are read from your device.</p><button class="attachment-option" data-action="sample-attach">${icon('file')}server-notes.md<span class="small">Sample file</span></button>`);},
 'sample-attach'(){modal.close();const field=document.querySelector('#message');if(field){field.value+='[Sample attachment: server-notes.md] ';task().draft=field.value;field.focus();}notify('Sample attachment added to your draft.');},
};
document.addEventListener('click', event => {
 const button = event.target.closest('button');
 if (!button) return;
 if(button.dataset.design){stopReplay();design=button.dataset.design;compare=false;evidenceOpen=false;render(true);const url=new URL(location.href);url.searchParams.set('design',design);history.replaceState(null,'',url);}
 else if(button.dataset.task){stopReplay();taskId=button.dataset.task;menuOpen=false;if(modal.open)modal.close();render(true);}
 else if(button.dataset.tab){tab=button.dataset.tab;render();document.querySelector(`#tab-${tab}`)?.focus();if(motion)document.querySelector('#evidence-content')?.animate([{opacity:.3,transform:'translateX(5px)'},{opacity:1,transform:'translateX(0)'}],{duration:200});}
 else actions[button.dataset.action]?.(button);
});
document.addEventListener('submit', event => {
 event.preventDefault();
 if(event.target.matches('.composer')){const field=event.target.querySelector('textarea');if(!field.value.trim()){field.focus();return;}task().messages.push(field.value.trim());task().draft='';field.value='';render();const scroller=document.querySelector('.conversation-scroll, .quiet-scroll, .precision-scroll');scroller?.scrollTo({top:scroller.scrollHeight,behavior:motion?'smooth':'instant'});notify('Sample message added. No agent was contacted.');}
 if(event.target.id==='new-task-form'){const title=new FormData(event.target).get('title').trim();if(!title)return;const id=`local-${Date.now()}`;fixtures.push({id,title,short:title,group:'Personal',prompt:title,headline:'A fresh place to start.',answer:'Your sample task is ready. In the live app, Outpost would begin by understanding your request and gathering evidence.',finding:'This preview does not run an agent. Try sending a follow-up to explore the conversation.',approval:false,host:'workspace',file:'task-notes.md',artifact:'context.md',time:'Now',duration:'0 s',result:'Not started',detail:'No execution in this preview',scope:'Local sample task',messages:[]});taskId=id;modal.close();render(true);notify('Sample task created.');}
});
document.addEventListener('input', event=>{if(event.target.id==='message')task().draft=event.target.value;if(event.target.id==='filter'){const query=event.target.value.toLowerCase();document.querySelectorAll('.queue .task-row').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(query));}});
document.addEventListener('keydown', event=>{
 if((event.metaKey||event.ctrlKey)&&['k','n'].includes(event.key.toLowerCase())){event.preventDefault();if(modal.open)modal.close();actions[event.key.toLowerCase()==='k'?'search':'new']();}
 if(event.target.id==='message'&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.target.form.requestSubmit();}
 if(event.target.matches('[role="tab"]')&&['ArrowRight','ArrowLeft'].includes(event.key)){event.preventDefault();const tabs=['overview','changes','activity'];tab=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:2))%3];render();document.querySelector(`#tab-${tab}`).focus();}
 if(event.key==='Escape'&&menuOpen){menuOpen=false;render();}
});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{if(event.matches){motion=false;stopReplay();document.getAnimations().forEach(a=>a.cancel());render();}});
render();
