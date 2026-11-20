import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const entry = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import OutpostMenu from './src/environment/OutpostMenu';
  import ModelPicker from './src/agent/ModelPicker';
  import { ComposerModelSelect, ControlMode } from './src/ComposerControls';
  import './src/styles.css';
  import './src/studio.css';
  import './src/composer.css';
  import './src/composer-refinement.css';
  import './src/focus.css';
  import './src/neutral-theme.css';

  function Harness() {
    const [owner, setOwner] = useState('one');
    const [model, setModel] = useState({ providerId: 'fixture', modelId: 'first' });
    const [legacy, setLegacy] = useState('first:cloud');
    const [mode, setMode] = useState('full_control');
    const [autoSupported, setAutoSupported] = useState(true);
    const [submits, setSubmits] = useState(0);
    window.setAutoSupported = setAutoSupported;
    return <div className="app-shell">
      {/* App's focusable main panel is essential: WebKit focuses it on an unhandled button mousedown. */}
      <main className="main-shell" tabIndex={-1}>
        <div style={{ margin: '180px auto', width: 660 }}>
          <button type="button" style={{ position: 'fixed', top: 30, left: 30 }}>Outside menu</button>
          <div className="composer-stack">
            <div className="composer-context" data-tauri-drag-region>
              <OutpostMenu owners={[
                { environmentId: 'one', label: 'Outpost 1', connected: true },
                { environmentId: 'two', label: 'Outpost 2', connected: true },
              ]} selectedId={owner} onSelect={setOwner} />
            </div>
            <form className="composer" onSubmit={event => { event.preventDefault(); setSubmits(count => count + 1); }}>
              <textarea aria-label="Task goal" />
              <div className="composer-toolbar">
                <ControlMode label="Control mode" value={mode} runtime={autoSupported ? { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 } : {}} onModeChange={setMode} />
                <ModelPicker catalogue={{ models: [
                  { providerId: 'fixture', modelId: 'first', name: 'First managed model' },
                  { providerId: 'fixture', modelId: 'second', name: 'Second managed model' },
                ] }} value={model} onChange={setModel} />
                <ComposerModelSelect aria-label="Ollama model" value={legacy} onChange={event => setLegacy(event.target.value)}>
                  <option value="first:cloud">First cloud model</option>
                  <option disabled value="disabled:cloud">Unavailable cloud model</option>
                  <option value="second:cloud">Second cloud model</option>
                </ComposerModelSelect>
              </div>
            </form>
          </div>
          <output aria-label="Selections">{JSON.stringify({ owner, model, legacy, mode, submits })}</output>
        </div>
      </main>
    </div>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: import.meta.dirname, sourcefile: 'anchor-menu-fixture.tsx', loader: 'tsx' },
  bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
  plugins: [{ name: 'skip-font-assets', setup(build) {
    build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' }));
  } }],
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;

