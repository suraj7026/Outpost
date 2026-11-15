import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { Gate } from '../policy/trust.js';
import { Workspace } from '../artifacts/files.js';
import { id } from '../core/contracts.js';
import { execute, registerCommands, resolveExecutable } from './runner.js';

test('full-control workspace resolves bare tools without relaxing restricted enrollment', async () => {
  assert.match(await resolveExecutable('sh'),/^\//);
  await assert.rejects(resolveExecutable('./sh'),/absolute_executable_required/);
  await assert.rejects(resolveExecutable('outpost-nonexistent-fixture-tool'),/executable_not_found/);
  const root = mkdtempSync(join(tmpdir(),'outpost-commands-')), db = new Ledger(join(root,'ledger.sqlite')), taskId = id();
  try {
    db.put('policy',taskId,0,{ mode: 'full_control' });
    const workspace = new Workspace(join(root,'workspace'));
    const full = new Gate(db); registerCommands(full,workspace,new Set(),true);
    const input = { argv: ['sh','-c','printf full-control'],cwd: '.' };
    const action = await full.propose(taskId,'command.run',input);
    const result = await full.dispatch(action.id);
    assert.equal(result.data.state,'succeeded');
    const restricted = new Gate(db); registerCommands(restricted,workspace,new Set(['/bin/ls']));
    const denied = await restricted.propose(taskId,'command.run',input);
    const failure = await restricted.dispatch(denied.id);
    assert.equal(failure.data.state,'unknown');
    assert.match(JSON.stringify(failure.data),/executable_not_enrolled/);
  } finally { db.close(); rmSync(root,{ recursive: true,force: true }); }
});

test('runner records exit, excludes inherited secrets, bounds output and kills timeout',async () => {
  const signal = new AbortController().signal;
  const success = await execute([process.execPath,'-e','console.log("evidence"); process.exit(3)'],process.cwd(),signal);
  assert.equal(success.exitCode,3); assert.match(success.stdout,/evidence/);
  process.env.OUTPOST_TEST_SECRET = 'never-in-child';
  const env = await execute([process.execPath,'-e','console.log(process.env.OUTPOST_TEST_SECRET)'],process.cwd(),signal);
  assert.equal(env.stdout.trim(),'undefined'); delete process.env.OUTPOST_TEST_SECRET;
  const timeout = await execute([process.execPath,'-e','setInterval(()=>{},100)'],process.cwd(),signal,100);
  assert.equal(timeout.timedOut,true);
  const large = await execute([process.execPath,'-e','console.log("x".repeat(100000))'],process.cwd(),signal,10000,1000);
  assert.equal(large.outputLimitReached,true); assert.equal(Buffer.byteLength(large.stdout),1000);
});
