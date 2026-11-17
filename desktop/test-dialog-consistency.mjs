import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolated React harness: all mutations are in memory; no app IPC or remote requests.
const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/studio.css';
import './src/settings-refinement.css';
import './src/provider-runtime-parity.css';
import './src/browser-viewer.css';
import './src/image-viewer/image-viewer.css';
import './src/server-setup.css';
import Automations from './src/Automations';
import SharedMemory, { ServerNotes } from './src/SharedMemory';
import ModelPicker from './src/agent/ModelPicker';
import { Button, Dialog } from './src/Interface';
import './src/focus.css';
import './src/dialog-consistency.css';
window.isTauri = true;
const calls = [];
const models = [{ providerId: 'fixture', modelId: 'one', name: 'First model' }, { providerId: 'fixture', modelId: 'two', name: 'Second model' }];
const row = (kind, id, data) => ({ kind, id, data, revision: 1, updatedAt: new Date().toISOString() });
async function write(kind, id, payload) {
  calls.push({ kind, id, payload });
  if (window.fixture.hold) await new Promise(resolve => { window.fixture.release = resolve; });
  return row(kind === 'automation.save' ? 'automation' : 'memory', id, kind === 'memory.save' ? { ...payload, confirmed: true, forgotten: false } : payload);
}
function Wide({ kind }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className={kind}><h2>Specialized dialog</h2><button onClick={() => ref.current.close()}>Close wide</button></dialog>;
}
function Harness() {
  const [view, setView] = useState('schedule'), [blocked, setBlocked] = useState(false), [open, setOpen] = useState(false), [model, setModel] = useState(null);
  const connection = { records: [], connected: true, retired: false, busy: false, info: { pending: blocked }, runtime: { configured: true, piManagement: true, sharedMemory: true }, models: [], agentCatalogue: { models }, command: (kind, id, revision, payload) => write(kind, id, payload) };
  const groups = [{ id: 'a', label: 'Studio', connected: true, lastSync: new Date(), tasks: [] }];
  const memory = { enabled: true, ready: !blocked, replicas: [{ id: 'a', label: 'Studio', connection }], notes: [], failed: false, retry() {}, save: async (id, text) => { await write('memory.shared', id, { text }); return true; } };
  window.fixture = { ...window.fixture, calls, setView, setBlocked, model };
  return <main className="workspace-refinement">
    {view === 'schedule' ? <Automations groups={groups} connections={{ a: connection }} /> :
     view === 'shared' ? <SharedMemory memory={memory} /> :
     view === 'server' ? <ServerNotes server="a" groups={groups} connections={{ a: connection }} /> :
     view === 'model' ? <ModelPicker catalogue={{ models }} value={model} onChange={setModel} /> :
     view === 'legacy' || view === 'footer' ? <><Button onClick={() => setOpen(true)}>Open contract</Button>{open && <Dialog title="Contract dialog" onClose={() => setOpen(false)} bodyClassName="contract-body" footer={view === 'footer' ? <Button type="submit" form="contract-form">Submit contract</Button> : undefined}>
       <form id="contract-form" className="ui-form" onSubmit={event => { event.preventDefault(); calls.push({ kind: 'contract' }); setOpen(false); }}><label>Required name<input required /></label><label>Choice<select><option>One</option></select></label>{view === 'legacy' && <div className="ui-dialog-actions"><Button type="submit">Submit contract</Button></div>}</form>
     </Dialog>}</> : <Wide key={view} kind={view} />}
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'dialog-consistency.tsx', loader: 'tsx' }, bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
  plugins: [{ name: 'skip-font-assets', setup(builder) { builder.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
const script = result.outputFiles.find(file => file.path.endsWith('.js')).contents;
const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).contents;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
  else if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(stylesheet); }
  else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(10000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  const button = name => page.getByRole('button', { name, exact: true });
  const dialog = page.getByRole('dialog');
  const change = async (method, value) => page.evaluate(async ([method, value]) => { window.fixture[method](value); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, [method, value]);
  const calls = () => page.evaluate(() => window.fixture.calls);
  const checkFocus = async locator => assert.equal(await locator.evaluate(element => element === document.activeElement), true, 'focus returns to trigger');
  const geometry = async () => dialog.evaluate(element => {
    const header = element.querySelector('header'), close = header.querySelector('button'), footer = element.querySelector('footer'), body = element.querySelector('.ui-dialog-body, .dialog-form-body');
    const rect = element.getBoundingClientRect(), h = header.getBoundingClientRect(), c = close.getBoundingClientRect(), f = footer?.getBoundingClientRect();
    return { width: rect.width, height: rect.height, radius: getComputedStyle(element).borderRadius, heading: getComputedStyle(header.querySelector('h2')).fontSize,
      headerHeight: h.height, closeWidth: c.width, closeHeight: c.height, centered: Math.abs(c.y + c.height / 2 - h.y - h.height / 2) < 1,
      padding: body && getComputedStyle(body).paddingLeft, footerPadding: footer && getComputedStyle(footer).padding, footerGap: footer && getComputedStyle(footer).gap,
      footerY: f?.y, headerY: h.y, overflow: element.scrollWidth > element.clientWidth,
      actions: footer && [...footer.querySelectorAll('button')].map(button => ({ height: button.getBoundingClientRect().height, radius: getComputedStyle(button).borderRadius })),
      scrolling: body && body.scrollHeight > body.clientHeight };
  });
  const checkGeometry = async () => {
    const g = await geometry();
    assert.equal(g.width, 600); assert.equal(g.radius, '16px'); assert.equal(g.heading, '18px');
    assert.equal(g.closeWidth, 36); assert.equal(g.closeHeight, 36); assert.equal(g.centered, true);
    assert.equal(g.padding, '24px'); assert.equal(g.footerGap, '8px'); assert.equal(g.overflow, false);
    for (const action of g.actions) { assert.equal(action.height, 36); assert.equal(action.radius, '8px'); }
    return g;
  };
  await button('New schedule').click();
  const schedule = await checkGeometry();
  assert.equal(await dialog.getByLabel('Schedule name').evaluate(element => element === document.activeElement), true);
  assert.equal(schedule.scrolling, true, 'long schedule scrolls inside its body');
  await dialog.locator('.dialog-form-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scrolled = await geometry();
  assert.equal(scrolled.headerY, schedule.headerY); assert.equal(scrolled.footerY, schedule.footerY);
  assert.equal(await dialog.getByRole('combobox', { name: /^Model/ }).evaluate(element => getComputedStyle(element).maxWidth), 'none');
  await dialog.getByLabel('Schedule name').fill('Fixture schedule');
  await dialog.getByLabel('What should it do?').fill('Inspect in memory');
  await dialog.getByLabel(/First start/).fill('2035-01-01T10:00');
  await page.evaluate(() => { window.fixture.hold = true; });
  await button('Create schedule').click();
  await button('Saving…').waitFor();
  assert.equal(await button('Close dialog').isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
  await page.evaluate(() => { window.fixture.hold = false; window.fixture.release(); });
  await dialog.waitFor({ state: 'hidden' });
  await checkFocus(button('New schedule'));
  assert.equal((await calls()).length, 1);

  const noteGeometry = [];
  for (const [view, trigger, save] of [['shared', 'New shared note', 'Save shared note'], ['server', 'New server note', 'Save server note']]) {
    await change('setView', view);
    const count = (await calls()).length;
    await button(trigger).click();
    noteGeometry.push(await checkGeometry());
    if (view === 'shared') assert.equal(await dialog.getByLabel('Note', { exact: true }).evaluate(element => element === document.activeElement), true);
    assert.equal((await calls()).length, count, 'opening does not write');
    await dialog.getByLabel('Note', { exact: true }).fill('Retain this draft');
    if (view === 'server') await dialog.getByLabel('Project', { exact: true }).fill('fixture-project');
    await button('Close dialog').click();
    await dialog.waitFor({ state: 'hidden' }); await checkFocus(button(trigger));
    await button(trigger).click();
    assert.equal(await dialog.getByRole('textbox', { name: /^Note/ }).inputValue(), 'Retain this draft');
    await change('setBlocked', true);
    assert.equal(await button(save).isDisabled(), true);
    assert.equal((await calls()).length, count, 'blocked state does not write');
    await change('setBlocked', false);
    await page.evaluate(() => { window.fixture.hold = true; });
    await button(save).click(); await button('Saving…').waitFor();
    assert.equal(await button('Close dialog').isDisabled(), true); assert.equal(await button('Cancel').isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
    await page.evaluate(() => { window.fixture.hold = false; window.fixture.release(); });
    await dialog.waitFor({ state: 'hidden' }); await checkFocus(button(trigger));
    assert.equal((await calls()).length, count + 1, 'exactly one mutation per save');
  }
  for (const key of ['headerHeight', 'closeWidth', 'closeHeight', 'padding', 'footerPadding', 'footerGap']) assert.deepEqual(noteGeometry[0][key], noteGeometry[1][key], `note dialogs share ${key}`);
  assert.deepEqual((await calls()).find(call => call.kind === 'memory.save').payload, { text: 'Retain this draft', project: 'fixture-project', identityId: 'owner', source: 'Outpost desktop · server note', provenance: 'owner' });

  await change('setView', 'model');
  const modelTrigger = page.locator('.model-picker-trigger');
  await modelTrigger.click();
  assert.equal(await button('Done').count(), 0);
  assert.equal(await dialog.getByLabel('Search models').evaluate(element => element === document.activeElement), true);
  await button('Close model picker').click(); await checkFocus(modelTrigger);
  assert.equal(await page.evaluate(() => window.fixture.model), null);
  await modelTrigger.click();
  await dialog.getByLabel('Search models').fill('Second');
  await dialog.getByRole('button', { name: /Second model/ }).click();
  await dialog.waitFor({ state: 'hidden' }); await checkFocus(modelTrigger);
  assert.deepEqual(await page.evaluate(() => window.fixture.model), { providerId: 'fixture', modelId: 'two' });
  await modelTrigger.click(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await checkFocus(modelTrigger);

  for (const view of ['legacy', 'footer']) {
    await change('setView', view); await button('Open contract').click();
    assert.equal(await dialog.locator('.ui-dialog-body.contract-body').count(), 1);
    assert.equal(await dialog.locator(':scope > footer').count(), view === 'footer' ? 1 : 0);
    await dialog.getByLabel('Required name').fill('Contract');
    await button('Submit contract').click(); await dialog.waitFor({ state: 'hidden' }); await checkFocus(button('Open contract'));
  }

  for (const view of ['schedule', 'shared', 'server']) {
    await page.setViewportSize({ width: 390, height: 620 });
    await change('setView', view);
    await button(view === 'schedule' ? 'New schedule' : view === 'shared' ? 'New shared note' : 'New server note').click();
    const g = await geometry();
    assert.ok(g.width <= 390 - 24); assert.ok(g.height <= 620 - 32); assert.equal(g.overflow, false);
    assert.equal(g.padding, '20px'); assert.equal(g.closeWidth, 36);
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'modal contains keyboard focus');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const kind of ['browser-viewer-dialog', 'image-viewer', 'server-setup-dialog']) {
    await change('setView', kind);
    assert.ok((await dialog.boundingBox()).width > 600, `${kind} retains specialized width`);
    await button('Close wide').click();
  }
  await change('setView', 'shared'); await button('New shared note').click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.style.setProperty('--dialog-surface', 'rgb(250, 250, 250)'); });
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(250, 250, 250)');
  assert.equal(await dialog.locator('header').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(250, 250, 250)');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).boxShadow), 'none');
  await button('Close dialog').focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await button('Close dialog').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
  assert.deepEqual(errors, []);
  console.log('Dialog consistency: geometry, scrolling, focus, busy guards, forms, selection, media sizing and accessibility modes passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
