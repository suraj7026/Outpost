import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Assistance } from './assistance.js';
test('assistance is deduplicated, rejects denial evasion and requires fresh verification',() => {
  const db = new Ledger(), assistance = new Assistance(db);
  const request = assistance.request('task','browser','mfa',1);
  assert.equal(assistance.request('task','browser','mfa',1).id,request.id);
  assert.throws(() => assistance.resolve(request.id,1,1,true));
  assert.throws(() => assistance.request('task','browser','permission_denied',2));
  assistance.resolve(request.id,1,2,true); assert.throws(() => assistance.resolve(request.id,1,3,true));
  assert.equal(db.need('inbox',request.id).data.state,'resolved'); db.close();
});
