import { object, text, type ServerRecord } from '../types';

export interface WorkspaceFile { path: string; name: string; size: number; modifiedAt: string }
export interface WorkspaceDocument extends WorkspaceFile { text: string; hash: string }
export interface WorkspaceListing { files: WorkspaceFile[]; truncated: boolean }
export type WorkspaceSelection = { kind: 'workspace'; path: string } | { kind: 'artifact'; id: string };
export interface WorkspaceOpenRequest { selection: WorkspaceSelection; sequence: number }
export interface WorkspaceFailure { message: string; updateRequired: boolean }

export function workspaceFailure(error: unknown, workspaceQuery = true): WorkspaceFailure {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : typeof error === 'string' ? error : 'The server could not complete this request.';
  // Older desktop bridges returned only a string, so recognize their exact unsupported-query responses.
  const unsupported = code ? code === 'unknown_query' : /^(?:Error: )?(?:Unsupported query|Unknown query: workspace\.(?:files|read))$/.test(message);
  return { message, updateRequired: workspaceQuery && unsupported };
}
export interface RecordedChange {
  kind: 'added' | 'modified';
  writtenText?: string;
  previousText?: string;
  recordId: string;
  hash?: string;
}

export function normalizedWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1000 || value.startsWith('/') || /[\\:%\u0000-\u001f\u007f]/u.test(value)) return;
  const parts = value.split('/');
  if (parts.includes('..')) return;
  const path = parts.filter(part => part && part !== '.').join('/');
  return path || undefined;
}

export function workspaceLinkPath(href: string | undefined): string | undefined {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return;
  const path = href.split(/[?#]/, 1)[0];
  try {
    const parts = path.split('/').map(part => decodeURIComponent(part));
    if (parts.some(part => /[/\\]/.test(part))) return;
    return normalizedWorkspacePath(parts.join('/'));
  } catch { return; }
}

export function writtenWorkspacePath(record: ServerRecord): string | undefined {
  if (record.kind !== 'action' || text(record, 'tool') !== 'file.write' || text(record, 'state') !== 'succeeded') return;
  return normalizedWorkspacePath(object(record.data.arguments).path);
}

export function recordedWorkspaceChanges(records: ServerRecord[]): Map<string, RecordedChange> {
  const changes = new Map<string, RecordedChange>();
  const previous = new Map<string, { text: string; hash: string }>();
  for (const record of [...records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    const path = writtenWorkspacePath(record);
    if (!path) continue;
    const args = object(record.data.arguments), result = object(record.data.result);
    const writtenText = typeof args.text === 'string' ? args.text : undefined;
    const hash = typeof result.hash === 'string' ? result.hash : undefined;
    const prior = previous.get(path);
    changes.set(path, {
      kind: args.expectedHash === null ? 'added' : 'modified', writtenText, recordId: record.id, hash,
      previousText: prior && prior.hash === args.expectedHash ? prior.text : undefined,
    });
    if (writtenText !== undefined && hash) previous.set(path, { text: writtenText, hash });
    else previous.delete(path);
  }
  return changes;
}

export function selectionKey(selection: WorkspaceSelection | null): string {
  return selection ? selection.kind === 'workspace' ? `file:${selection.path}` : `artifact:${selection.id}` : '';
}

export function parseWorkspaceListing(value: unknown): WorkspaceListing {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files) || value.files.length > 1000 || !('truncated' in value) || typeof value.truncated !== 'boolean') throw new Error('Invalid workspace file list. Update the server and try again.');
  const files = value.files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || normalizedWorkspacePath(file.path) !== file.path || typeof file.name !== 'string' || file.name !== file.path.split('/').at(-1) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.modifiedAt !== 'string') throw new Error('Invalid workspace file metadata.');
    return { path: file.path, name: file.name, size: file.size, modifiedAt: file.modifiedAt } as WorkspaceFile;
  });
  return { files, truncated: value.truncated };
}

export function parseWorkspaceDocument(value: unknown, path: string): WorkspaceDocument {
  if (!value || typeof value !== 'object') throw new Error('Invalid document response.');
  const file = value as Record<string, unknown>;
  if (file.path !== path || file.name !== path.split('/').at(-1) || typeof file.text !== 'string' || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash) || typeof file.modifiedAt !== 'string' || !Number.isSafeInteger(file.size) || Number(file.size) > 1_048_576 || Number(file.size) < 0 || new TextEncoder().encode(file.text).length !== file.size) throw new Error('Invalid document response.');
  return { path, name: String(file.name), text: file.text, hash: file.hash, size: Number(file.size), modifiedAt: file.modifiedAt };
}

export function decodeTextArtifact(base64: string): string {
  if (base64.length > 1_398_104) throw new Error('Text preview is limited to 1 MiB. Download this file to view it.');
  const binary = atob(base64);
  if (binary.length > 1_048_576) throw new Error('Text preview is limited to 1 MiB.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(value)) throw new Error('This file is not UTF-8 text. Download it to view it.');
  return value;
}
