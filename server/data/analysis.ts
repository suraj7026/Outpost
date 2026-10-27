import { createHash } from 'node:crypto';
import { requireThat } from '../core/contracts.js';
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') { if (text[i+1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === '"') { requireThat(field === '' && !closed,'invalid_csv_quote'); quoted = true; }
    else if (char === ',') { row.push(field); field = ''; closed = false; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i+1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; closed = false; }
    else { requireThat(!closed,'invalid_csv_quote'); field += char; }
  }
  requireThat(!quoted,'unterminated_csv'); if (field !== '' || row.length || closed) { row.push(field); rows.push(row); } return rows;
}
export function profileCSV(text: string) {
  const [header,...rows] = parseCSV(text); requireThat(header && header.length > 0 && new Set(header).size === header.length,'invalid_header');
  const valid = rows.filter(row => row.length === header.length), seen = new Set<string>(); let duplicates = 0;
  for (const row of valid) { const key = JSON.stringify(row); if (seen.has(key)) duplicates++; seen.add(key); }
  return { hash: createHash('sha256').update(text).digest('hex'),columns: header,rows: rows.length,rejectedRows: rows.length-valid.length,duplicates,missing: header.map((name,index) => ({ name,count: valid.filter(row => row[index]?.trim() === '').length })) };
}
export function minorUnits(value: string) {
  requireThat(/^-?\d+(\.\d{1,2})?$/.test(value),'invalid_decimal');
  const negative = value.startsWith('-'), [whole,fraction = ''] = value.replace('-','').split('.');
  const units = BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0')); return negative ? -units : units;
}
export function reconcile(left: { id: string; amount: string }[], right: { id: string; amount: string }[]) {
  const index = (items: typeof left) => { const map = new Map<string,bigint>(); for (const row of items) { requireThat(!map.has(row.id),'duplicate_record_id'); map.set(row.id,minorUnits(row.amount)); } return map; };
  const a = index(left), b = index(right), keys = new Set([...a.keys(),...b.keys()]);
  return { leftTotal: [...a.values()].reduce((sum,value) => sum+value,0n).toString(),rightTotal: [...b.values()].reduce((sum,value) => sum+value,0n).toString(),exceptions: [...keys].filter(key => a.get(key) !== b.get(key)).map(key => ({ id: key,left: a.get(key)?.toString() ?? null,right: b.get(key)?.toString() ?? null })) };
}
