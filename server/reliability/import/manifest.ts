import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, opendirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { resolve, parse, join } from 'node:path';
import { jsonText, parseJson } from '../../storage/conversion.js';
import { check, limits } from './contracts.js';

export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const hashJson = (value: unknown) => sha(jsonText(value));
export const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const hashPattern = /^[a-f0-9]{64}$/;

/** Reject aliases through every component, not only the final filename. */
export function safePath(input: string, directory = false): string {
  const path = resolve(input), root = parse(path).root;
  let cursor = root;
  const parts = path.slice(root.length).split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    const stat = lstatSync(cursor, { bigint: true });
    check(!stat.isSymbolicLink(), 'source_symlink');
    if (i < parts.length - 1 || directory) check(stat.isDirectory(), 'source_directory');
    else check(stat.isFile() && stat.nlink === 1n, 'source_regular_file_required');
  }
  return path;
}
export function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
export function pathStamp(path: string): string { return stamp(lstatSync(path, { bigint: true })); }

/** Fixed-size reads, no-follow final open, and identity checks around every read pass. */
export function readStable(path: string, maximum: number, consume?: (chunk: Buffer) => void) {
  const clean = safePath(path), before = pathStamp(clean);
  const fd = openSync(clean, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    check(stat.isFile() && stat.nlink === 1n && stamp(stat) === before, 'source_changed');
    check(stat.size <= BigInt(maximum), 'source_capacity');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0, length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      size += length; check(size <= maximum, 'source_capacity');
      const chunk = buffer.subarray(0, length); hash.update(chunk); consume?.(chunk);
    }
    check(BigInt(size) === stat.size && stamp(fstatSync(fd, { bigint: true })) === before, 'source_changed');
    check(safePath(clean) === clean && pathStamp(clean) === before, 'source_changed');
    return { hash: hash.digest('hex'), size };
  } finally { closeSync(fd); }
}
export function copyStable(source: string, destination: string, maximum: number) {
  const fd = openSync(destination, 'wx', 0o600);
  try {
    return readStable(source, maximum, chunk => {
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    });
  } finally { closeSync(fd); }
}
export function filenameText(bytes: Buffer): string {
  const name = bytes.toString('utf8');
  check(Buffer.from(name, 'utf8').equals(bytes), 'invalid_filename_utf8');
  return name;
}
export function directoryNames(root: string): string[] {
  safePath(root, true);
  // latin1 is a reversible byte transport, not the filename's character encoding.
  // Decode only after recovering the original bytes; never open a replacement name.
  const directory = opendirSync(root, { encoding: 'latin1', bufferSize: 1 });
  const names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      check(names.length < limits.files, 'source_capacity');
      names.push(filenameText(Buffer.from(entry.name, 'latin1')));
    }
  } finally { directory.closeSync(); }
  return names.sort(byteOrder);
}

/** Reject duplicate object keys (JSON.parse alone silently discards them). */
export function strictJson(text: string): unknown {
  check(Buffer.byteLength(text) <= limits.archive, 'source_capacity');
  const value = parseJson(text);
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error('invalid_json');
  };
  const visit = (depth: number): void => {
    check(depth <= 100, 'json_depth'); space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      do {
        space(); const key = string(); check(!keys.has(key), 'duplicate_json_key'); keys.add(key);
        space(); i++; visit(depth + 1); space();
        if (text[i] === '}') { i++; return; }
        i++;
      } while (i < text.length);
    } else if (text[i] === '[') {
      i++; space(); if (text[i] === ']') { i++; return; }
      do { visit(depth + 1); space(); if (text[i] === ']') { i++; return; } i++; } while (i < text.length);
    } else if (text[i] === '"') string();
    else { while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++; }
  };
  visit(0); return value;
}
export class RowHash {
  private raw = createHash('sha256');
  private semantic = createHash('sha256');
  count = 0;
  add(raw: unknown, semantic: unknown = raw) {
    check(++this.count <= limits.rows, 'source_capacity');
    for (const [hash, row] of [[this.raw, raw], [this.semantic, semantic]] as const) {
      const text = jsonText(row); hash.update(`${Buffer.byteLength(text)}:`); hash.update(text);
    }
  }
  finish() { return { count: this.count, rawHash: this.raw.digest('hex'), canonicalHash: this.semantic.digest('hex') }; }
}
