import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserEngineFromEnvironment, camoufoxOptions } from './engine.js';

test('browser engine defaults to Chromium unless Camoufox Python is configured', () => {
  assert.equal(browserEngineFromEnvironment({}), 'chromium');
  assert.equal(browserEngineFromEnvironment({ OUTPOST_CAMOUFOX_PYTHON: '/configured/python' }), 'camoufox');
  assert.equal(browserEngineFromEnvironment({ OUTPOST_BROWSER_ENGINE: 'chromium', OUTPOST_CAMOUFOX_PYTHON: '/configured/python' }), 'chromium');
  assert.equal(browserEngineFromEnvironment({ OUTPOST_BROWSER_ENGINE: 'camoufox' }), 'camoufox');
  assert.throws(() => browserEngineFromEnvironment({ OUTPOST_BROWSER_ENGINE: 'unsupported' }));
});

test('Camoufox launch settings never inherit coordinator credentials or start a debug server', async () => {
  const old = process.env.OUTPOST_HOST_TOKEN;
  process.env.OUTPOST_HOST_TOKEN = 'synthetic-secret-not-for-browser';
  try {
    const options = await camoufoxOptions();
    assert.match(options.executablePath ?? '', /camoufox/i);
    assert.equal(options.headless, true);
    assert.ok(!JSON.stringify(options).includes('synthetic-secret-not-for-browser'));
    assert.ok(!options.args?.some(arg => /remote-debugging|listen|websocket/.test(arg)));
    assert.ok(Object.keys(options.env ?? {}).every(key =>
      ['PATH', 'HOME', 'LANG', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].includes(key)
      || key.startsWith('CAMOU_') || key.startsWith('FONTCONFIG_')));
  } finally {
    if (old === undefined) delete process.env.OUTPOST_HOST_TOKEN; else process.env.OUTPOST_HOST_TOKEN = old;
  }
});

test('cancelled launcher never falls back to an unowned browser', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(camoufoxOptions(undefined, abort.signal), { name: 'AbortError' });
});
