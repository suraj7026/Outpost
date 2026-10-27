import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Tasks } from './tasks.js';

test('ordered instructions, exclusive execution and honest recovery across three pillars',() => {
  const db = new Ledger(), tasks = new Tasks(db);
  for (const profile of ['code','browser','operations']) {
    db.transaction(() => tasks.create(profile,{ goal: `Inspect ${profile}`,profile }));
    tasks.claim(profile,'worker'); assert.throws(() => tasks.claim(profile,'other'),/already_claimed/);
    db.transaction(() => tasks.steer(profile,2,'Keep the original files'));
    assert.throws(() => db.transaction(() => tasks.control(profile,2,'cancel')),/stale_revision/);
  }
  tasks.recover(); assert.equal(db.need('task','code').data.state,'interrupted');
  db.transaction(() => tasks.control('code',4,'cancel'));
  assert.throws(() => tasks.steer('code',5,'Resume'),/terminal_task/);
  assert.equal(db.list('message').length,6); db.close();
});
