import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { z } from 'zod';
import { NewTask, Tasks } from './tasks.js';

test('new tasks default to full_control, migrate legacy to auto and advertise exactly two modes',() => {
  const db = new Ledger(), tasks = new Tasks(db);
  try {
    for (const mode of [undefined,'ask_permission','auto','full_control']) {
      const task = tasks.create(String(mode),{ goal: 'Inspect',profile: 'operations',...(mode ? { mode } : {}) });
      assert.equal(db.need('policy',task.id).data.mode,mode === 'auto' || mode === 'ask_permission' ? 'auto' : 'full_control');
    }
    const schema = z.toJSONSchema(NewTask);
    assert.doesNotMatch(JSON.stringify(schema),/ask_permission/);
    assert.match(JSON.stringify(schema),/\"enum\":\[\"full_control\",\"auto\"\]/);
    const before = db.cursor();
    for (const mode of ['root',null,3]) assert.throws(() => tasks.create('invalid',{ goal: 'Inspect',profile: 'operations',mode }));
    assert.equal(db.cursor(),before);
  } finally { db.close(); }
});

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
