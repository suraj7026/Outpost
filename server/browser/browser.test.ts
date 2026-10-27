import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Ledger } from '../core/ledger.js';
import { HeadlessBrowser } from './browser.js';
test('real headless fixture, exclusive takeover and fresh observation after return',async () => {
  const fixture = createServer((_,res) => res.end('<title>Fixture</title><button onclick="this.textContent=\'Done\'">Continue</button>'));
  await new Promise<void>(resolve => fixture.listen(0,'127.0.0.1',resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`, db = new Ledger(), browser = new HeadlessBrowser(db,new Set([url]));
  try {
    const opened = await browser.open('task',url); assert.equal(opened.title,'Fixture');
    const changed = await browser.click(opened.sessionId,'agent',opened.observation,'button'); assert.equal(changed.text,'Done');
    const lease = db.need('browser_lease',opened.sessionId); browser.leases.take(opened.sessionId,lease.revision,'mac');
    assert.throws(() => browser.leases.take(opened.sessionId,lease.revision+1,'phone'),/browser_busy/);
    await assert.rejects(browser.click(opened.sessionId,'agent',changed.observation,'button'),/invalid_browser_lease/);
    browser.leases.release(opened.sessionId,'mac');
    await assert.rejects(browser.click(opened.sessionId,'agent',changed.observation,'button'),/stale_observation/);
    assert.ok((await browser.capture(opened.sessionId,'agent')).length > 100);
  } finally { await browser.close(); db.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});
