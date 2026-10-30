import { mkdtempSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, limits, SourceError } from './contracts.js';
import type { Source, SourceManifest, FileInventory } from './contracts.js';
import { byteOrder, copyStable, directoryNames, hashJson, pathStamp, readStable, safePath, sha } from './manifest.js';
import { inventorySqlite, noSidecars } from './sqlite-source.js';
import { decodeLegacy } from './legacy-outpost1.js';

/** A bounded inspection only. No destination, repository, runtime, or dispatch capability. */
export function dryRun(source: Source): SourceManifest {
  let staging: string | undefined;
  try {
    check(source.type === 'sqlite' || source.type === 'outpost1', 'invalid_source');
    const sourcePath = safePath(source.type === 'sqlite' ? source.database : source.archive);
    const initialSourceStamp = pathStamp(sourcePath);
    staging = mkdtempSync(join(realpathSync(tmpdir()), 'outpost-source-')); chmodSync(staging, 0o700);
    let database: string, artifactRoot: string, fingerprint: { hash: string; size: number }, archivedCount: number | undefined;
    if (source.type === 'sqlite') {
      check(source.frozen === true, 'frozen_acknowledgment_required'); noSidecars(sourcePath);
      artifactRoot = safePath(source.artifactRoot, true); database = join(staging, 'ledger.sqlite');
      fingerprint = copyStable(sourcePath, database, limits.database); noSidecars(sourcePath);
    } else {
      const decoded = decodeLegacy(sourcePath, source.key, staging);
      ({ database, artifactRoot, fingerprint } = decoded); archivedCount = decoded.artifactCount;
    }
    const databaseFingerprint = readStable(database, limits.database);
    const inventory = inventorySqlite(database);
    const rootStamp = pathStamp(artifactRoot), names = directoryNames(artifactRoot);
    const published = new Map(inventory.artifacts.map(entry => [`${entry.id}.blob`, entry]));
    const uploads = new Map(inventory.uploadRecords.map(entry => [`${entry.id}.part`, entry]));
    const blockers = new Set<string>(['source_only_no_apply', 'external_state_not_inventoried']);
    if (inventory.outboxStates.claimed) blockers.add('claimed_effects_require_reconciliation');
    if (inventory.outboxStates.unknown) blockers.add('unknown_effects_require_reconciliation');
    const files: FileInventory[] = [], fileStamps = new Map<string, string>();
    for (const name of names) {
      const path = join(artifactRoot, name); fileStamps.set(name, pathStamp(path));
      const file = readStable(path, limits.file), artifact = published.get(name), upload = uploads.get(name);
      let role: FileInventory['role'] = 'unexpected';
      if (artifact) { check(artifact.hash === file.hash && artifact.size === file.size, 'artifact_mismatch'); role = 'published'; }
      else if (upload) { role = 'partial'; blockers.add('partial_uploads_unsupported'); if (file.size !== upload.offset) blockers.add('upload_offset_ambiguous'); }
      else blockers.add('unexpected_artifact_files');
      files.push({ nameHash: sha(name), ...file, role });
    }
    const nameSet = new Set(names);
    for (const name of published.keys()) check(nameSet.has(name), 'artifact_missing');
    for (const upload of inventory.uploadRecords) {
      const artifact = published.get(`${upload.id}.blob`);
      if (upload.state === 'incomplete') {
        blockers.add('partial_uploads_unsupported');
        if (!nameSet.has(`${upload.id}.part`)) blockers.add('upload_part_missing');
        if (nameSet.has(`${upload.id}.blob`)) blockers.add('upload_rename_ambiguous');
      } else {
        check(artifact && upload.offset === upload.size && artifact.hash === upload.hash && artifact.size === upload.size, 'completed_upload_mismatch');
        if (nameSet.has(`${upload.id}.part`)) blockers.add('upload_rename_ambiguous');
      }
    }
    if (archivedCount !== undefined) check(archivedCount === inventory.artifacts.length && files.every(file => file.role === 'published'), 'archive_artifact_inventory_mismatch');
    // A second streamed pass detects changed content and metadata, including substitutions.
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!, path = join(artifactRoot, name), after = readStable(path, limits.file);
      check(pathStamp(path) === fileStamps.get(name) && after.hash === files[i]!.hash && after.size === files[i]!.size, 'source_changed');
    }
    check(pathStamp(artifactRoot) === rootStamp && hashJson(directoryNames(artifactRoot)) === hashJson(names), 'source_changed');
    if (source.type === 'sqlite') noSidecars(sourcePath);
    const after = readStable(sourcePath, source.type === 'sqlite' ? limits.database : limits.archive);
    check(pathStamp(sourcePath) === initialSourceStamp && hashJson(after) === hashJson(fingerprint), 'source_changed');
    const { artifacts: _artifacts, uploadRecords: _uploads, ...summary } = inventory;
    files.sort((a, b) => byteOrder(a.nameHash, b.nameHash));
    return {
      format: 'outpost-source-inventory', version: 1, tool: 'source-only-v1', sourceType: source.type,
      source: fingerprint, database: databaseFingerprint, ...summary,
      files, artifactInventoryHash: hashJson(files), blockers: [...blockers].sort(byteOrder),
      exclusions: ['browser_profiles', 'connector_credentials_and_checkpoints', 'key_custody', 'pi_sessions', 'workspaces', 'fts_contents_are_derived'],
      applySupported: false,
    };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError('source_validation_failed');
  } finally {
    if (staging) {
      try { rmSync(staging, { recursive: true, force: true }); }
      catch { throw new SourceError('staging_cleanup_failed'); }
    }
  }
}
