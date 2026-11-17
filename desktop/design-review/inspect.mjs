import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
mkdirSync(resolve(root,'screenshots'),{recursive:true});
const routes=['new','chat','settings/general','settings/connection','settings/models','settings/runtime','settings/devices','settings/recovery','automations','memory','chats','approvals'];
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(); const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1}); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(resolve(root,'Outpost-review.html')).href); await page.evaluate(()=>document.fonts.ready);
 for(const width of [1440,900,430]){
  await page.setViewportSize({width,height:1000});
  for(const route of routes){
   await page.evaluate(route=>{location.hash=route;},route); await page.waitForTimeout(100);
   const metrics=await page.evaluate(()=>({rootOverflow:document.documentElement.scrollWidth>innerWidth,main:document.querySelector('main').getBoundingClientRect().width,internal:[...document.querySelectorAll('.review-page,.composer-review,.composer-review-column,.review-scroll')].filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({class:el.className,scroll:el.scrollWidth,client:el.clientWidth}))}));
   console.log(engine.name(),width,route,JSON.stringify(metrics));
   if(width===1440||width===430)await page.screenshot({path:resolve(root,'screenshots',`${engine.name()}-${width}-${route.replace('/','-')}.png`)});
  }
 }
 console.log('RUNTIME ERRORS',JSON.stringify(errors));await browser.close();
}
