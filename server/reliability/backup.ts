import { backup, DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Artifacts } from '../artifacts/files.js';
import { requireThat } from '../core/contracts.js';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const Archive = z.strictObject({ version: z.literal(1),createdAt: z.string(),ledger: z.string(),ledgerHash: z.string(),artifacts: z.array(z.strictObject({ id: z.uuid(),hash: z.string(),bytes: z.string() })) });
export async function createBackup(db: Ledger, artifacts: Artifacts, key: Buffer, destination: string) {
  requireThat(key.length === 32,'invalid_backup_key'); requireThat(!existsSync(destination),'backup_destination_exists');
  const temp = mkdtempSync(join(tmpdir(),'outpost-backup-'));
  try {
    const snapshot = join(temp,'snapshot.sqlite'); await backup(db.db,snapshot);
    const frozen = new Ledger(snapshot);
    const entries = frozen.list('artifact');
    try {
      const data = readFileSync(snapshot); let total = data.length;
      const files = entries.map(entry => { const bytes = artifacts.read(entry.id); total += bytes.length; requireThat(total <= 128*1024*1024,'backup_capacity_exceeded'); return { id: entry.id,hash: sha(bytes),bytes: bytes.toString('base64') }; });
      const archive = Buffer.from(JSON.stringify({ version: 1,createdAt: new Date().toISOString(),ledger: data.toString('base64'),ledgerHash: sha(data),artifacts: files }));
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(Buffer.from('outpost-backup-v1'));
      const encrypted = Buffer.concat([cipher.update(archive),cipher.final()]);
      const output = Buffer.concat([Buffer.from('OUTPOST1'),iv,cipher.getAuthTag(),encrypted]);
      writeFileSync(destination,output,{ flag: 'wx',mode: 0o600 });
      return { path: destination,hash: sha(output),artifactCount: files.length,verifiedRestore: false };
    } finally { frozen.close(); }
  } finally { rmSync(temp,{ recursive: true,force: true }); }
}
export function restoreBackup(source: string, key: Buffer, destination: string) {
  requireThat(key.length === 32,'invalid_backup_key'); requireThat(!existsSync(destination) || readdirSync(destination).length === 0,'restore_destination_not_empty');
  const bytes = readFileSync(source); requireThat(bytes.length <= 200*1024*1024 && bytes.subarray(0,8).toString() === 'OUTPOST1','invalid_backup');
  const decipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20)); decipher.setAAD(Buffer.from('outpost-backup-v1')); decipher.setAuthTag(bytes.subarray(20,36));
  const archive = Archive.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]).toString('utf8')));
  const ledger = Buffer.from(archive.ledger,'base64'); requireThat(sha(ledger) === archive.ledgerHash,'backup_ledger_corrupt');
  for (const file of archive.artifacts) requireThat(sha(Buffer.from(file.bytes,'base64')) === file.hash,'backup_artifact_corrupt');
  mkdirSync(join(destination,'artifacts'),{ recursive: true,mode: 0o700 });
  writeFileSync(join(destination,'ledger.sqlite'),ledger,{ flag: 'wx',mode: 0o600 });
  for (const file of archive.artifacts) writeFileSync(join(destination,'artifacts',`${file.id}.blob`),Buffer.from(file.bytes,'base64'),{ flag: 'wx',mode: 0o600 });
  const verify = new DatabaseSync(join(destination,'ledger.sqlite'));
  try { requireThat(verify.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok','restore_integrity_failed'); }
  finally { verify.close(); }
  return { artifactCount: archive.artifacts.length,createdAt: archive.createdAt,dispatchEnabled: false };
}
