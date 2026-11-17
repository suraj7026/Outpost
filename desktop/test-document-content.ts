import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Node has no CSS loader; keep the production component's stylesheet import intact.
const stylesheet = new URL('./src/workspace/document-content.css', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    return url === stylesheet ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { default: DocumentContent } = await import('./src/workspace/DocumentContent');
type Props = ComponentProps<typeof DocumentContent>;
const render = (props: Partial<Props> = {}) => renderToStaticMarkup(createElement(DocumentContent, {
  path: 'notes.md', text: '', mode: 'preview', ...props,
}));
const count = (html: string, className: string) => (html.match(new RegExp(`class="${className}"`, 'g')) ?? []).length;

const assertNoActiveContent = (html: string) => {
  assert.doesNotMatch(html, /<(?:img|script|iframe|svg|object|embed|video|audio|link)\b/i);
  assert.doesNotMatch(html, /<[^>]*\s(?:href|src|srcset|onerror|onload)=/i);
};

test('Markdown supports headings, GFM tables, task lists, strikethrough and code', () => {
  const html = render({ path: 'NOTES.MARKDOWN', text: '# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n~~Old~~ and `code`\n\n```html\n<script>alert(1)</script>\n```' });
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /<del>Old<\/del>/);
  assert.match(html, /&lt;script&gt;/);
  assertNoActiveContent(html);
});

test('raw HTML and SVG never execute or create resource elements', () => {
  const html = render({ text: '<script>alert(1)</script>\n\n<img src="https://tracker.invalid/a" onerror="alert(1)">\n\n<svg onload="alert(1)"><image href="https://tracker.invalid/b" /></svg>\n\n<iframe src="https://tracker.invalid/c"></iframe>' });
  assertNoActiveContent(html);
});

test('all Markdown images are inert notices, including linked and reference images', () => {
  const html = render({ text: '![Remote](https://tracker.invalid/a.png)\n\n![Local](./image.png)\n\n![Data](data:image/svg+xml;base64,abc)\n\n[![Linked](https://tracker.invalid/b)](javascript:alert)\n\n![Reference][image]\n\n[image]: https://tracker.invalid/c', onOpenLink: () => assert.fail('render must not open a link') });
  for (const alt of ['Remote', 'Local', 'Data', 'Linked', 'Reference']) assert.match(html, new RegExp(`Image not loaded: ${alt}`));
  assertNoActiveContent(html);
  assert.doesNotMatch(html, /tracker\.invalid/);
});

for (const href of ['javascript:alert', 'JaVaScRiPt:alert', 'java&#x73;cript:alert', 'data:text/html,payload', 'file:///etc/passwd', 'vbscript:alert', '//example.com', '/local', './relative.md', '#fragment', 'https://', 'https://user:password@example.com', 'https://example.com%0a.evil']) {
  test(`unsafe or unsupported link stays inert: ${href}`, () => {
    const html = render({ text: `[Go](${href})`, onOpenLink: () => assert.fail('render must not open a link') });
    assert.doesNotMatch(html, /<button\b/);
    assertNoActiveContent(html);
  });
}

test('validated web links are callback controls, never native navigation targets', () => {
  const html = render({ text: '[Secure](https://example.com/path?q=1) and <http://example.org>', onOpenLink: () => assert.fail('render must not open a link') });
  assert.equal(count(html, 'workspace-document-link'), 2);
  assert.match(html, /type="button" role="link"/);
  assert.match(html, /title="https:\/\/example.com\/path\?q=1"/);
  assertNoActiveContent(html);
  assert.doesNotMatch(render({ text: '[Secure](https://example.com)' }), /<button\b/);
});

for (const path of ['page.html', 'drawing.svg', 'notes.txt', 'notes.md.txt']) {
  test(`non-Markdown preview is escaped plain text: ${path}`, () => {
    const html = render({ path, text: '# Not a heading\n<script>bad()</script>\n<svg onload="bad()" />' });
    assert.doesNotMatch(html, /<h1>/);
    assert.match(html, /&lt;script&gt;/);
    assertNoActiveContent(html);
  });
}

test('source uses bounded numbered lines and does not parse Markdown', () => {
  const html = render({ mode: 'source', text: '# Heading\n\n<script>bad()</script>\n' });
  assert.equal(count(html, 'workspace-document-line'), 3);
  assert.equal(count(html, 'workspace-document-line-number'), 3);
  assert.match(html, /aria-hidden="true">3<\/span>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<h1>/);
});

test('a million newline characters render at most 2,000 lines', () => {
  const html = render({ mode: 'source', text: '\n'.repeat(1024 * 1024) });
  assert.equal(count(html, 'workspace-document-line'), 2000);
  assert.match(html, /Display limit reached/);
  assert.match(html, /download action/);
});

test('a huge individual line is clipped and a large Markdown preview falls back', () => {
  const text = 'x'.repeat(1024 * 1024);
  for (const mode of ['source', 'preview'] as const) {
    const html = render({ mode, text });
    assert.equal(count(html, 'workspace-document-line'), 1);
    assert.match(html, /line display truncated/);
    assert.ok(html.length < 6000);
  }
  assert.match(render({ text }), /Markdown preview limit reached/);
});

test('syntax-dense Markdown falls back before parsing', () => {
  const html = render({ text: '['.repeat(2500) + 'x' + ']'.repeat(2500) });
  assert.match(html, /Markdown preview limit reached/);
});

