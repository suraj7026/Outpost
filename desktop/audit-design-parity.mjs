import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = dirname(fileURLToPath(import.meta.url));
const root = resolve(desktop, 'dist');
const out = resolve(desktop, '../.outpost/parity-audit');
mkdirSync(out, { recursive: true });
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.svg':'image/svg+xml' };
const server = createServer((req,res) => {
  const file=resolve(root,new URL(req.url,'http://local').pathname.slice(1)||'index.html');
  if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404).end();return;}
  res.setHeader('content-type',mime[extname(file)]??'application/octet-stream');res.end(readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const engine=process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser=await engine.launch();
const errors=[],external=[];
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
try {
  const actual=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark',reducedMotion:'reduce'});
  actual.on('pageerror',error=>errors.push(error.message));
  await actual.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
  await actual.addInitScript(({A})=>{
    window.isTauri=true;window.__auditWrites=[];
    const row=(kind,id,data)=>({kind,id,data,revision:1,updatedAt:'2026-11-16T09:00:00Z'});
    const records=[row('task','audit-task',{goal:'Review the deployment logs',state:'paused',profile:'code',model:'glm-5.3',provider:'ollama-cloud'}),row('policy','audit-task',{mode:'ask_permission'}),row('message','audit-owner',{taskId:'audit-task',author:'owner',text:'Review the deployment logs.'}),row('message','audit-reply',{taskId:'audit-task',author:'assistant',text:'The deployment is ready for your review.'}),row('device','audit-mac',{name:'MacBook Pro',revoked:false,publicKey:'SYNTHETIC-PUBLIC-KEY-NOT-VALID'}),row('device','audit-phone',{name:'iPhone',revoked:false,publicKey:'SYNTHETIC-PHONE-KEY-NOT-VALID'}),row('recovery','server',{dispatchEnabled:true}),row('memory','audit-shared',{text:'Run smoke tests before deploying.',shared:true,confirmed:true,forgotten:false}),row('memory','audit-note',{text:'Backups run overnight.',confirmed:true,forgotten:false,project:'operations',source:'Owner note'}),row('automation','audit-schedule',{name:'Check backups',timezone:'UTC',nextAt:Date.now()+3600000,intervalMs:86400000,missed:'coalesce',paused:false,task:{goal:'Report the most recent backup status.',profile:'operations',mode:'ask_permission'}})];
    const providers=[{id:'ollama-cloud',name:'Ollama',configured:true,storedMethod:'api_key',methods:[{type:'api_key',label:'Cloud API key'}]},{id:'openai',name:'OpenAI',configured:true,storedMethod:'oauth',methods:[{type:'oauth',label:'Sign in',subscription:true}]},{id:'anthropic',name:'Anthropic',configured:false,storedMethod:null,methods:[{type:'api_key',label:'API key'}]}];
    const catalogue={protocolVersion:1,piVersion:'1.4.0',releaseId:'fixture-release',profilePath:'/synthetic/profile',generation:'a'.repeat(64),providers,models:[{providerId:'ollama-cloud',modelId:'glm-5.3',name:'GLM 5.3'},{providerId:'openai',modelId:'gpt-6.1-sol',name:'GPT-6.1 Sol'}],defaultModel:{providerId:'ollama-cloud',modelId:'glm-5.3'},refreshedAt:null,refreshErrors:[],capabilities:{providerTransfer:true}};
    window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback(){},async invoke(command,args={}){
      if(command.startsWith('plugin:')||['set_sidebar_window_controls','set_window_blur','update_sidebar','connections_wake'].includes(command))return;
      if(command==='sidebar_pointer_inside')return false;
      if(['setup_list','setup_history_list'].includes(command))return [];
      if(command==='environment_list')return {registry:{version:1,selectedEnvironmentId:A,legacyMutationsRetired:false,environments:{[A]:{environmentId:A,label:'Development',routes:['https://development.example'],activeRoute:'https://development.example'}}},legacy:{endpoint:null,pending:false}};
      if(command==='environment_update_status')throw Error('No update in progress');
      const op=command.replace(/^environment_/,'');
      if(op==='connection_info')return {endpoint:args.environmentId?'https://development.example':null,deviceId:'audit-mac',publicKey:'SYNTHETIC-PUBLIC-KEY-NOT-VALID',pending:false,nativeSidebar:false};
      if(op==='disconnect')return;
      if(op==='stream_events')return new Promise(()=>{});
      if(op==='query'){
        if(args.kind==='snapshot')return {protocolVersion:1,cursor:0,records:args.environmentId?records:[]};
        if(args.kind==='runtime')return {configured:true,piManagement:true,sharedMemory:true,model:'glm-5.3'};
        if(args.kind==='models')return {models:['glm-5.3'],defaultModel:'glm-5.3'};
        if(args.kind==='events')return {events:[],hasMore:false,nextCursor:0};
      }
      if(op==='agent_request'){
        if(['catalogue','refresh'].includes(args.payload.type))return catalogue;
        if(args.payload.type==='transfer.history')return [];
        if(args.payload.type==='runtime.inventory')return {piVersion:'1.4.0',releaseId:'fixture-release',extensions:[{name:'pi-ollama-cloud',version:'0.13.1'}],manifest:null};
      }
      window.__auditWrites.push(command);throw Error('Audit blocked unexpected operation: '+command);
    }};
  },{A});
  await actual.goto(`${origin}/#settings/servers/${A}/general`);await actual.getByRole('heading',{name:'Development',exact:true}).waitFor();await actual.evaluate(()=>document.fonts.ready);
  const reference=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark',reducedMotion:'reduce'});
  await reference.goto(pathToFileURL(resolve(desktop,'design-review/Outpost-review.html')).href);await reference.evaluate(()=>document.fonts.ready);
  const pages=[['general','General'],['connection','Connection'],['models','Models & providers'],['runtime','Pi & extensions'],['devices','Devices'],['recovery','Recovery'],['automations','Automations'],['memory','Memory'],['chats','All chats'],['approvals','Approvals']];
  for(const [id,label] of pages){
    const workspace=['automations','memory','chats','approvals'].includes(id);
    await reference.evaluate(hash=>{location.hash=hash;},workspace?id:`settings/${id}`);
    if(workspace)await actual.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:id==='approvals'?/^Approvals/:label,exact:id!=='approvals'}).click();
    else await actual.evaluate(({A,id})=>{location.hash=`settings/servers/${A}/${id==='connection'?'setup':id}`;},{A,id});
    await actual.waitForTimeout(180);await reference.waitForTimeout(100);
    if(id==='recovery')await reference.getByLabel('Sample recovery state').selectOption('healthy');
    await actual.screenshot({path:resolve(out,`${id}-actual.png`)});await reference.screenshot({path:resolve(out,`${id}-mock.png`)});
  }
  await actual.locator('.new-task-button').click();
  await actual.getByLabel('Task goal').waitFor();
  const iconMetrics = await actual.locator('.app-shell .lucide-server > rect, .app-shell .lucide-panel-left-close > rect, .app-shell .lucide-square-terminal > rect').evaluateAll(nodes => nodes.map(node => ({ glyph: node.parentElement.getAttribute('class'), radius: getComputedStyle(node).rx, join: getComputedStyle(node.parentElement).strokeLinejoin, cap: getComputedStyle(node.parentElement).strokeLinecap })));
  assert.ok(iconMetrics.some(icon => icon.glyph.includes('lucide-server')), 'Server glyph is rendered');
  assert.ok(iconMetrics.some(icon => icon.glyph.includes('lucide-square-terminal')), 'Terminal glyph is rendered');
  for(const icon of iconMetrics) { assert.equal(icon.radius,icon.glyph.includes('lucide-square-terminal')?'5px':'3px'); assert.equal(icon.join,'round'); assert.equal(icon.cap,'round'); }
  await actual.locator('.composer-context').screenshot({path:resolve(out,`rounded-icons-${engine.name()}.png`)});
  const writes=await actual.evaluate(()=>window.__auditWrites);
  writeFileSync(resolve(out,'results.json'),JSON.stringify({engine:engine.name(),iconMetrics,errors,external,writes,reference:'desktop/design-review/Outpost-review.html',actual:'desktop/dist',data:'Synthetic; no installed app or real server operations'},null,2));
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Outpost — mock vs implementation</title><style>body{background:#141517;color:#ededef;font:14px/1.6 system-ui;margin:32px}h1{font-size:25px}p{color:#a1a3a8;max-width:900px}nav{display:flex;gap:16px;flex-wrap:wrap;position:sticky;top:0;background:#141517;padding:12px 0}a{color:inherit}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;border-radius:8px;border:1px solid #303238}figure{margin:0}figcaption{margin:8px 0;color:#a1a3a8}section{padding:24px 0;border-top:1px solid #303238}h2{font-size:18px}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><h1>Approved mock → actual implementation</h1><p>The left side is the exact approved HTML. The right side is the production frontend with synthetic data. Names and records differ; compare structure, hierarchy, rows and interactions. This is an audit, not a claim of parity. No real server was contacted.</p><nav>${pages.map(([id,label])=>`<a href="#${id}">${label}</a>`).join('')}</nav>${pages.map(([id,label])=>`<section id="${id}"><h2>${label}</h2><div class="pair"><figure><figcaption>Approved mock</figcaption><img src="${id}-mock.png" alt="Approved ${label}"></figure><figure><figcaption>Production frontend</figcaption><img src="${id}-actual.png" alt="Current ${label}"></figure></div></section>`).join('')}</html>`;
  writeFileSync(resolve(out,'comparison.html'),html);
  console.log(JSON.stringify({engine:engine.name(),pages:pages.length,roundedIconsChecked:iconMetrics.length,errors,external,writes,gallery:resolve(out,'comparison.html')},null,2));
  if(errors.length||external.length||writes.length)process.exitCode=1;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
