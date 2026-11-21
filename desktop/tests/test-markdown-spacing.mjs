import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from '../chat-test-navigation.mjs';

// Offline fixture: no native IPC or live server access.
const markdown = `## Verified state

| Check | Result |
| --- | --- |
| brew --version | Homebrew 7.0.13 |
| brew doctor | Your system is ready to brew. |
| Prefix | /home/linuxbrew/.linuxbrew |

## Using it

New terminal sessions just work:

\`\`\`sh
brew install <formula>
\`\`\`

For non-interactive use, initialize the environment explicitly.

\`\`\`sh
/home/linuxbrew/.linuxbrew/bin/brew shellenv bash
\`\`\`

## Notes / open questions

- Existing workloads untouched. This longer item wraps on narrow screens without adding extra space between its lines.
- Analytics were suppressed during install.
  - Nested detail stays grouped with its parent.
  - Another nested detail.
- No formula installed yet.

### Follow-up checks

1. Review the environment.

   Keep this paragraph inside the first item.

2. Install a formula.

> A quoted paragraph.
>
> Another quoted paragraph.

---

Final paragraph.`;
const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-11-11T00:00:00Z', data });
const fixture = {
  snapshot: { protocolVersion: 1, cursor: 1, records: [
    row('task', 'markdown', { goal: 'Markdown spacing fixture', profile: 'code', state: 'paused' }),
    row('policy', 'markdown', { mode: 'ask_permission' }),
    row('message', 'owner', { taskId: 'markdown', author: 'owner', text: 'Please review the installation.\n\nInclude the next steps.' }),
    row('message', 'response', { taskId: 'markdown', author: 'assistant', text: markdown }),
  ] },
  runtime: { configured: true, model: 'fixture:cloud', hostAdministration: false },
  models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' },
};
const root = resolve('desktop/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const path = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) return response.writeHead(404).end();
  response.setHeader('content-type', types[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
let browser;
let checks = 0;
try {
  browser = await engine.launch();
  for (const width of [1512, 768, 390]) {
    for (const colorScheme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(value => { window.__OUTPOST_RECORDED_PREVIEW__ = value; }, fixture);
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await openInitialTestChat(page);
      await page.locator('.message.assistant table').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const measurements = await page.locator('.message.assistant').evaluate(message => {
        const body = message.querySelector('.message-markdown') ?? message;
        const blocks = [...body.children].filter(node => !node.matches('.message-byline, .thinking-block'));
        const gap = (before, after) => after.getBoundingClientRect().top - before.getBoundingClientRect().bottom;
        const list = body.querySelector('ul');
        const nested = list.querySelector('ul');
        const ordered = body.querySelector('ol');
        const quote = body.querySelector('blockquote');
        return {
          gaps: blocks.slice(1).map((node, index) => ({ before: blocks[index].tagName, after: node.tagName, gap: gap(blocks[index], node) })),
          listGap: gap(list.children[0], list.children[1]),
          nestedGap: gap(nested.children[0], nested.children[1]),
          looseParagraphGap: gap(ordered.children[0].children[0], ordered.children[0].children[1]),
          quoteGap: gap(quote.children[0], quote.children[1]),
          firstMargin: parseFloat(getComputedStyle(blocks[0]).marginTop),
          lastMargin: parseFloat(getComputedStyle(blocks.at(-1)).marginBottom),
          overflow: document.documentElement.scrollWidth > innerWidth || body.scrollWidth > body.clientWidth + 1,
        };
      });
      const check = (condition, label) => { assert.ok(condition, `${width}/${colorScheme}: ${label}; ${JSON.stringify(measurements)}`); checks++; };
      for (const item of measurements.gaps) {
        const minimum = /^H[1-6]$/.test(item.after) ? 24 : 12;
        check(item.gap >= minimum && item.gap <= 32, `${item.before} → ${item.after} has a deliberate block gap`);
      }
      check(measurements.listGap >= 8, 'list items have breathing room');
      check(measurements.nestedGap >= 4 && measurements.nestedGap <= 8, 'nested items stay compact');
      check(measurements.looseParagraphGap === 12 && measurements.quoteGap === 12, 'nested paragraphs have consistent spacing');
      check(measurements.firstMargin === 0 && measurements.lastMargin === 0, 'content edges have no extra margins');
      check(!measurements.overflow, 'Markdown stays within the conversation');
      const owner = await page.locator('.message.owner p').evaluateAll(nodes => ({ first: getComputedStyle(nodes[0]).marginTop, gap: nodes[1].getBoundingClientRect().top - nodes[0].getBoundingClientRect().bottom }));
      check(owner.first === '0px' && owner.gap === 16, 'owner messages use the same content rhythm');
      assert.deepEqual(errors, []);
      if (colorScheme === 'dark') {
        await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: resolve(root, `markdown-spacing-${width}-${engine.name()}.png`) });
      }
      await page.close();
    }
  }
  console.log(`PASS: ${checks} Markdown spacing checks (${engine.name()}) across desktop, tablet, mobile, dark and light.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
