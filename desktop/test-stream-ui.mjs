import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const preview = JSON.parse(readFileSync(process.argv[2] ?? '/tmp/outpost-recorded-preview.json','utf8'));
const task = preview.snapshot.records.find(record => record.kind === 'task' && record.data.profile === 'code');
assert.ok(task); task.data.state = 'running';
const root = resolve('desktop/dist'), types = { '.html': 'text/html','.js': 'text/javascript','.css': 'text/css','.woff2': 'font/woff2','.woff': 'font/woff' };
const server = createServer((req,res) => {
  const path = resolve(root,new URL(req.url,'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root+'/') || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type',types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch(); let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280,height: 900 },colorScheme: 'dark' });
  const errors = []; page.on('pageerror',error => errors.push(error.message));
  await page.addInitScript(({ preview }) => {
    const callbacks = new Map(); let sequence = 0, channel, index = 0;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { const id = ++sequence; callbacks.set(id,fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command,args) {
        if (command === 'connection_info') return { endpoint: 'Fixture transport',deviceId: 'fixture',publicKey: '',pending: false,nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'snapshot') return preview.snapshot;
          if (args.kind === 'runtime') return preview.runtime;
          if (args.kind === 'models') return preview.models;
          if (args.kind === 'events') return { events: [],hasMore: false,nextCursor: preview.snapshot.cursor };
        }
        if (command === 'stream_events') {
          channel = args.channel; index = 0;
          callbacks.get(channel.id)({ index: index++,message: { type: 'snapshot',...preview.snapshot,live: [] } });
          return new Promise(() => {});
        }
        if (command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        throw new Error('Mutations are disabled in this UI fixture');
      },
    };
    window.__emitLive = frame => callbacks.get(channel.id)({ index: index++,message: frame });
  },{ preview });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.sidebar-sessions button').filter({ hasText: 'Tauri desktop connection' }).first().click();
  await page.getByText(/Live stream/).waitFor(); checks++;
  const message = { id: 'live-fixture-message',kind: 'message',revision: 0,updatedAt: new Date().toISOString(),data: { taskId: task.id,author: 'assistant',text: '',thinking: 'Visible model fixture reasoning',streaming: true } };
  const emit = frame => page.evaluate(value => window.__emitLive(value),frame);
  await emit({ type: 'live',record: message });
  await page.getByText('Visible model fixture reasoning',{ exact: true }).waitFor(); checks++;
  assert.ok(await page.locator('.thinking-block').last().evaluate(node => node.open)); checks++;
  message.data.thinking += ' — next chunk'; await emit({ type: 'live',record: message });
  await page.getByText('Visible model fixture reasoning — next chunk',{ exact: true }).waitFor(); checks++;
  message.data.text = 'Streaming answer: first'; await emit({ type: 'live',record: message });
  await page.getByText('Streaming answer: first',{ exact: true }).waitFor(); checks++;
  message.data.text += ' second'; await emit({ type: 'live',record: message });
  await page.getByText('Streaming answer: first second',{ exact: true }).waitFor(); checks++;
  await page.waitForTimeout(100);
  assert.ok(await page.locator('.conversation').evaluate(node => node.scrollHeight-node.scrollTop-node.clientHeight < 100),'New output should remain in view when following the tail'); checks++;
  const tool = { id: 'live-fixture-tool',kind: 'tool_stream',revision: 0,updatedAt: new Date().toISOString(),data: { taskId: task.id,name: 'outpost_action',state: 'preparing',arguments: { tool: 'command.run',arguments: { argv: ['/bin/echo','fixture'] } },streaming: true } };
  await emit({ type: 'live',record: tool }); await page.locator('.live-tool').getByText('preparing',{ exact: true }).waitFor(); checks++;
  tool.data.state = 'running'; await emit({ type: 'live',record: tool }); await page.locator('.live-tool').getByText('running',{ exact: true }).waitFor(); checks++;
  await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
  await page.waitForTimeout(100);
  message.data.text += ' third'; await emit({ type: 'live',record: message });
  await page.waitForTimeout(100);
  assert.ok(await page.locator('.conversation').evaluate(node => node.scrollTop < 10),'Reading older messages must not be interrupted by new chunks'); checks++;
  await page.locator('.conversation').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(50);
  message.revision = 1; message.data.streaming = false;
  await emit({ type: 'settled',record: message });
  assert.equal(await page.getByText(message.data.text,{ exact: true }).count(),1); checks++;
  await page.locator('.thinking-block summary').last().click(); await page.getByText('Visible model fixture reasoning — next chunk',{ exact: true }).waitFor(); checks++;
  // A delayed partial frame must not replace an already finalized message.
  await emit({ type: 'live',record: { ...message,revision: 0,data: { ...message.data,streaming: true,text: 'stale fragment' } } });
  assert.equal(await page.getByText('stale fragment',{ exact: true }).count(),0); checks++;
  assert.equal(errors.length,0,errors.join('\n')); checks++;
  mkdirSync('/tmp/outpost-desktop-ui',{ recursive: true }); await page.screenshot({ path: '/tmp/outpost-desktop-ui/live-stream-fixture.png' });
  console.log(`${checks} live UI checks passed: incremental reasoning/text, tool lifecycle, finalization and stale-frame protection.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