test('wide GFM tables and deeply nested markup fall back before expansion', () => {
  const table = '| a '.repeat(40) + '|\n' + '| - '.repeat(40) + '|\n' + 'one cell\n'.repeat(100);
  assert.match(render({ text: table }), /Markdown preview limit reached/);
  assert.doesNotMatch(render({ text: table }), /<table>/);
  assert.match(render({ text: '> '.repeat(200) + 'nested' }), /Markdown preview limit reached/);
});

test('rendering also caps total displayed text across moderately long lines', () => {
  const html = render({ mode: 'source', text: ('x'.repeat(2000) + '\n').repeat(500) });
  assert.match(html, /Display limit reached/);
  assert.ok(count(html, 'workspace-document-line') < 100);
  assert.ok(html.length < 160000);
});

test('verified added files show addition lines only', () => {
  const text = 'first\nsecond\n';
  const html = render({ mode: 'changes', text, change: { kind: 'added', writtenText: text } });
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-added'), 2);
  assert.doesNotMatch(html, /workspace-document-diff-removed/);
  assert.match(html, /Current contents match the recorded write/);
});

test('large verified additions remain bounded with an explicit notice', () => {
  const text = 'x\n'.repeat(10000);
  const html = render({ mode: 'changes', text, change: { kind: 'added', writtenText: text } });
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-added'), 2000);
  assert.match(html, /Display limit reached/);
});

test('unrecorded previous versions never fabricate green additions', () => {
  for (const change of [undefined, { kind: 'modified' as const, writtenText: 'new' }]) {
    const html = render({ mode: 'changes', text: 'new', change });
    assert.match(html, /A previous version was not recorded/);
    assert.doesNotMatch(html, /workspace-document-diff-line/);
  }
});

test('stale and absent write evidence never produce a diff', () => {
  for (const kind of ['added', 'modified'] as const) {
    const html = render({ mode: 'changes', text: 'current', change: { kind, writtenText: 'stale', previousText: 'old' } });
    assert.match(html, /File has changed since recorded write/);
    assert.doesNotMatch(html, /workspace-document-diff-line/);
    const absent = render({ mode: 'changes', text: 'current', change: { kind, previousText: 'old' } });
    assert.match(absent, /written version was not recorded/);
    assert.doesNotMatch(absent, /workspace-document-diff-line/);
  }
});

test('known modified versions show a replacement with old and new numbering', () => {
  const text = 'same\nnew\nend\n';
  const html = render({ mode: 'changes', text, change: { kind: 'modified', writtenText: text, previousText: 'same\nold\nend\n' } });
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-added'), 1);
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-removed'), 1);
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-context'), 2);
  assert.match(html, /Old line 2/);
  assert.match(html, /New line 2/);
  assert.match(html, /not a minimal diff/);
});

test('empty previous text is known evidence; deletions and empty additions are honest', () => {
  const added = render({ mode: 'changes', text: 'new', change: { kind: 'modified', writtenText: 'new', previousText: '' } });
  assert.equal(count(added, 'workspace-document-diff-line workspace-document-diff-added'), 1);
  const removed = render({ mode: 'changes', text: '', change: { kind: 'modified', writtenText: '', previousText: 'old' } });
  assert.equal(count(removed, 'workspace-document-diff-line workspace-document-diff-removed'), 1);
  assert.doesNotMatch(removed, /workspace-document-diff-added/);
  const empty = render({ mode: 'changes', change: { kind: 'added', writtenText: '' } });
  assert.match(empty, /no added lines/);
  assert.doesNotMatch(empty, /workspace-document-diff-line/);
});

test('identical versions and final-newline-only changes are distinguished', () => {
  const identical = render({ mode: 'changes', text: 'x', change: { kind: 'modified', writtenText: 'x', previousText: 'x' } });
  assert.match(identical, /No changes between/);
  const newline = render({ mode: 'changes', text: 'x\n', change: { kind: 'modified', writtenText: 'x\n', previousText: 'x' } });
  assert.equal(count(newline, 'workspace-document-diff-line workspace-document-diff-added'), 1);
  assert.equal(count(newline, 'workspace-document-diff-line workspace-document-diff-removed'), 1);
  assert.match(newline, /No newline at end of file/);
  const crlf = render({ mode: 'changes', text: 'x\n', change: { kind: 'modified', writtenText: 'x\n', previousText: 'x\r\n' } });
  assert.match(crlf, /\[CRLF\]/);
});

test('common prefix and suffix are bounded context, not changes', () => {
  const prefix = 'before\n'.repeat(20);
  const suffix = 'after\n'.repeat(20);
  const text = prefix + 'new\n' + suffix;
  const html = render({ mode: 'changes', text, change: { kind: 'modified', writtenText: text, previousText: prefix + 'old\n' + suffix } });
  assert.match(html, /17 unchanged leading lines omitted/);
  assert.match(html, /17 unchanged trailing lines omitted/);
  assert.equal(count(html, 'workspace-document-diff-line workspace-document-diff-context'), 6);
});

for (const text of ['x'.repeat(1024 * 1024), 'x\n'.repeat(1001), 'x'.repeat(4097)]) {
  test(`oversized comparisons refuse partial/fabricated diffs (${text.length} characters)`, () => {
    const html = render({ mode: 'changes', text, change: { kind: 'modified', writtenText: text, previousText: 'old' } });
    assert.match(html, /Comparison display limit reached/);
    assert.doesNotMatch(html, /workspace-document-diff-line/);
  });
}
