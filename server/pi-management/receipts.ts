import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { managementError } from './contracts.js';

/** Only operation IDs, nonsecret mutation digests and sanitized results enter this journal. */
export class ManagementReceipts {
  private db: DatabaseSync;
  constructor(directory: string) {
    const path = join(directory, '.outpost-management.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT, id TEXT, digest TEXT, state TEXT, result TEXT, PRIMARY KEY(owner,id));`);
  }
  close() { this.db.close(); }
  reserve(owner: string, id: string, request: unknown) {
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const previous = this.db.prepare('SELECT digest,state,result FROM receipts WHERE owner=? AND id=?').get(owner,id);
    if (previous) {
      if (previous.digest !== digest) throw managementError('management_operation_conflict');
      if (previous.state !== 'done') throw managementError('management_outcome_unknown_refresh_configuration');
      return { replay: true as const, result: JSON.parse(String(previous.result)) as unknown };
    }
    if (Number(this.db.prepare('SELECT count(*) AS n FROM receipts').get()?.n) >= 100000) throw managementError('management_receipt_capacity');
    this.db.prepare("INSERT INTO receipts VALUES(?,?,?,'pending',NULL)").run(owner,id,digest);
    return { replay: false as const };
  }
  finish(owner: string, id: string, result: unknown) {
    this.db.prepare("UPDATE receipts SET state='done',result=? WHERE owner=? AND id=?").run(JSON.stringify(result),owner,id);
  }
}
