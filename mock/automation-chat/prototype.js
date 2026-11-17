'use strict';
// A disconnected design prototype. All schedules, messages and results live in memory.
const icons = {
  message:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  up:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  play:'<path d="m7 4 14 8-14 8V4Z"/>',
  edit:'<path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  link:'<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  warning:'<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"/>',
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.clock}</svg>`;
const mark = '<svg class="assistant-mark" viewBox="0 0 24 28" fill="none" aria-hidden="true"><path d="M4 7 12 2l8 5v14l-8 5-8-5V7Z M4 7l8 5 8-5M12 12v14" stroke="currentColor" stroke-width="1.7"/></svg>';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (text, action, extra='', cls='') => `<button class="button ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const timers = new Set();
let state, editorContext, returnFocus, toastTimer;
const baseNow = Date.parse('2026-11-16T05:12:00Z');
function reset() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  state = {now:baseNow, sequence:0, view:'chat', chat:'server-checks', filter:'all', scenario:'complete', tour:'setup',
    chats:[{id:'server-checks',title:'Home server check-in',dedicated:false,messages:[],unread:false},{id:'backup-chat',title:'Weekly backup check',dedicated:true,messages:[],unread:false}],
    automations:[{id:'health',chat:'server-checks',name:'Daily server health',prompt:'Check the reachability and load of my home servers. Summarize what changed and report any access issues here.',frequency:'daily',time:'11:00',timezone:'Asia/Kolkata',date:'2026-11-17',status:'draft',runs:[],version:1},
      {id:'backup',chat:'backup-chat',name:'Weekly backup check',prompt:'Check whether the latest backup completed. Report its age, size, and any failures in this chat.',frequency:'weekly',time:'09:00',timezone:'Asia/Kolkata',date:'2026-11-17',status:'paused',runs:[],version:1}]
  };
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  render();
}
const automation = id => state.automations.find(a=>a.id===id);
const chat = id => state.chats.find(c=>c.id===id);
const attached = id => state.automations.filter(a=>a.chat===id && a.status!=='draft');
const clock = (at, zone='Asia/Kolkata') => new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit'}).format(at);
const dateLabel = (at, zone='Asia/Kolkata') => new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short',year:'numeric'}).format(at);
const zoneName = a => a.timezone==='Asia/Kolkata'?'IST':a.timezone==='UTC'?'UTC':a.timezone;
const parts = (at, timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
function zonedEpoch(date,time,zone) {
  const wall = Date.parse(`${date}T${time}:00Z`); let result=wall;
  for(let i=0;i<3;i++) { const p=parts(result,zone); result += wall-Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); }
  return result;
}
function nextAt(a) {
  if(a.frequency==='once') return zonedEpoch(a.date,a.time,a.timezone);
  const p=parts(state.now,a.timezone), start=Date.parse(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  for(let day=0;day<15;day++) {
    const d=new Date(start+day*86400000), weekday=d.getUTCDay();
    if(a.frequency==='weekdays' && [0,6].includes(weekday) || a.frequency==='weekly' && weekday!==1) continue;
    const result=zonedEpoch(d.toISOString().slice(0,10),a.time,a.timezone);
    if(result>state.now) return result;
  }
  throw new Error('No next occurrence in the preview window.');
}
function scheduleLabel(a) {
  const when=clock(zonedEpoch('2026-11-17',a.time,a.timezone),a.timezone);
  return `${{daily:'Every day',weekdays:'Weekdays',weekly:'Every Monday',once:dateLabel(nextAt(a),a.timezone)}[a.frequency]} at ${when}`;
}
function nextLabel(a) { return a.status==='paused'?'Paused':`${dateLabel(nextAt(a),a.timezone)} · ${clock(nextAt(a),a.timezone)} ${zoneName(a)}`; }
function statusHtml(a) { return `<span class="status"><span class="dot ${a.status==='paused'?'paused':''}"></span>${a.status==='paused'?'Paused':'Active'}</span>`; }
function notify(text) { const el=document.querySelector('#toast'); el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3200); }
function go(view, chatId=state.chat) { state.view=view;state.chat=chatId;if(view==='chat') chat(chatId).unread=false;render();document.querySelector('#main').focus({preventScroll:true}); }
function hydrateIcons(root=document) { root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon)); }
function render() {
  document.querySelector('#chat-list').innerHTML=state.chats.map(c=>`<button class="chat-button" data-action="chat" data-chat="${c.id}" ${state.view==='chat'&&state.chat===c.id?'aria-current="page"':''}>${icon(c.dedicated?'clock':'message')}<span>${esc(c.title)}</span>${c.unread?'<i class="unread" aria-label="New result"></i>':''}</button>`).join('');
  document.querySelectorAll('.main-nav button').forEach(b=>b.toggleAttribute('aria-current',false));
  document.querySelector(`.main-nav [data-action="${state.view==='chat'?'chat':'automations'}"]`).setAttribute('aria-current','page');
  document.querySelectorAll('.tour button').forEach(b=>{b.removeAttribute('aria-current');if(b.dataset.action===`tour-${state.tour}`)b.setAttribute('aria-current','step');});
  document.querySelector('#main').innerHTML=state.view==='chat'?renderChat():renderAutomations();
  hydrateIcons();
}
function assistant(text,time='10:42 AM') { return `<article class="message"><div class="byline">${mark}<strong>Outpost</strong><time>${esc(time)}</time></div>${text}</article>`; }
function owner(text,time='10:42 AM') { return `<article class="message owner"><div class="byline"><strong>You</strong><time>${esc(time)}</time><span class="avatar">S</span></div><p>${esc(text)}</p></article>`; }
function card(a, draft=false) {
  return `<section class="schedule-card" aria-label="${draft?'Review schedule':'Saved automation'}"><div class="schedule-card-header">${icon('clock')}<div class="grow"><h2>${esc(a.name)}</h2><p>${draft?'Review before scheduling':'Automation saved in this conversation'}</p></div>${draft?'<span class="tag">Draft</span>':statusHtml(a)}</div>
    <div class="schedule-details"><dl><dt>Schedule</dt><dd>${esc(scheduleLabel(a))} · ${esc(zoneName(a))}</dd><dt>${a.status==='paused'?'Next run':'First / next run'}</dt><dd>${esc(nextLabel(a))}</dd><dt>Delivery</dt><dd>${icon('message')} This chat</dd><dt>Runs on</dt><dd>Outpost 2 · Ask permission</dd></dl></div>
    <div class="schedule-footer"><span class="small">${draft?'Nothing runs until you create it.':'Prompts and results stay together.'}</span><div class="inline">${button('Edit','edit',`data-id="${a.id}"`,'ghost')}${draft?button('Create automation','confirm',`data-id="${a.id}"`,'primary'):button('Manage','manage',`data-id="${a.id}"`)}</div></div></section>`;
}
function renderChat() {
  const c=chat(state.chat), items=attached(c.id), health=automation('health'), isOriginal=c.id==='server-checks';
  const runs=state.automations.filter(a=>a.chat===c.id).flatMap(a=>a.runs.map(run=>({a,run}))).sort((x,y)=>x.run.at-y.run.at);
  let history='';
  if(isOriginal) history=owner('Every day at 11am IST, check my home servers and report back here.')+assistant(`<p>${health.status==='draft'?"I’ll check your servers daily and keep each report in this conversation.":"Scheduled. I’ll send the prompt and each report right here."} No email or separate cron job needed.</p>${health.status==='draft'?'<p class="muted small">Existing permissions still apply. If a check needs access, I’ll tell you here.</p>':''}${card(health,health.status==='draft')}`);
  else if(items.length) history=`<section class="welcome">${icon('clock')}<h2>A home for ${esc(items[0].name.toLowerCase())}.</h2><p>This conversation was created with your automation. Scheduled prompts, results, and your follow-ups will all live here.</p>${card(items[0])}<div class="creation-note">${icon('check')} Created from Automations · No run started on creation</div></section>`;
  const timeline=[...c.messages.map(m=>({order:m.order,html:m.author==='owner'?owner(m.text,clock(m.at)):assistant(`<p>${esc(m.text)}</p>`,clock(m.at))})),...runs.map(({a,run})=>({order:run.order,html:renderRun(a,run)}))];
  history+=timeline.sort((a,b)=>a.order-b.order).map(entry=>entry.html).join('');
  const active=items.find(a=>a.status==='active'), latest=runs.at(-1)?.run;
  return `<div class="chat-heading"><div><h1>${esc(c.title)}</h1><p>Outpost 2${c.dedicated?' · Automation conversation':''}</p></div>${button(icon('clock')+` ${items.length?'Automations · '+items.length:'Schedule'}`,items.length?'manage-chat':'schedule-chat')}</div>
    <div class="chat-scroll"><div class="transcript">${history}</div></div>
    <div class="composer-area"><div class="composer-stack">
      ${items.length?`<div class="demo-controls"><span>Preview a run</span><label><span>Outcome</span><select aria-label="Simulated run outcome" id="scenario">${[['complete','Report ready'],['blocked','Access blocked'],['queued','Chat is busy'],['approval','Needs permission']].map(([v,label])=>`<option value="${v}" ${state.scenario===v?'selected':''}>${label}</option>`).join('')}</select></label><button class="text-button" data-action="simulate" ${active?'':'disabled'}>${icon('play')} Simulate next run</button></div>`:''}
      ${items.length?`<div class="automation-strip">${icon('clock')}<span>${items.length} automation${items.length===1?'':'s'}</span><span class="next-time">· ${active?esc(scheduleLabel(active)+' '+zoneName(active)):'Paused'}</span><button class="link-button" data-action="manage-chat">Manage ${icon('chevron')}</button></div>`:''}
      <div class="server-strip"><span class="inline">${icon('server')} Outpost 2 <i class="dot"></i></span><span class="inline">${latest?.status==='running'?'<span class="spinner"></span> Running sample check':'Ready for your next instruction'}</span></div>
      <form class="composer" id="composer"><textarea aria-label="Message Outpost" placeholder="Ask a follow-up, or schedule something for later…" maxlength="2000"></textarea><div class="composer-tools">${button(icon('clock')+' Schedule','schedule-chat','','ghost')}<span class="small muted">Ask permission</span><button class="button send" type="submit" aria-label="Send message">${icon('up')}</button></div></form><p class="composer-caption">Preview only. Messages and automation changes reset when you reload.</p>
    </div></div>`;
}
function renderRun(a,r) {
  const labels={complete:'Report ready',blocked:'Access blocked',queued:'Queued',approval:'Needs permission',running:'Running',denied:'Permission declined'};
  let result='';
  if(r.status==='queued') result=`<div class="queue-box"><h2>Queued behind your current response</h2><p>Your scheduled prompt won’t interrupt the conversation. It will run when the current turn finishes.</p>${button('Finish current turn · preview','release',`data-run="${r.id}"`)}</div>`;
  else if(r.status==='running') result=`<div class="queue-box"><h2 class="inline"><span class="spinner"></span> Running sample check</h2><p>The response will appear below this scheduled prompt.</p></div>`;
  else if(r.status==='approval') result=`<div class="queue-box"><h2>Permission needed to continue</h2><p>This run needs permission to inspect the server. Scheduling a prompt does not bypass your approval settings.</p>${button('Review action','review',`data-run="${r.id}"`)}</div>`;
  else if(r.status==='denied') result=assistant('<p>The inspection was not run because permission was declined. Future scheduled runs still use your existing permission settings.</p>',clock(r.at,a.timezone));
  else if(r.status==='blocked') result=assistant(`<div class="run-result"><h2>One check needs access.</h2><p>The sample reachability check finished, but the load check could not connect over SSH. I haven’t retried or changed permissions.</p><div class="queue-box"><h2>surajhomeserver · SSH key not authorized</h2><p>Authorize the intended key before retrying this check. Creating an automation doesn’t grant access to a machine.</p></div><p class="report-note">Partial result · Schedule remains ${a.status==='paused'?'paused':'active'}. This access issue is recorded in this chat.</p></div>`,clock(r.at,a.timezone));
  else result=assistant(`<div class="run-result"><details class="evidence"><summary>${icon('chevron','chevron')}<span class="dot"></span> ${a.id==='health'?'2 server checks':'Scheduled check'} completed <span class="duration">Sample evidence</span></summary><div class="evidence-body">${a.id==='health'?'Reachability: both sample hosts responded.<br>Load: sample 1-minute readings shown below.':'This is an illustrative result for your saved prompt, not a real tool response.'}<br>No live commands were executed.</div></details><h2>${a.id==='health'?'Both servers are reachable.':'Your scheduled check is ready.'}</h2><p>${a.id==='health'?'The sample readings are below. No access changes or restarts were needed.':'This is where Outpost’s response to your saved prompt will appear, with tool activity and any generated reports.'}</p>${a.id==='health'?'<table class="report-table"><thead><tr><th>Server</th><th>Reachability</th><th class="num">Load · 1 min</th></tr></thead><tbody><tr><td>surajhomeserver</td><td><span class="status"><i class="dot"></i> Online</span></td><td class="num">0.42</td></tr><tr><td>surajhomeserver2</td><td><span class="status"><i class="dot"></i> Online</span></td><td class="num">0.18</td></tr></tbody></table>':''}<p class="report-note">${a.runs.filter(x=>x.status==='complete').length===1?'First sample report — no previous reading to compare.':'Another run in the same conversation — earlier reports stay above.'} ${a.status==='paused'?'The schedule is paused.':`Next scheduled prompt: ${esc(nextLabel(a))}.`}</p><div class="result-actions">${button('Ask about this report','followup','','ghost')}</div></div>`,clock(r.at,a.timezone));
  return `<section class="run" id="run-${r.id}"><div class="day-separator">${esc(dateLabel(r.at,a.timezone))}</div><div class="scheduled-prompt"><div class="byline">${icon('clock')}<strong>${r.manual?'Manual run':'Scheduled prompt'}</strong><span>· ${esc(a.name)}</span><time>${esc(clock(r.at,a.timezone))} ${esc(zoneName(a))}</time></div><p>${esc(r.prompt)}</p><div class="run-status inline">${r.status==='running'?'<span class="spinner"></span>':icon(r.status==='complete'?'check':r.status==='blocked'?'warning':'clock')}${labels[r.status]} · ${r.manual?'Started from automation controls':'Sent by your automation'}</div></div>${result}</section>`;
}
function renderAutomations() {
  const all=state.automations.filter(a=>a.status!=='draft'), rows=all.filter(a=>state.filter==='all'||a.status===state.filter);
  return `<div class="page-scroll"><div class="page"><header class="page-header"><div><h1>Automations</h1><p>Scheduled prompts. Results right where the conversation happens.</p></div>${button(icon('plus')+' New automation','new-automation','','primary')}</header>
    <div class="list-controls"><div class="filters" aria-label="Filter automations">${[['all','All'],['active','Active'],['paused','Paused']].map(([v,t])=>`<button data-action="filter" data-value="${v}" aria-pressed="${state.filter===v}">${t}</button>`).join('')}</div><span class="small">${rows.length} automation${rows.length===1?'':'s'} · Outpost 2</span></div>
    ${rows.length?rows.map(a=>{const latest=a.runs.at(-1);return `<article class="automation-row"><div><div class="row-title"><h2>${esc(a.name)}</h2>${statusHtml(a)}</div><p class="row-subtitle">${esc(scheduleLabel(a))} · ${esc(zoneName(a))} · Ask permission</p><p class="row-prompt">${esc(a.prompt)}</p><div class="row-destination"><button class="link-button" data-action="chat" data-chat="${a.chat}">${icon('message')} ${esc(chat(a.chat).title)} ${icon('arrow')}</button><span class="muted small"> · ${chat(a.chat).dedicated?'Dedicated chat':'Original chat'}</span></div><div class="row-meta"><span>${a.status==='paused'?'Next run: paused':`Next: ${esc(nextLabel(a))}`}</span><span>Last run: ${latest?esc({complete:'Report ready',blocked:'Access blocked',queued:'Queued',approval:'Needs permission',running:'Running',denied:'Permission declined'}[latest.status]):'Not run yet'}</span></div></div><div class="row-actions">${button('Open chat '+icon('arrow'),'chat',`data-chat="${a.chat}"`)}${button(icon(a.status==='paused'?'play':'pause'),'toggle',`data-id="${a.id}" aria-label="${a.status==='paused'?'Resume':'Pause'} ${esc(a.name)}"`,'ghost icon-button')}${button(icon('edit'),'edit',`data-id="${a.id}" aria-label="Edit ${esc(a.name)}"`,'ghost icon-button')}</div></article>`;}).join(''):`<div class="empty-list"><h2>No ${state.filter==='all'?'':state.filter+' '}automations yet.</h2><p>Create a schedule here, or ask Outpost to schedule something in a conversation.</p>${button('Create an automation','new-automation')}</div>`}
    <div class="page-help">${icon('info')}<p>Created in a chat? Results return to that chat. Created here? We’ll make a dedicated conversation for it. Your server runs schedules even when the desktop app is closed; this preview does not.</p></div>
  </div></div>`;
}
function openDialog(id,html) { returnFocus=document.activeElement;const el=document.getElementById(id);el.innerHTML=html;el.showModal();hydrateIcons(el); }
function closeDialog(id) {document.getElementById(id).close();if(returnFocus?.isConnected)returnFocus.focus();}
function modalHeading(title,id) { return `<div class="dialog-heading"><h2 id="${id}-title">${title}</h2>${button(icon('close'),'close',`data-dialog="${id}" aria-label="Close ${title.toLowerCase()}"`,'ghost icon-button')}</div>`; }
function openEditor(existing,source='page') {
  const a=existing||{name:'Weekly project briefing',prompt:'Summarize project progress, unfinished work, and the next priorities. Post the briefing in this chat.',frequency:'weekly',time:'09:00',timezone:'Asia/Kolkata',date:'2026-11-17'};
  editorContext={id:existing?.id,source,chat:existing?.chat||(source==='chat'?state.chat:null)};
  const title=existing?'Edit automation':'New automation';
  openDialog('editor',`${modalHeading(title,'editor')}<div class="dialog-content"><p class="dialog-intro">Save a prompt once. Outpost picks up the conversation on schedule.</p><form id="automation-form"><label class="field">Name<input name="name" value="${esc(a.name)}" maxlength="100" required></label><label class="field">Prompt<textarea name="prompt" maxlength="2000" required>${esc(a.prompt)}</textarea></label><div class="field-grid"><label class="field">Repeat<select name="frequency">${[['daily','Every day'],['weekdays','Weekdays'],['weekly','Every Monday'],['once','Once']].map(([v,t])=>`<option value="${v}" ${a.frequency===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="field">Time<input name="time" type="time" value="${a.time}" required></label></div><label class="field" id="date-field" ${a.frequency==='once'?'':'hidden'}>Date<input name="date" type="date" value="${a.date}" required></label><label class="field">Timezone<select name="timezone">${['Asia/Kolkata','Europe/London','America/New_York','UTC'].map(z=>`<option ${a.timezone===z?'selected':''}>${z}</option>`).join('')}</select></label><p class="next-preview" id="next-preview"></p><div class="destination"><div class="small inline">${icon('message')} Results go to</div><h3>${editorContext.chat?esc(chat(editorContext.chat).title):'A new, dedicated chat'}</h3><p>${editorContext.chat?'All future runs stay in this conversation.':'We’ll create a chat with this automation’s name. Every run returns to it.'}</p></div><p class="small muted">Outpost 2 · Ask permission. Scheduling does not grant additional access.</p><p class="form-error" id="form-error" role="alert"></p><div class="dialog-actions">${button('Cancel','close','data-dialog="editor"','ghost')}<button type="submit" class="button primary">${existing?'Save changes':editorContext.chat?'Create automation':'Create & open chat'}</button></div></form></div>`);
  updatePreview();
}
function updatePreview() {
  const form=document.querySelector('#automation-form');if(!form)return;
  const a=Object.fromEntries(new FormData(form));document.querySelector('#date-field').hidden=a.frequency!=='once';
  try {const at=nextAt(a);document.querySelector('#next-preview').textContent=`Preview clock: ${dateLabel(state.now,a.timezone)}. Next: ${dateLabel(at,a.timezone)} at ${clock(at,a.timezone)} ${zoneName(a)}.`;}catch {document.querySelector('#next-preview').textContent='Choose a valid date and time.';}
}
function openManager(id) {
  const list=id?[automation(id)]:attached(state.chat);
  openDialog('manager',`${modalHeading('Chat automations','manager')}<div class="dialog-content"><p class="dialog-intro">Manage future prompts without leaving the conversation.</p>${list.map(a=>`<section class="manage-item"><div class="inline spread"><h3>${esc(a.name)}</h3>${statusHtml(a)}</div><p>${esc(scheduleLabel(a))} · ${esc(zoneName(a))}<br>${a.status==='paused'?'No future runs while paused.':`Next: ${esc(nextLabel(a))}`}</p><div class="manage-prompt">${esc(a.prompt)}</div><span class="small muted">${icon('message')} ${esc(chat(a.chat).title)} · Outpost 2</span><div class="manage-actions">${button(icon(a.status==='paused'?'play':'pause')+(a.status==='paused'?' Resume':' Pause'),'toggle',`data-id="${a.id}"`)}${button(icon('edit')+' Edit','edit',`data-id="${a.id}"`)}${button(icon('play')+' Run now','run-now',`data-id="${a.id}"`)}</div></section>`).join('')}<p class="small muted" style="margin-top:16px">Pausing stops future scheduled prompts, not a run already in progress. Run now is an explicit, separate run.</p><div class="dialog-actions">${button('All automations '+icon('arrow'),'all-from-manager','','ghost')}</div></div>`);
}
function revealRun(id) { requestAnimationFrame(()=>document.getElementById(`run-${id}`)?.scrollIntoView({block:'start',behavior:'instant'})); }
function settleRun(a,r,outcome) {
  r.status=outcome;
  if(state.view!=='chat'||state.chat!==a.chat)chat(a.chat).unread=true;
  render();if(state.view==='chat'&&state.chat===a.chat)revealRun(r.id);
}
function simulate(a,manual=false) {
  if(!a)return;
  if(a.runs.some(r=>['running','queued','approval'].includes(r.status)))return notify('This automation already has an unsettled sample run. Finish or review it first.');
  const at=manual?state.now:nextAt(a);state.now=Math.max(state.now,at);
  const r={id:crypto.randomUUID(),order:++state.sequence,at,prompt:a.prompt,version:a.version,manual,status:state.scenario==='queued'?'queued':state.scenario==='approval'?'approval':'running'};a.runs.push(r);
  if(a.frequency==='once'&&!manual)a.status='paused';
  go('chat',a.chat);revealRun(r.id);
  if(r.status==='running') {const outcome=state.scenario==='blocked'?'blocked':'complete';const t=setTimeout(()=>{timers.delete(t);settleRun(a,r,outcome);},1100);timers.add(t);}
}
function findRun(id) {for(const a of state.automations){const r=a.runs.find(r=>r.id===id);if(r)return {a,r};}return null;}
function ensureHealth() {const a=automation('health');if(a.status==='draft')a.status='active';return a;}

document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  if(el.closest('form'))event.preventDefault();
  const action=el.dataset.action, id=el.dataset.id;
  if(action==='chat'){state.tour='setup';go('chat',el.dataset.chat);}
  else if(action==='automations'){state.tour='page';go('automations');}
  else if(action==='tour-setup'){state.tour='setup';go('chat','server-checks');}
  else if(action==='tour-run'){state.tour='run';const a=ensureHealth();state.scenario='complete';if(!a.runs.length){const at=nextAt(a);state.now=at;a.runs.push({id:crypto.randomUUID(),order:++state.sequence,at,prompt:a.prompt,status:'complete'});}go('chat',a.chat);revealRun(a.runs.at(-1).id);}
  else if(action==='tour-page'){ensureHealth();state.tour='page';go('automations');}
  else if(action==='reset'){reset();notify('Demo reset. No real schedules were changed.');}
  else if(action==='confirm'){automation(id).status='active';render();notify('Sample automation created. Future runs return to this chat.');}
  else if(action==='schedule-chat')openEditor(undefined,'chat');
  else if(action==='new-automation')openEditor(undefined,'page');
  else if(action==='edit'){document.querySelectorAll('dialog[open]').forEach(d=>d.close());openEditor(automation(id));}
  else if(action==='close')closeDialog(el.dataset.dialog);
  else if(action==='manage')openManager(id);
  else if(action==='manage-chat')openManager();
  else if(action==='toggle'){
    const a=automation(id);if(a.status==='paused'&&a.frequency==='once'&&nextAt(a)<=state.now)return notify('This one-time schedule has already fired. Edit its date before resuming.');
    a.status=a.status==='paused'?'active':'paused';render();if(document.querySelector('#manager').open)openManagerAfterToggle();notify(`${a.name} ${a.status==='paused'?'paused. Existing runs are unchanged.':'resumed.'}`);
  }
  else if(action==='filter'){state.filter=el.dataset.value;render();}
  else if(action==='simulate')simulate(attached(state.chat).find(a=>a.status==='active'));
  else if(action==='run-now'){closeDialog('manager');simulate(automation(id),true);}
  else if(action==='release'){const found=findRun(el.dataset.run);settleRun(found.a,found.r,'complete');}
  else if(action==='review')openDialog('approval',`${modalHeading('Review sample action','approval')}<div class="dialog-content"><p class="dialog-intro">The scheduled run is waiting for permission, just like a manual request.</p><h3>Inspect server health on Outpost 2</h3><p class="manage-prompt">Read reachability and load readings. No configuration changes, restarts, or writes.</p><p class="small muted">Illustrative approval only. Neither button executes a command.</p><div class="dialog-actions">${button('Decline','decide',`data-run="${el.dataset.run}" data-decision="denied"`)}${button('Approve sample action','decide',`data-run="${el.dataset.run}" data-decision="complete"`,'primary')}</div></div>`);
  else if(action==='decide'){const found=findRun(el.dataset.run);closeDialog('approval');settleRun(found.a,found.r,el.dataset.decision);}
  else if(action==='all-from-manager'){closeDialog('manager');state.tour='page';go('automations');}
  else if(action==='followup'){const input=document.querySelector('#composer textarea');input.value='What changed since the previous report?';input.focus();}
});
function openManagerAfterToggle(){document.querySelector('#manager').close();openManager();}
document.addEventListener('change',e=>{if(e.target.id==='scenario')state.scenario=e.target.value;if(e.target.closest('#automation-form'))updatePreview();});
document.addEventListener('input',e=>{if(e.target.closest('#automation-form'))updatePreview();});
document.addEventListener('submit',e=>{
  e.preventDefault();
  if(e.target.id==='automation-form'){
    const input=Object.fromEntries(new FormData(e.target));input.name=input.name.trim();input.prompt=input.prompt.trim();
    if(!input.name||!input.prompt){document.querySelector('#form-error').textContent='Enter both a name and a prompt.';return;}
    try{if(nextAt(input)<=state.now)throw new Error('Choose a future time for this one-time schedule.');}catch(error){document.querySelector('#form-error').textContent=error.message;return;}
    let a=editorContext.id?automation(editorContext.id):null;
    if(a){Object.assign(a,input,{version:a.version+1});}
    else {
      const chatId=editorContext.chat||crypto.randomUUID();
      if(!editorContext.chat)state.chats.push({id:chatId,title:input.name,dedicated:true,messages:[],unread:false});
      a={...input,id:crypto.randomUUID(),chat:chatId,status:'active',runs:[],version:1};state.automations.push(a);
    }
    const isNew=!editorContext.id;closeDialog('editor');
    if(isNew)go('chat',a.chat);else render();
    notify(isNew?'Sample automation created. No run has started.':'Sample schedule updated. Previous prompts and reports are unchanged.');
  }
  if(e.target.id==='composer'){
    const input=e.target.querySelector('textarea'),text=input.value.trim();if(!text)return;
    const scheduling=/\b(schedule|every|daily|weekly|tomorrow|weekday|remind)\b/i.test(text);
    chat(state.chat).messages.push({author:'owner',text,order:++state.sequence,at:state.now});
    chat(state.chat).messages.push({author:'assistant',order:++state.sequence,at:state.now,text:scheduling?'This preview doesn’t call an AI model. Review the sample schedule and your prompt below; in the live feature, Outpost will interpret the timing from your request.':'Your follow-up stays in this conversation. In the live feature, Outpost will answer using this chat’s available context and reports. This preview does not generate AI responses or change your saved automation prompt.'});
    render();
    const scroller=document.querySelector('.chat-scroll');scroller.scrollTop=scroller.scrollHeight;
    if(scheduling){openEditor(undefined,'chat');document.querySelector('#automation-form [name=prompt]').value=text;}
  }
});
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
reset();
