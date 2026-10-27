import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
interface Memory { text: string; project: string; identityId: string; source: string; provenance: 'owner' | 'observation' | 'inference'; confirmed: boolean; forgotten: boolean }
export class MemoryStore {
  constructor(private db: Ledger) { db.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, project UNINDEXED, identity_id UNINDEXED, text)'); }
  save(input: Omit<Memory,'confirmed' | 'forgotten'>) {
    requireThat(input.text.length > 0 && input.text.length <= 20000 && input.source.length > 0,'memory_source_required');
    return this.db.transaction(() => {
      const record = this.db.put<Memory>('memory',id(),0,{ ...input,confirmed: input.provenance === 'owner',forgotten: false });
      this.db.db.prepare('INSERT INTO memory_search VALUES(?,?,?,?)').run(record.id,input.project,input.identityId,input.text); return record;
    });
  }
  search(text: string, project: string, identityId: string) {
    requireThat(text.trim().length > 0 && text.length <= 1000,'invalid_search');
    const query = text.trim().split(/\s+/).map(word => `"${word.replaceAll('"','""')}"`).join(' AND ');
    return this.db.db.prepare('SELECT id FROM memory_search WHERE memory_search MATCH ? AND project=? AND identity_id=? ORDER BY rank LIMIT 30').all(query,project,identityId).map(row => this.db.need<Memory>('memory',String(row.id)));
  }
  forget(key: string, expected: number) {
    return this.db.transaction(() => {
      const memory = this.db.need<Memory>('memory',key);
      this.db.db.prepare('DELETE FROM memory_search WHERE id=?').run(key);
      return this.db.put('memory',key,expected,{ ...memory.data,text: '',forgotten: true },'memory.forgotten');
    });
  }
  rebuild() {
    return this.db.transaction(() => {
      this.db.db.exec('DELETE FROM memory_search');
      for (const record of this.db.list<Memory>('memory')) if (!record.data.forgotten) this.db.db.prepare('INSERT INTO memory_search VALUES(?,?,?,?)').run(record.id,record.data.project,record.data.identityId,record.data.text);
    });
  }
}
