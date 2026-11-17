import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const url=pathToFileURL(resolve(root,'Outpost-review.html')).href;
let checks=0;
const check=(condition,message)=>{assert.ok(condition,message);checks++;};
for(const engine of [chromium,webkit]){
  const browser=await engine.launch();
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
    for(const width of [1440,900,430]){
      await page.setViewportSize({width,height:1000});
      const positions=[];
      for(const mode of ['new','chat']){
        await page.goto(`${url}?terminal=open#${mode}`);await page.evaluate(()=>document.fonts.ready);
        const pane=page.getByRole('region',{name:'Sample server terminal'});await pane.waitFor();
        const geometry=await pane.evaluate(node=>{
          const pane=node.getBoundingClientRect(), main=node.closest('.review-main').getBoundingClientRect(), screen=node.querySelector('.composer-review-screen').getBoundingClientRect();
          return {left:pane.left,right:pane.right,bottom:pane.bottom,top:pane.top,mainLeft:main.left,mainRight:main.right,mainBottom:main.bottom,screenBottom:screen.bottom,overflow:document.documentElement.scrollWidth>innerWidth};
        });
        check(Math.abs(geometry.left-geometry.mainLeft)<=1 && Math.abs(geometry.right-geometry.mainRight)<=1,'Terminal spans the workspace width');
        check(Math.abs(geometry.bottom-geometry.mainBottom)<=1,'Dock reaches the bottom of the workspace');
        check(Math.abs(geometry.screenBottom-geometry.bottom)<=1,'Output reaches bottom without text-heavy footer');
        check(!geometry.overflow,'No viewport overflow');
        check(await page.locator('.composer-review-terminal-state,.composer-review-terminal-footer').count()===0,'No separate status/footer paragraphs');
        check(await pane.getByRole('img',{name:'Shell connected (preview)'}).isVisible(),'Connection dot has an accessible name');
        positions.push([geometry.left,geometry.right,geometry.top,geometry.bottom]);
        if(width===1440){await page.screenshot({path:resolve(root,'screenshots',`${engine.name()}-terminal-dock-${mode}.png`)});if(mode==='chat')await pane.screenshot({path:resolve(root,'screenshots',`${engine.name()}-terminal-dock-detail.png`)});}
      }
      assert.deepEqual(positions[0],positions[1]);checks++;
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${url}?terminal=open#chat`);
    const pane=page.getByRole('region',{name:'Sample server terminal'});
    const colorBefore=await pane.locator('.composer-review-terminal-dot').evaluate(node=>getComputedStyle(node).backgroundColor);
    await pane.getByRole('button',{name:'Disconnect',exact:true}).click();
    check(await pane.getByRole('img',{name:'Shell disconnected (preview)'}).isVisible(),'Disconnected dot is labeled');
    check(await pane.locator('.composer-review-terminal-dot').evaluate(node=>getComputedStyle(node).backgroundColor)!==colorBefore,'Disconnected state changes the dot color');
    await pane.getByRole('button',{name:'Terminal help',exact:true}).click();
    await page.getByRole('dialog',{name:'Terminal shortcuts'}).waitFor();await page.keyboard.press('Escape');
    check(await pane.isVisible(),'Closing help leaves terminal open');
    await pane.getByLabel('Terminal output preview (static sample)').focus();await page.keyboard.press('Escape');
    await pane.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.id==='composer-review-terminal-toggle');
    check(await page.getByRole('button',{name:'Terminal (sample session)'}).evaluate(node=>node===document.activeElement),'Collapsing restores launcher focus');
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);checks+=2;
    console.log(`PASS ${engine.name()}: identical bottom docks, status dots, help and Escape; no network or runtime errors`);
  }finally{await browser.close();}
}
console.log(`${checks} terminal dock assertions passed.`);
