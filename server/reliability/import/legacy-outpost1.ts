import { createDecipheriv } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { check, limits, SourceError } from './contracts.js';
import { readStable, strictJson, sha, hashPattern } from './manifest.js';
import { timestampText } from '../../storage/conversion.js';

const Archive = z.strictObject({ version: z.literal(1), createdAt: z.string(), ledger: z.string(), ledgerHash: z.string().regex(hashPattern), artifacts: z.array(z.strictObject({ id: z.uuid(), hash: z.string().regex(hashPattern), bytes: z.string() })).max(limits.files) });
function base64(text: string): Buffer {
  check(text.length <= Math.ceil(limits.decoded / 3) * 4 && text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text), 'invalid_archive');
  const bytes = Buffer.from(text, 'base64');
  check(bytes.toString('base64') === text, 'invalid_archive'); return bytes;
}
/** Strict decode-only compatibility with the existing writer: 8-byte magic, 12 IV, 16 tag. */
export function decodeLegacy(source: string, key: Buffer, staging: string) {
  try {
    check(key.length === 32, 'invalid_archive');
    const chunks: Buffer[] = [];
    const fingerprint = readStable(source, limits.archive, chunk => chunks.push(Buffer.from(chunk)));
    const bytes = Buffer.concat(chunks);
    check(bytes.length > 36 && bytes.subarray(0, 8).equals(Buffer.from('OUTPOST1')), 'invalid_archive');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
    decipher.setAAD(Buffer.from('outpost-backup-v1')); decipher.setAuthTag(bytes.subarray(20, 36));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
    const archive = Archive.parse(strictJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    timestampText(archive.createdAt);
    const ledger = base64(archive.ledger); let total = ledger.length;
    check(total <= limits.decoded && sha(ledger) === archive.ledgerHash, 'invalid_archive');
    const ids = new Set<string>();
    // Authenticate and validate every entry before extracting any of them.
    for (const file of archive.artifacts) {
      check(!ids.has(file.id.toLowerCase()), 'invalid_archive'); ids.add(file.id.toLowerCase());
      const decoded = base64(file.bytes); total += decoded.length;
      check(total <= limits.decoded && decoded.length <= limits.file && sha(decoded) === file.hash, 'invalid_archive');
    }
    const database = join(staging, 'ledger.sqlite'), artifactRoot = join(staging, 'artifacts');
    mkdirSync(artifactRoot, { mode: 0o700 });
    writeFileSync(database, ledger, { flag: 'wx', mode: 0o600 });
    for (const file of archive.artifacts) writeFileSync(join(artifactRoot, `${file.id}.blob`), base64(file.bytes), { flag: 'wx', mode: 0o600 });
    return { database, artifactRoot, fingerprint, artifactCount: ids.size };
  } catch { throw new SourceError('invalid_archive'); }
}
