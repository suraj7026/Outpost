import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildHostRelease } from './package-host-release.mjs';
import { buildPiUpdate } from './package-pi-update.mjs';
import { inspectArchive, loadSigningKey, signArtifact, signReleaseFeed, verifyReleaseFeed } from './sign-releases.mjs';

const { values: options } = parseArgs({ options: {
  out: { type: 'string' }, 'github-repo': { type: 'string' }, 'github-tag': { type: 'string' },
} });
assert.ok(options.out, 'Usage: node scripts/publish-server-release.mjs --out DIRECTORY [--github-repo OWNER/REPO --github-tag TAG]');
assert.equal(Boolean(options['github-repo']), Boolean(options['github-tag']), 'Set both GitHub options or neither');
if (options['github-repo']) assert.match(options['github-repo'], /^[\w.-]+\/[\w.-]+$/);
if (options['github-tag']) assert.match(options['github-tag'], /^[A-Za-z0-9][\w./-]*$/);
const out = resolve(options.out), feedPath = join(out, 'feed.json');
const key = loadSigningKey();
const temporary = mkdtempSync(join(tmpdir(), 'outpost-publish-'));
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function publish(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
try {
  mkdirSync(out, { recursive: true });
  // Serialize publishers sharing this static directory, including the read/merge.
  const lock = join(out, '.publish-lock');
  mkdirSync(lock);
  try {
    const index = existsSync(feedPath) ? verifyReleaseFeed(JSON.parse(readFileSync(feedPath)), key) : { schema: 1, latest: {} };
    assert.equal(index.schema, 1);
    const assets = [];
    for (const [name, build] of [['host-release', buildHostRelease], ['pi-release', buildPiUpdate]]) {
      const metadata = build({ outputDir: temporary });
      const bytes = readFileSync(join(temporary, `${name}.tar.gz`));
      const artifact = signArtifact(metadata, bytes, key, inspectArchive(bytes));
      const encoded = json(artifact);
      const family = `${artifact.manifest.compatibility}:${artifact.runtimePinsSha256}`;
      const entry = { id: artifact.id, sequence: artifact.manifest.sequence, metadataSha256: hash(encoded) };
      const prior = index.latest[family];
      if (prior && prior.sequence > entry.sequence) continue;
      if (prior?.sequence === entry.sequence) assert.deepEqual(entry, prior, 'Release sequence reused for different content');
      index.latest[family] = entry;
      assets.push([`${artifact.id}.tar.gz`, bytes], [`${artifact.id}.json`, encoded]);
    }
    const files = join(out, 'releases');
    mkdirSync(files, { recursive: true });
    for (const [name, bytes] of assets) {
      const path = join(files, name);
      if (existsSync(path)) assert.ok(readFileSync(path).equals(bytes), `Immutable release asset changed: ${name}`);
      else publish(path, bytes);
    }
    assert.ok(Object.keys(index.latest).length <= 128, 'Too many feed families');
    publish(feedPath, json(signReleaseFeed(index, key)));
    if (options['github-repo']) {
      const args = ['--repo', options['github-repo']];
      const visibility = execFileSync('gh', ['repo', 'view', options['github-repo'], '--json', 'isPrivate', '--jq', '.isPrivate'], { encoding: 'utf8', timeout: 30000 }).trim();
      assert.equal(visibility, 'true', 'Refusing to upload private artifacts to a public repository');
      const names = [...new Set(Object.values(index.latest).flatMap(({ id }) => [`${id}.tar.gz`, `${id}.json`]))];
      execFileSync('gh', ['release', 'upload', options['github-tag'], ...args, ...names.map(name => join(files, name))], { stdio: 'inherit', timeout: 120000 });
      execFileSync('gh', ['release', 'upload', options['github-tag'], ...args, feedPath], { stdio: 'inherit', timeout: 120000 });
    }
    console.log(`Signed server feed: ${feedPath}`);
  } finally { rmSync(lock, { recursive: true }); }
} finally { rmSync(temporary, { recursive: true, force: true }); }
