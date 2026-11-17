import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Fault } from '../core/contracts.js';

export const WORKSPACE_REVIEW_LIMITS = { entries: 1000, depth: 8, bytes: 1_048_576 } as const;

function validPath(path: string) {
  return path.isWellFormed() && !/[\\:%\x00-\x1f\x7f]/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}
const WorkspacePath = z.string().min(1).max(1000).refine(validPath);
export const WorkspaceFilesInput = z.strictObject({ taskId: z.uuid() });
export const WorkspaceReadInput = WorkspaceFilesInput.extend({ path: WorkspacePath });

type FileInfo = { path: string; name: string; size: number; modifiedAt: string };
type Directory = { path: string; info: BigIntStats };

function check(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new Fault(code, code, status);
}
function sameInode(one: BigIntStats, two: BigIntStats) { return one.dev === two.dev && one.ino === two.ino; }
function sameFile(one: BigIntStats, two: BigIntStats) {
  return two.isFile() && two.nlink === 1n && sameInode(one, two) && one.size === two.size &&
    one.mtimeNs === two.mtimeNs && one.ctimeNs === two.ctimeNs;
}
function metadata(path: string, info: BigIntStats): FileInfo {
  check(info.size <= BigInt(Number.MAX_SAFE_INTEGER), 'workspace_unsafe_file');
  return { path, name: basename(path), size: Number(info.size), modifiedAt: new Date(Number(info.mtimeMs)).toISOString() };
}
async function directory(path: string): Promise<Directory> {
  const info = await lstat(path, { bigint: true });
  check(info.isDirectory(), 'workspace_unsafe_directory');
  return { path, info };
}
async function unchanged(chain: Directory[]) {
  for (const parent of chain) {
    const now = await lstat(parent.path, { bigint: true });
    check(now.isDirectory() && sameInode(parent.info, now) && now.ctimeNs === parent.info.ctimeNs &&
      now.mtimeNs === parent.info.mtimeNs, 'workspace_changed');
  }
}
async function missingDirectory(path: string) {
  try { return await directory(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function redacted<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault('workspace_unavailable', 'workspace_unavailable', 404);
  }
}

/** Read-only counterpart to Workspace: no mkdir, chmod, gate or execution side effects.
 * Like the approved-skill reader, uses no-follow opens and inode/chain rechecks. Node
 * has no portable openat: the configured parent must remain administrator-controlled;
 * this is not an OS sandbox against an adversary concurrently renaming directories.
 */
export class WorkspaceReview {
  constructor(private readonly root: string) {}

  private async existingRoot() {
    const requested = resolve(this.root);
    const parent = await missingDirectory(dirname(requested));
    if (!parent) return undefined;
    // Canonicalize trusted ancestors (e.g. macOS /var), never the task root or its children.
    const canonical = await realpath(parent.path);
    const base = await directory(canonical);
    check(sameInode(parent.info, base.info), 'workspace_changed');
    const task = await missingDirectory(join(canonical, basename(requested)));
    await unchanged([parent, base]);
    if (!task) return undefined;
    return { path: task.path, chain: [parent, base, task] };
  }

  async files(): Promise<{ files: FileInfo[]; truncated: boolean }> {
    return redacted(async () => {
      const root = await this.existingRoot();
      if (!root) return { files: [], truncated: false };
      const files: FileInfo[] = [], checked = [...root.chain];
      let entries = 0, truncated = false;
      const walk = async (path: string, prefix: string, depth: number, chain: Directory[]): Promise<void> => {
        await unchanged(chain);
        check(await realpath(path) === path, 'workspace_changed');
        const dir = await opendir(path, { bufferSize: 32 });
        // Streaming iteration bounds memory even when a directory contains millions of entries.
        for await (const entry of dir) {
          if (entries === WORKSPACE_REVIEW_LIMITS.entries) { truncated = true; break; }
          entries++;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (!WorkspacePath.safeParse(relative).success || entry.isSymbolicLink()) continue;
          const child = join(path, entry.name), info = await lstat(child, { bigint: true });
          if (info.isDirectory()) {
            if (depth === WORKSPACE_REVIEW_LIMITS.depth) { truncated = true; continue; }
            const next = { path: child, info }; checked.push(next);
            await walk(child, relative, depth + 1, [...chain, next]);
          } else if (info.isFile() && info.nlink === 1n) {
            files.push(metadata(relative, info));
          }
        }
        await unchanged(chain);
      };
      await walk(root.path, '', 0, root.chain);
      await unchanged(checked);
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return { files, truncated };
    });
  }

  async read(path: string): Promise<FileInfo & { text: string; hash: string }> {
    WorkspacePath.parse(path);
    return redacted(async () => {
      const root = await this.existingRoot();
      check(root, 'workspace_unavailable', 404);
      const chain = [...root.chain];
      let parent = root.path;
      for (const part of path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        chain.push(await directory(parent));
      }
      const file = join(root.path, path);
      const before = await lstat(file, { bigint: true });
      check(before.isFile() && before.nlink === 1n, 'workspace_unsafe_file');
      check(before.size <= BigInt(WORKSPACE_REVIEW_LIMITS.bytes), 'workspace_file_too_large', 413);
      await unchanged(chain);
      check(await realpath(file) === file, 'workspace_changed');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const initial = await handle.stat({ bigint: true });
        check(initial.isFile() && initial.nlink === 1n && sameInode(before, initial), 'workspace_changed');
        check(initial.size <= BigInt(WORKSPACE_REVIEW_LIMITS.bytes), 'workspace_file_too_large', 413);
        check(sameFile(before, initial), 'workspace_changed');
        await unchanged(chain);
        const bytes = Buffer.alloc(WORKSPACE_REVIEW_LIMITS.bytes + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        check(size <= WORKSPACE_REVIEW_LIMITS.bytes, 'workspace_file_too_large', 413);
        const after = await handle.stat({ bigint: true });
        const named = await lstat(file, { bigint: true });
        check(after.size === BigInt(size) && sameFile(initial, after) && sameFile(after, named), 'workspace_changed');
        await unchanged(chain);
        check(await realpath(file) === file, 'workspace_changed');
        const content = bytes.subarray(0, size);
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
        catch { throw new Fault('workspace_text_required', 'workspace_text_required', 415); }
        check(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text), 'workspace_text_required', 415);
        return { ...metadata(path, after), text, hash: createHash('sha256').update(content).digest('hex') };
      } finally { await handle.close(); }
    });
  }
}
