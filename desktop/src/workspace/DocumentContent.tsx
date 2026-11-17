import { useMemo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './document-content.css';

export type DocumentViewMode = 'preview' | 'source' | 'changes';

type DocumentContentProps = {
  path: string;
  text: string;
  mode: DocumentViewMode;
  change?: { kind: 'added' | 'modified'; writtenText?: string; previousText?: string };
  onOpenLink?: (href: string) => void;
};

type Line = { text: string; ending: string; clipped: boolean };
type Display = { lines: Line[]; limited: boolean };
type DiffRow = { kind: 'context' | 'added' | 'removed'; line: Line; before?: number; after?: number };

const MAX_DISPLAY_CHARACTERS = 128 * 1024;
const MAX_DISPLAY_LINES = 2000;
const MAX_LINE_CHARACTERS = 4096;
const MAX_DIFF_CHARACTERS = 64 * 1024;
const MAX_DIFF_LINES = 1000;
const MAX_MARKDOWN_CHARACTERS = 32 * 1024;
const MAX_MARKDOWN_LINES = 400;
const MAX_MARKDOWN_MARKERS = 2000;
const CONTEXT_LINES = 3;

// Scan only a bounded prefix: even a file made entirely of newlines or one huge
// line must not allocate an array proportional to the complete file.
function displayLines(text: string, maxCharacters = MAX_DISPLAY_CHARACTERS, maxLines = MAX_DISPLAY_LINES): Display {
  const sample = text.slice(0, maxCharacters);
  const lines: Line[] = [];
  const matcher = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let consumed = 0;
  let limited = text.length > sample.length;
  while (lines.length < maxLines) {
    const match = matcher.exec(sample);
    if (!match || !match[0]) break;
    const clipped = match[1].length > MAX_LINE_CHARACTERS || (!match[2] && sample.length < text.length);
    lines.push({ text: match[1].slice(0, MAX_LINE_CHARACTERS), ending: match[2], clipped });
    consumed = matcher.lastIndex;
    limited ||= clipped;
  }
  return { lines, limited: limited || consumed < sample.length };
}

function safeLink(href: string | undefined): string | undefined {
  // Require an explicit web scheme. No relative URLs, protocol-relative URLs,
  // control characters, or browser-specific file/custom protocols reach callers.
  if (!href || !/^https?:\/\//i.test(href) || /[\s\u0000-\u001f\u007f\\]/u.test(href)) return undefined;
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function markdownWithinBudget(text: string, display: Display): boolean {
  if (text.length > MAX_MARKDOWN_CHARACTERS || display.limited || display.lines.length > MAX_MARKDOWN_LINES) return false;
  // Bound syntax density as well as bytes, avoiding enormous tables and deeply
  // nested inline/block constructs in otherwise small untrusted Markdown.
  let markers = 0;
  for (const line of display.lines) {
    let lineMarkers = 0;
    let pipes = 0;
    for (const character of line.text) {
      if (character === '|') pipes++;
      if ('[]*_`~>#|!-'.includes(character)) {
        if (++lineMarkers > 128 || ++markers > MAX_MARKDOWN_MARKERS) return false;
      }
    }
    // GFM pads short rows to the header width. Conservatively bound that
    // expansion before parsing, even when most rows contain no pipe characters.
    if (pipes > 0 && (pipes + 1) * display.lines.length > 2000) return false;
  }
  return true;
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="workspace-document-notice">{children}</p>;
}

function DisplayLimit() {
  return <Notice>Display limit reached. Showing up to 2,000 lines, 128K characters of text, and 4,096 characters per line. Use the document download action for the full text.</Notice>;
}

function LineText({ line, showEnding = false }: { line: Line; showEnding?: boolean }) {
  return <>
    {line.text || '\u200b'}
    {line.clipped && <span className="workspace-document-annotation"> … [line display truncated]</span>}
    {showEnding && !line.clipped && line.ending !== '\n' && <span className="workspace-document-annotation">
      {line.ending === '\r\n' ? ' [CRLF]' : line.ending === '\r' ? ' [CR]' : ' [No newline at end of file]'}
    </span>}
  </>;
}

function TextBody({ display, numbered }: { display: Display; numbered: boolean }) {
  return <>
    {display.limited && <DisplayLimit />}
    {!display.lines.length ? <Notice>This file is empty.</Notice> : <div className={`workspace-document-lines${numbered ? ' workspace-document-lines-numbered' : ''}`}>
      {display.lines.map((line, index) => <div className="workspace-document-line" key={index}>
        {numbered && <span className="workspace-document-line-number" aria-hidden="true">{index + 1}</span>}
        <code className="workspace-document-line-text"><LineText line={line} /></code>
      </div>)}
    </div>}
  </>;
}

function sameLine(left: Line, right: Line): boolean {
  return left.text === right.text && left.ending === right.ending;
}

function lineDiff(previous: Line[], current: Line[]) {
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && sameLine(previous[prefix], current[prefix])) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < current.length - prefix
    && sameLine(previous[previous.length - suffix - 1], current[current.length - suffix - 1])) suffix++;
  const rows: DiffRow[] = [];
  const start = Math.max(0, prefix - CONTEXT_LINES);
  for (let index = start; index < prefix; index++) {
    rows.push({ kind: 'context', line: previous[index], before: index + 1, after: index + 1 });
  }
  for (let index = prefix; index < previous.length - suffix; index++) {
    rows.push({ kind: 'removed', line: previous[index], before: index + 1 });
  }
  for (let index = prefix; index < current.length - suffix; index++) {
    rows.push({ kind: 'added', line: current[index], after: index + 1 });
  }
  const trailingContext = Math.min(suffix, CONTEXT_LINES);
  for (let index = 0; index < trailingContext; index++) {
    const before = previous.length - suffix + index;
    const after = current.length - suffix + index;
    rows.push({ kind: 'context', line: current[after], before: before + 1, after: after + 1 });
  }
  return { rows, omittedBefore: start, omittedAfter: suffix - trailingContext };
}

function DiffBody({ rows }: { rows: DiffRow[] }) {
  return <div className="workspace-document-diff" aria-label="Line changes; old and new line numbers">
    {rows.map((row, index) => <div className={`workspace-document-diff-line workspace-document-diff-${row.kind}`} key={index}>
      <span className="workspace-document-line-number" aria-label={row.before ? `Old line ${row.before}` : undefined}>{row.before ?? ''}</span>
      <span className="workspace-document-line-number" aria-label={row.after ? `New line ${row.after}` : undefined}>{row.after ?? ''}</span>
      <span className="workspace-document-diff-sign" aria-label={row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Unchanged'}>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
      <code className="workspace-document-line-text"><LineText line={row.line} showEnding={row.kind !== 'context'} /></code>
    </div>)}
  </div>;
}

function Changes({ text, change, display }: Pick<DocumentContentProps, 'text' | 'change'> & { display: Display }) {
  if (change?.writtenText !== undefined && change.writtenText !== text) {
    return <Notice>File has changed since recorded write. No recorded diff is shown for the current contents.</Notice>;
  }
  if (!change || (change.kind === 'modified' && change.previousText === undefined)) {
    return <Notice>A previous version was not recorded. No comparison is available.</Notice>;
  }
  if (change.writtenText === undefined) {
    return <Notice>The written version was not recorded. Changes cannot be verified against the current file.</Notice>;
  }
  if (change.kind === 'added') {
    return <>
      <Notice>Added file · Current contents match the recorded write.</Notice>
      {display.limited && <DisplayLimit />}
      {display.lines.length
        ? <DiffBody rows={display.lines.map((line, index) => ({ kind: 'added', line, after: index + 1 }))} />
        : <Notice>The recorded addition is an empty file; there are no added lines.</Notice>}
    </>;
  }
  const previousText = change.previousText!;
  if (previousText === text) return <Notice>No changes between the recorded previous version and the current file.</Notice>;
  if (previousText.length > MAX_DIFF_CHARACTERS || text.length > MAX_DIFF_CHARACTERS) {
    return <Notice>Comparison display limit reached (64K characters per version). Use Source or download the full text to inspect this file.</Notice>;
  }
  const previous = displayLines(previousText, MAX_DIFF_CHARACTERS, MAX_DIFF_LINES);
  const current = displayLines(text, MAX_DIFF_CHARACTERS, MAX_DIFF_LINES);
  if (previous.limited || current.limited) {
    return <Notice>Comparison display limit reached (1,000 lines per version or 4,096 characters per line). Use Source or download the full text to inspect this file.</Notice>;
  }
  const diff = lineDiff(previous.lines, current.lines);
  return <>
    <Notice>Recorded changes · Removed (−) and added (+) lines. Common leading and trailing lines are matched; the middle is shown as a replacement, not a minimal diff.</Notice>
    {diff.omittedBefore > 0 && <Notice>{diff.omittedBefore} unchanged leading lines omitted.</Notice>}
    <DiffBody rows={diff.rows} />
    {diff.omittedAfter > 0 && <Notice>{diff.omittedAfter} unchanged trailing lines omitted.</Notice>}
  </>;
}

export default function DocumentContent({ path, text, mode, change, onOpenLink }: DocumentContentProps) {
  const display = useMemo(() => displayLines(text), [text]);
  const markdown = /\.(md|markdown)$/i.test(path);
  const renderMarkdown = useMemo(() => markdown && markdownWithinBudget(text, display), [markdown, text, display]);
  const components = useMemo<Components>(() => ({
    img: ({ alt }) => <span className="workspace-document-image-notice">[Image not loaded{alt ? `: ${alt}` : ''}]</span>,
    a: ({ href, children }) => {
      const safeHref = safeLink(href);
      return safeHref && onOpenLink
        ? <button type="button" role="link" className="workspace-document-link" title={safeHref} onClick={() => onOpenLink(safeHref)}>{children}</button>
        : <span className="workspace-document-inactive-link" title={safeHref ? 'Link opening is unavailable' : 'Only HTTP and HTTPS links can be opened'}>{children}</span>;
    },
  }), [onOpenLink]);

  return <section className={`workspace-document workspace-document-${mode}`} aria-label={`${mode === 'changes' ? 'Changes' : mode === 'source' ? 'Source' : 'Preview'}: ${path}`} tabIndex={0}>
    {mode === 'changes' ? <Changes text={text} change={change} display={display} />
      : mode === 'preview' && renderMarkdown ? <article className="workspace-document-markdown">
        {text ? <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}
          urlTransform={(url, key, node) => key === 'href' && node.tagName === 'a' ? safeLink(url) ?? '' : ''}>{text}</Markdown>
          : <Notice>This file is empty.</Notice>}
      </article>
        : <>
          {mode === 'preview' && markdown && <Notice>Markdown preview limit reached. Showing bounded plain text instead of parsing a large or complex document.</Notice>}
          <TextBody display={display} numbered={mode === 'source'} />
        </>}
  </section>;
}