for (const engine of [chromium, webkit]) test(`dropdown interaction in App's focusable panel (${engine.name()})`, { timeout: 30000 }, async () => {
  // Real shared menu and every composer picker; synthetic state, no native IPC or server requests.
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    const state = async () => JSON.parse(await page.getByRole('status', { name: 'Selections' }).innerText());
    const menu = (name: string) => page.getByRole('dialog', { name, exact: true });

    await page.getByRole('button', { name: 'Outpost 1', exact: true }).click();
    await menu('Choose Outpost').getByRole('option', { name: /Outpost 2/ }).locator('strong').click();
    assert.equal((await state()).owner, 'two', 'Clicking the row label selects the Outpost before dismissing');
    assert.equal(await menu('Choose Outpost').count(), 0);

    const managed = page.locator('.model-picker-trigger:not(.composer-legacy-model)');
    await managed.click();
    const search = menu('Model').getByRole('searchbox');
    const output = '/tmp/outpost-dropdown-polish';
    mkdirSync(output, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await search.evaluate(node => node.blur());
      const resting = await menu('Model').locator('.anchor-menu-search').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).border }));
      await search.focus();
      const focused = await search.evaluate(node => {
        const input = getComputedStyle(node), field = getComputedStyle(node.parentElement!);
        return { background: input.backgroundColor, outline: input.outlineStyle, shadow: input.boxShadow,
          fieldBackground: field.backgroundColor, fieldOutline: field.outlineStyle, fieldBorder: field.border };
      });
      assert.equal(focused.background, 'rgba(0, 0, 0, 0)', 'Search input stays transparent inside its composite field');
      assert.equal(focused.outline, 'none');
      assert.equal(focused.shadow, 'none');
      assert.equal(focused.fieldOutline, 'none', 'Search has no second perimeter ring');
      assert.equal(focused.fieldBorder, resting.border, 'Focus preserves the normal field border');
      assert.notEqual(focused.fieldBackground, resting.background, 'Focus uses one fill across the whole search field');
      await menu('Model').screenshot({ path: `${output}/${engine.name()}-${theme}-search.png` });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await menu('Model').getByRole('searchbox').fill('Second');
    await menu('Model').getByRole('option', { name: /Second managed model/ }).click();
    assert.deepEqual((await state()).model, { providerId: 'fixture', modelId: 'second' });
    assert.equal(await menu('Model').count(), 0);

    const legacy = page.getByRole('button', { name: 'Ollama model', exact: true });
    await legacy.click();
    assert.equal(await menu('Model').getByRole('option', { name: 'Unavailable cloud model', exact: true }).isDisabled(), true);
    await menu('Model').getByRole('option', { name: 'Second cloud model', exact: true }).click({ position: { x: 8, y: 8 } });
    assert.equal((await state()).legacy, 'second:cloud', 'Legacy picker change reaches its React onChange');

    const control = page.getByRole('button', { name: 'Control mode', exact: true });
    await control.click();
    await menu('Control mode').getByRole('option', { name: /^Auto/ }).click();
    assert.equal((await state()).mode, 'auto');

    await page.getByRole('button', { name: 'Outpost 2', exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    assert.equal((await state()).owner, 'one', 'Keyboard activation still selects an Outpost');

    await legacy.click();
    await menu('Model').getByRole('searchbox').fill('cloud');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu('Model').getByRole('option', { name: 'Second cloud model', exact: true }).evaluate(node => node === document.activeElement), true, 'Arrow navigation skips disabled rows');
    await page.keyboard.press('Escape');
    assert.equal(await menu('Model').count(), 0);
    assert.equal(await legacy.evaluate(node => node === document.activeElement), true, 'Escape restores trigger focus');

    await managed.click();
    await menu('Model').getByRole('searchbox').fill('no matching model');
    assert.equal(await menu('Model').getByText('No matches.', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Outside menu', exact: true }).click();
    assert.equal(await menu('Model').count(), 0, 'Outside clicks still dismiss');

    await legacy.click();
    await menu('Model').waitFor();
    await page.getByRole('textbox', { name: 'Task goal', exact: true }).focus();
    assert.equal(await menu('Model').count(), 0, 'Focus leaving the menu still dismisses');

    await control.click();
    await menu('Control mode').getByRole('option', { name: /^Full control/ }).click();
    await page.evaluate('window.setAutoSupported(false)');
    await control.click();
    const unavailableAuto = menu('Control mode').getByRole('option', { name: /^Auto/ });
    assert.equal(await unavailableAuto.isDisabled(), true, 'Unsupported Auto remains unavailable');
    assert.match(await unavailableAuto.innerText(), /Requires a compatible server update/);
    await unavailableAuto.hover();
    assert.equal(await unavailableAuto.evaluate(node => getComputedStyle(node).cursor), 'default', 'Unavailable Auto uses a normal cursor with a visible reason');
    assert.equal((await state()).mode, 'full_control');
    await menu('Control mode').screenshot({ path: `${output}/${engine.name()}-auto-unavailable.png` });
    assert.equal((await state()).submits, 0, 'Picker interactions never submit the composer');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
