import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, sep } from 'node:path';
import { createHash } from 'node:crypto';

export class SkillError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SkillError'; }
}
export function skillCheck(value: unknown, code: string): asserts value {
  if (!value) throw new SkillError(code);
}
export function skillHash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

// Portable, exact inventory names only: no URL decoding, expansion, globbing or aliases.
export function skillRelativePath(path: string): string {
  skillCheck(path.length > 0 && path.length <= 512 && !isAbsolute(path) &&
    path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..'), 'skill_unsafe_path');
  return path;
}

async function directoryChain(path: string) {
  skillCheck(isAbsolute(path) && normalize(path) === path && path !== parse(path).root, 'skill_unsafe_root');
  let current = parse(path).root;
  const chain = [];
  for (const part of path.slice(current.length).split(sep)) {
    current = join(current, part);
    const stat = await lstat(current, { bigint: true });
    skillCheck(stat.isDirectory() && !stat.isSymbolicLink(), 'skill_unsafe_directory');
    chain.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  skillCheck(await realpath(path) === path, 'skill_unsafe_directory');
  return chain;
}

/** Reads bounded bytes, never a path for a consumer to reopen. Roots must be server-owned,
 * immutable version directories; portable Node lacks openat-based hostile-writer confinement.
 * Chain/inode checks detect replacements; the caller additionally verifies the pinned digest.
 */
export async function readSkillFile(root: string, directory: string, path: string, maxBytes: number): Promise<Buffer> {
  skillRelativePath(directory); skillRelativePath(path);
  skillCheck(isAbsolute(root) && normalize(root) === root && root !== parse(root).root, 'skill_unsafe_root');
  skillCheck(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024, 'skill_invalid_limit');
  const file = join(root, directory, path);
  try {
    const chain = await directoryChain(join(root, directory, ...path.split('/').slice(0, -1)));
    const before = await lstat(file, { bigint: true });
    skillCheck(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, 'skill_unsafe_file');
    skillCheck(before.size <= BigInt(maxBytes), 'skill_file_too_large');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await handle.stat({ bigint: true });
      skillCheck(initial.isFile() && initial.dev === before.dev && initial.ino === before.ino && initial.nlink === 1n, 'skill_file_changed');
      const bytes = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      skillCheck(size <= maxBytes, 'skill_file_too_large');
      const after = await handle.stat({ bigint: true });
      const named = await lstat(file, { bigint: true });
      skillCheck(after.size === BigInt(size) && after.size === initial.size && after.mtimeNs === initial.mtimeNs &&
        after.ctimeNs === initial.ctimeNs && named.dev === initial.dev && named.ino === initial.ino &&
        !named.isSymbolicLink() && named.nlink === 1n, 'skill_file_changed');
      for (const parent of chain) {
        const now = await lstat(parent.path, { bigint: true });
        skillCheck(now.isDirectory() && now.dev === parent.dev && now.ino === parent.ino, 'skill_directory_changed');
      }
      skillCheck(await realpath(file) === file, 'skill_unsafe_file');
      return bytes.subarray(0, size);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof SkillError) throw error;
    // Do not disclose host paths or filesystem error details to model-facing callers.
    throw new SkillError('skill_file_unavailable');
  }
}
