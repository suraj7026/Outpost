import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { object, nativeId } from './subagent-privacy.js';

export interface TranscriptLink { path: string; runId: string; agent: string; index: number }
export interface TranscriptCursor { offset: number; identity?: string; lost?: boolean; seen?: boolean }
const inside = (root: string, file: string) => { const suffix = relative(root, file); return !!suffix && !suffix.startsWith('..') && !isAbsolute(suffix); };

/** Only the display transcript for an observed child, under this parent's session artifacts.
 * No canonical sessions (which may include forked parent history), discovery, or native imports.
 */
export function readChildTranscript(parentFile: string, link: TranscriptLink, cursor: TranscriptCursor) {
  const records: { offset: number; value: Record<string, unknown> }[] = [];
  let fd: number | undefined;
  try {
    if (!nativeId(link.runId) || !Number.isSafeInteger(link.index) || link.index < 0 || link.agent.length > 128) throw new Error('invalid_link');
    const root = join(dirname(parentFile), 'subagent-artifacts');
    const expected = `${link.runId}_${link.agent.replace(/[^\w.-]/g, '_')}_${link.index}_transcript.jsonl`;
    const name = basename(link.path), single = `${link.runId}_${link.agent.replace(/[^\w.-]/g, '_')}_transcript.jsonl`;
    if ((name !== expected && !(link.index === 0 && name === single)) || resolve(link.path) !== join(resolve(root), name)) throw new Error('untrusted_link');
    const original = lstatSync(link.path);
    if (lstatSync(root).isSymbolicLink() || original.isSymbolicLink()) throw new Error('symlink');
    const actualRoot = realpathSync(root), actual = realpathSync(link.path);
    if (!inside(actualRoot, actual) || !inside(realpathSync(dirname(parentFile)), actualRoot)) throw new Error('outside_root');
    fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd), identity = `${stat.dev}:${stat.ino}`;
    if (stat.dev !== original.dev || stat.ino !== original.ino || realpathSync(link.path) !== actual || realpathSync(root) !== actualRoot) throw new Error('changed_path');
    if (!stat.isFile() || stat.nlink !== 1 || (cursor.identity && cursor.identity !== identity) || stat.size < cursor.offset) throw new Error('changed_file');
    cursor.identity = identity;
    const maxBytes = 256 * 1024;
    const start = Math.max(cursor.offset, stat.size - maxBytes), truncated = start !== cursor.offset;
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - start));
    const length = readSync(fd, buffer, 0, buffer.length, start);
    let from = 0;
    if (truncated) { const newline = buffer.indexOf(10); from = newline < 0 ? length : newline + 1; }
    let malformed = false;
    for (let end = buffer.indexOf(10, from); end >= 0 && end < length; end = buffer.indexOf(10, from)) {
      const offset = start + from;
      const line = buffer.subarray(from, end).toString('utf8'); from = end + 1;
      try {
        const value = object(JSON.parse(line));
        if (value.version !== 1 || value.runId !== link.runId || value.agent !== link.agent || (value.childIndex ?? 0) !== link.index) { malformed = true; continue; }
        records.push({ offset, value });
        if (['message', 'tool_start', 'tool_end'].includes(String(value.recordType))) cursor.seen = true;
      } catch { malformed = true; }
    }
    cursor.offset = start + from;
    cursor.lost ||= malformed || truncated;
    return { records, truncated, unavailable: cursor.lost || !cursor.seen, pending: from < length };
  } catch {
    if (cursor.identity) cursor.lost = true;
    return { records, truncated: false, unavailable: true, pending: false };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Reads one launch-linked sidecar only. In contrast to native status RPC, this never reconciles. */
export function readObservedAsyncStatus(directory: string, runId: string, identities: readonly string[]) {
  let fd: number | undefined;
  try {
    const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
    const tempRoot = configured ? resolve(configured) : process.getuid ? join(tmpdir(), `pi-subagents-uid-${process.getuid()}`) : undefined;
    if (!tempRoot || !nativeId(runId) || directory !== join(tempRoot, 'async-subagent-runs', runId)) return undefined;
    const path = join(directory, 'status.json');
    const original = lstatSync(path);
    if (lstatSync(directory).isSymbolicLink() || original.isSymbolicLink()) return undefined;
    const root = realpathSync(tempRoot), actual = realpathSync(path);
    if (actual !== join(root, 'async-subagent-runs', runId, 'status.json')) return undefined;
    fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || stat.dev !== original.dev || stat.ino !== original.ino || realpathSync(path) !== actual) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const value = object(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
    return value.runId === runId && typeof value.sessionId === 'string' && identities.includes(value.sessionId) ? value : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
