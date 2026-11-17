import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch(); const page=await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(4000);
 const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',req=>{if(/^https?:/.test(req.url()))requests.push(req.url());});
 try {
  await page.goto(pathToFileURL(resolve(root,'Outpost-review.html')).href); await page.evaluate(()=>document.fonts.ready);
  const go=async route=>{await page.evaluate(route=>location.hash=route,route);await page.waitForTimeout(100);};
  await page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:'Machines',exact:true}).click();
  check(await page.getByRole('navigation',{name:'Server settings tabs'}).isVisible(),'Machines opens server settings');
  check(await page.locator('.review-tabs button').count()===6,'All six settings sections live inside Machines');
  check(await page.locator('.review-tabs [aria-current=page]').textContent()==='General','Machines defaults to General');
  check(await page.locator('.review-sidebar').getByText('SERVER SETTINGS',{exact:true}).count()===0,'Standalone server settings sidebar group removed');
  await page.getByRole('navigation',{name:'Server settings tabs'}).getByRole('button',{name:'Devices',exact:true}).click();
  check(await page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:'Machines',exact:true}).getAttribute('aria-current')==='page','Machines stays selected within its settings pages');
  const routes=['new','chat','machines','automations','memory','chats','approvals','settings/general','settings/connection','settings/models','settings/runtime','settings/devices','settings/recovery'];
  for(const width of [1440,900,430]){
   await page.setViewportSize({width,height:1000});
   for(const route of routes){await go(route);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route} ${width} document fits`);check(await page.evaluate(()=>[...document.querySelectorAll('.review-page,.composer-review,.review-scroll')].every(el=>el.scrollWidth<=el.clientWidth+2)),`${route} ${width} content fits`);if(route.startsWith('settings/'))check(await page.locator('.review-tabs [aria-current=page]').count()===1,'Only one selected settings tab');}
  }
  await page.setViewportSize({width:1440,height:1000});
  const geometry=[];
  for(const route of ['new','chat']){
   await go(route); const permission=page.getByRole('combobox',{name:'Control mode',exact:true});const model=page.getByRole('combobox',{name:'Model',exact:true});
   geometry.push(await page.locator('.composer-review-composer').evaluate(node=>({padding:getComputedStyle(node).padding,radius:getComputedStyle(node).borderRadius,fieldHeights:[...node.querySelectorAll('.review-select-surface')].map(el=>el.getBoundingClientRect().height)})));
   await permission.selectOption('ask_permission');check(await permission.inputValue()==='ask_permission','Permission changes');
   await model.selectOption('openai/gpt-6.1-sol');check(await model.inputValue()==='openai/gpt-6.1-sol','Model changes');
   await permission.hover();check(await permission.evaluate(el=>getComputedStyle(el.parentElement).backgroundColor)==='rgb(41, 43, 48)','Permission whole surface highlights');
   check(await permission.evaluate(el=>el.parentElement.querySelector('.review-select-icon')!==null),'Shield inside same surface');
   const surface=await model.evaluate(el=>({padding:getComputedStyle(el).paddingRight,appearance:getComputedStyle(el).appearance}));check(parseFloat(surface.padding)>=30&&surface.appearance==='none','Model reserves comfortable chevron padding; no native arrows');
   await page.getByRole('button',{name:'Terminal (sample session)',exact:true}).click();check(await page.getByRole('region',{name:'Sample server terminal'}).isVisible(),'Terminal opens');
   await page.screenshot({path:resolve(root,'screenshots',`${engine.name()}-terminal.png`)});
   await page.getByRole('button',{name:'Close terminal',exact:true}).click();
  }
  assert.deepEqual(geometry[0],geometry[1]);checks++;
  await go('new');check(await page.getByText('What should run next?',{exact:true}).count()===0,'Removed old heading');
  await page.getByRole('textbox',{name:'Task goal'}).fill('Summarize the sample logs');await page.getByRole('button',{name:'Start task (preview)'}).click();await page.getByText('Summarize the sample logs',{exact:true}).waitFor();check(true,'Preview composer sends locally');
  await go('automations');const create=page.getByRole('button',{name:'New schedule',exact:true});await create.click();const dialog=page.getByRole('dialog');check(await dialog.isVisible(),'Schedule dialog opens');check(await page.getByLabel('Permission',{exact:true}).inputValue()==='ask_permission','Schedule defaults to Ask permission');
  await page.screenshot({path:resolve(root,'screenshots',`${engine.name()}-schedule-dialog.png`)});
  await page.keyboard.press('Escape');check(await dialog.count()===0,'Escape dismisses dialog');check(await create.evaluate(el=>el===document.activeElement),'Pointer-opened dialog restores focus');
  await create.click();await page.getByLabel('Schedule name',{exact:true}).fill('Morning report');await page.getByLabel('What should it do?',{exact:true}).fill('Summarize sample logs every morning');await dialog.getByRole('button',{name:'Create schedule',exact:true}).click();await page.getByText('Morning report',{exact:true}).waitFor();check(true,'Schedule created in mock');
  await page.getByRole('button',{name:'Edit Morning report',exact:true}).click();check(await page.getByLabel('Schedule name').inputValue()==='Morning report','Schedule edit prefilled');await page.keyboard.press('Escape');
  await go('memory');await page.getByRole('button',{name:'Add note',exact:true}).click();await page.getByLabel('Note',{exact:true}).fill('Use the staging environment for previews.');await page.getByRole('dialog').getByRole('button',{name:'Add note',exact:true}).click();check(await page.getByText('Use the staging environment for previews.',{exact:true}).count()===1,'Note saved in mock');
  await go('settings/models');await page.getByRole('button',{name:'Add provider',exact:true}).click();check(await page.getByRole('dialog').isVisible(),'Provider dialog opens');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Pi & extensions',exact:true}).hover();check(await page.locator('.review-tabs [aria-current=page]').textContent()==='Models & providers','Hover does not change selected tab');
  await go('settings/runtime');await page.getByRole('button',{name:'Check for update',exact:true}).click();await page.getByRole('button',{name:'Review update…',exact:true}).click();check(await page.getByRole('dialog').getByRole('checkbox').count()===1,'Runtime update requires acknowledgement');await page.keyboard.press('Escape');
  await go('approvals');await page.getByRole('switch',{name:'Show example'}).check();await page.getByRole('button',{name:'Review this action',exact:true}).click();check(await page.getByRole('dialog').isVisible(),'Approval review opens');await page.getByRole('button',{name:'Approve example'}).click();check(await page.getByText('Approved',{exact:true}).count()===1,'Example decision recorded');
  check(errors.length===0,`No runtime errors: ${errors}`);check(requests.length===0,'No network requests');console.log(`PASS ${engine.name()} flows, layout, focus, control consistency, offline safety`);
 } finally{await browser.close();}
}
console.log(`${checks} assertions passed.`);
