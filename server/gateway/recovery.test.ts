import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from './coordinator.js';

test('unavailable push transport cannot starve work; failed queued operations are observable',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-recovery-')), db = new Ledger();
  try {
    const coordinator = new Coordinator(db,root), taskId = id();
    for (let i = 0; i < 25; i++) db.enqueue('notice',{ noticeId: id() });
    coordinator.tasks.create(taskId,{ goal: 'Capacity fixture',profile: 'operations' });
    await coordinator.drain();
    assert.equal(db.need('task',taskId).data.state,'waiting_for_capacity');
    const accepted = coordinator.command({ protocolVersion: 1,commandId: id(),idempotencyKey: id(),deviceId: id(),issuedAt: Date.now(),aggregateId: taskId,expectedRevision: 2,type: 'action.propose',payload: { tool: 'unavailable.fixture',arguments: {} } }) as { operationId: string };
    await coordinator.drain();
    assert.equal(db.need('operation',accepted.operationId).data.state,'unknown');
    assert.equal(db.need('operation',accepted.operationId).data.error,'unavailable_tool');
    const cursor = db.cursor(); await coordinator.drain(); assert.equal(db.cursor(),cursor);
  } finally { db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('restart preserves accepted instructions and marks uncertain dispatch without replay',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-recovery-')), db = new Ledger(join(root,'db.sqlite'));
  try {
    const coordinator = new Coordinator(db,root), taskId = id();
    coordinator.tasks.create(taskId,{ goal: 'Restart fixture',profile: 'code' });
    coordinator.tasks.claim(taskId,'fixture-worker');
    coordinator.tasks.steer(taskId,2,'Retain this instruction across restart');
    const action = await coordinator.gate(taskId).propose(taskId,'system.inspect',{});
    db.put('action',action.id,1,{ ...action.data,state: 'dispatching' });
    db.put('operation','uncertain',0,{ taskId,state: 'running',topic: 'action.dispatch' });
    db.enqueue('action.dispatch',{ actionId: action.id },'uncertain');
    db.db.prepare("UPDATE outbox SET state='claimed' WHERE id='uncertain'").run();
    const restarted = new Coordinator(db,root); await restarted.drain();
    assert.equal(db.need('task',taskId).data.state,'interrupted');
    assert.equal(db.list('message').length,2);
    assert.equal(db.need('action',action.id).data.state,'unknown');
    assert.equal(db.need('operation','uncertain').data.state,'unknown');
    assert.equal(db.db.prepare("SELECT state FROM outbox WHERE id='uncertain'").get()?.state,'unknown');
  } finally { db.close(); rmSync(root,{ recursive: true,force: true }); }
});
