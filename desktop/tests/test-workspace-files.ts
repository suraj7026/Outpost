import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTextArtifact, normalizedWorkspacePath, parseWorkspaceDocument, parseWorkspaceListing, recordedWorkspaceChanges, workspaceLinkPath, writtenWorkspacePath, workspaceFailure } from '../src/workspace/workspace-files.ts';
import type { ServerRecord } from '../src/types.ts';

const row = (id: string, args: Record<string, string | null>, state = 'succeeded', hash = 'a'.repeat(64)): ServerRecord => ({ kind: 'action', id, revision: 1, updatedAt: `2026-11-17T10:00:0${id}Z`, data: { tool: 'file.write', state, arguments: args, result: { hash } } });
test('file paths remain task-relative and decoded links cannot escape the workspace', () => {
  assert.equal(normalizedWorkspacePath('./docs//README.md'), 'docs/README.md');
  for (const path of ['', '/', '/etc/passwd', '../private', 'docs/../private', 'a\\b', 'file:///etc/passwd', '%2e%2e/private', 'a\0b']) assert.equal(normalizedWorkspacePath(path), undefined, path);
  assert.equal(workspaceLinkPath('docs/hello%20world.md#summary'), 'docs/hello world.md');
  assert.equal(workspaceLinkPath('notes/caf%C3%A9.md'), 'notes/café.md');
  assert.equal(workspaceLinkPath('docs/README.md?view=source'), 'docs/README.md');
  for (const href of ['https://example.com', '//example.com', '#heading', '%2e%2e/private', 'docs%2fprivate', 'docs%5cprivate', '%E0%A4%A', 'javascript:alert(1)']) assert.equal(workspaceLinkPath(href), undefined, href);
});
test('only completed file writes supply reviewable paths and changes', () => {
  const args = { path: 'docs/README.md', text: '# Hello', expectedHash: null };
  assert.equal(writtenWorkspacePath(row('1', args)), 'docs/README.md');
  for (const state of ['pending', 'authorized', 'running', 'failed', 'unknown']) assert.equal(writtenWorkspacePath(row('1', args, state)), undefined);
  assert.equal(writtenWorkspacePath({ ...row('1', args), kind: 'tool_stream' }), undefined);
});
test('previous text is used only when linked by the expected hash', () => {
  const first = row('1', { path: 'notes.txt', text: 'before', expectedHash: null });
  const second = row('2', { path: 'notes.txt', text: 'after', expectedHash: 'a'.repeat(64) }, 'succeeded', 'b'.repeat(64));
  const changes = recordedWorkspaceChanges([second, first]);
  assert.deepEqual(changes.get('notes.txt'), { kind: 'modified', writtenText: 'after', previousText: 'before', recordId: '2', hash: 'b'.repeat(64) });
  const unlinked = row('3', { path: 'notes.txt', text: 'other', expectedHash: 'c'.repeat(64) });
  assert.equal(recordedWorkspaceChanges([first, unlinked]).get('notes.txt')?.previousText, undefined);
});
test('listing validates paths, metadata, and count bounds', () => {
  const file = { path: 'README.md', name: 'README.md', size: 12, modifiedAt: '2026-11-17' };
  assert.deepEqual(parseWorkspaceListing({ files: [file], truncated: false }).files, [file]);
  for (const bad of [{ files: [{ ...file, path: '../README.md' }], truncated: false }, { files: [{ ...file, size: -1 }], truncated: false }, { files: Array(1001).fill(file), truncated: false }, { files: [], truncated: 'false' }]) assert.throws(() => parseWorkspaceListing(bad));
});
test('text response checks identity, utf8 byte length, and limits', () => {
  const document = { path: 'README.md', name: 'README.md', text: 'café', hash: 'a'.repeat(64), size: 5, modifiedAt: '2026-11-17' };
  assert.equal(parseWorkspaceDocument(document, 'README.md').text, 'café');
  assert.throws(() => parseWorkspaceDocument(document, 'other.md'));
  assert.throws(() => parseWorkspaceDocument({ ...document, size: 4 }, 'README.md'));
  assert.throws(() => parseWorkspaceDocument({ ...document, hash: 'invalid' }, 'README.md'));
  assert.throws(() => parseWorkspaceDocument({ ...document, text: 'x'.repeat(1_048_577), size: 1_048_577 }, 'README.md'));
});
test('unsupported workspace queries are distinguished from permission, transport and artifact failures', () => {
  for (const error of [{ code: 'unknown_query', message: 'Query unavailable' }, 'Unsupported query', new Error('Unsupported query'), new Error('Unknown query: workspace.files'), 'Unknown query: workspace.read']) {
    assert.equal(workspaceFailure(error).updateRequired, true);
    assert.equal(workspaceFailure(error, false).updateRequired, false, 'artifact errors cannot trigger a server update notice');
  }
  for (const error of [{ code: 'permission_denied', message: 'Unsupported query' }, { code: 'not_found', message: 'File not found' }, 'Cannot reach your server.', new Error('Invalid workspace file metadata.'), 'Unknown query: tools', null, {}]) {
    assert.equal(workspaceFailure(error).updateRequired, false);
  }
  assert.deepEqual(workspaceFailure({ code: 'permission_denied', message: 'Access denied' }), { message: 'Access denied', updateRequired: false });
  assert.equal(workspaceFailure({}).message, 'The server could not complete this request.');
});

test('artifact previews reject binary, invalid UTF8, and oversize payloads', () => {
  assert.equal(decodeTextArtifact(Buffer.from('café').toString('base64')), 'café');
  assert.throws(() => decodeTextArtifact(Buffer.from([0, 1, 2]).toString('base64')));
  assert.throws(() => decodeTextArtifact(Buffer.from([255]).toString('base64')));
  assert.throws(() => decodeTextArtifact(Buffer.alloc(1_048_577).toString('base64')));
});
