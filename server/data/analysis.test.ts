import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, profileCSV, reconcile, minorUnits } from './analysis.js';
test('CSV preserves quoted lines and profiles malformed rows; money uses exact units',() => {
  assert.deepEqual(parseCSV('a,b\r\n"x\ny","a""b"\r\n'),[['a','b'],['x\ny','a"b']]);
  assert.throws(() => parseCSV('"unfinished'));
  const profile = profileCSV('id,value\n1,\n1,\n2,b,extra'); assert.equal(profile.rejectedRows,1); assert.equal(profile.duplicates,1);
  assert.equal(minorUnits('0.10')+minorUnits('0.20'),30n);
  const result = reconcile([{ id: 'a',amount: '0.30' }],[{ id: 'a',amount: '0.29' }]); assert.equal(result.exceptions.length,1);
  assert.throws(() => minorUnits('1.234'));
});
