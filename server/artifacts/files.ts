import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, existsSync, renameSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import { id, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import type { Gate } from '../policy/trust.js';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export class Workspace {
  readonly root: string;
  constructor(root: string) { mkdirSync(root,{ recursive: true,mode: 0o700 }); this.root = realpathSync(root); }
  path(name: string) {
    requireThat(name.length > 0 && !isAbsolute(name),'invalid_path');
    const path = resolve(this.root,name), rel = relative(this.root,path);
    requireThat(rel !== '' && rel !== '..' && !rel.startsWith(`../`) && !isAbsolute(rel),'path_escape');
    let cursor = this.root;
    for (const part of rel.split('/')) { cursor = join(cursor,part); if (existsSync(cursor)) requireThat(!lstatSync(cursor).isSymbolicLink(),'symlink_forbidden'); }
    return path;
  }
  read(name: string) { const path = this.path(name); requireThat(statSync(path).size <= 1_048_576,'file_too_large'); return readFileSync(path,'utf8'); }
  write(name: string, text: string, expectedHash: string | null) {
    const path = this.path(name); requireThat((existsSync(path) ? sha(readFileSync(path)) : null) === expectedHash,'file_changed');
    mkdirSync(dirname(path),{ recursive: true }); const temp = `${path}.${id()}.tmp`;
    writeFileSync(temp,text,{ flag: 'wx',mode: 0o600 }); renameSync(temp,path); return { hash: sha(Buffer.from(text)),path: name };
  }
  register(gate: Gate) {
    const Read = z.strictObject({ path: z.string().min(1).max(1000) });
    const Write = Read.extend({ text: z.string().max(1_048_576),expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() });
    gate.register('file.read',{ version: 1,effects: ['workspace.read'],parse: value => Read.parse(value),target: args => String(args.path),execute: async args => this.read(String(args.path)) });
    gate.register('file.write',{ version: 1,effects: ['workspace.write'],parse: value => Write.parse(value),target: args => String(args.path),execute: async args => { const data = Write.parse(args); return this.write(data.path,data.text,data.expectedHash); } });
  }
}
interface Upload { taskId: string; name: string; mime: string; size: number; hash: string; offset: number; state: string }
export class Artifacts {
  constructor(readonly db: Ledger, readonly root: string) { mkdirSync(root,{ recursive: true,mode: 0o700 }); }
  begin(taskId: string, name: string, mime: string, size: number, hash: string) {
    requireThat(Number.isSafeInteger(size) && size >= 0 && size <= 64*1024*1024,'invalid_size');
    requireThat(/^[a-f0-9]{64}$/.test(hash),'invalid_hash');
    requireThat(name.length > 0 && name.length <= 255 && !/[\r\n/\\]/.test(name),'invalid_name');
    requireThat(/^[\w.+-]+\/[\w.+-]+$/.test(mime),'invalid_mime');
    this.db.need('task',taskId);
    const key = id(); writeFileSync(join(this.root,`${key}.part`),'',{ flag: 'wx',mode: 0o600 });
    return this.db.transaction(() => this.db.put<Upload>('upload',key,0,{ taskId,name,mime,size,hash,offset: 0,state: 'incomplete' }));
  }
  chunk(key: string, offset: number, bytes: Buffer) {
    return this.db.transaction(() => {
      const record = this.db.need<Upload>('upload',key), upload = record.data;
      requireThat(upload.state === 'incomplete' && Number.isSafeInteger(offset) && offset === upload.offset,'upload_offset');
      requireThat(bytes.length > 0 && bytes.length <= 1024*1024 && offset+bytes.length <= upload.size,'invalid_chunk');
      const file = openSync(join(this.root,`${record.id}.part`),'r+');
      try { writeSync(file,bytes,0,bytes.length,offset); } finally { closeSync(file); }
      return this.db.put('upload',key,record.revision,{ ...upload,offset: offset+bytes.length });
    });
  }
  complete(key: string) {
    return this.db.transaction(() => {
      const record = this.db.need<Upload>('upload',key), upload = record.data;
      const existing = this.db.get('artifact',key); if (existing) return existing;
      requireThat(upload.offset === upload.size,'incomplete_upload');
      const part = join(this.root,`${record.id}.part`), final = join(this.root,`${record.id}.blob`);
      const bytes = readFileSync(existsSync(part) ? part : final);
      requireThat(bytes.length === upload.size && sha(bytes) === upload.hash,'checksum_mismatch');
      if (existsSync(part)) renameSync(part,final);
      this.db.put('upload',key,record.revision,{ ...upload,state: 'complete' });
      return this.db.put('artifact',key,0,{ taskId: upload.taskId,name: upload.name,mime: upload.mime,size: upload.size,hash: upload.hash,verified: true },'artifact.published');
    });
  }
  read(key: string) {
    const record = this.db.need('artifact',key), bytes = readFileSync(join(this.root,`${record.id}.blob`));
    requireThat(sha(bytes) === record.data.hash,'artifact_corrupt'); return bytes;
  }
  publish(taskId: string, name: string, mime: string, bytes: Buffer) {
    const upload = this.begin(taskId,name,mime,bytes.length,sha(bytes));
    for (let offset = 0; offset < bytes.length; offset += 1024*1024) this.chunk(upload.id,offset,bytes.subarray(offset,offset+1024*1024));
    return this.complete(upload.id);
  }
}
