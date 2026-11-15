import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from '../gateway/coordinator.js';
import { Workspace } from '../artifacts/files.js';
import { InferenceConfiguration } from '../models/inference.js';
import { outpostSystemPrompt } from './system-prompt.js';
import { actionFailureMessage } from '../pi-worker/contracts.js';

test('advertised schemas match real action validation; commands and files succeed without sudo or path escape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-action-contracts-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const coordinator = new Coordinator(db, root, { executables: ['/bin/ls'], browser: {},
    inference: InferenceConfiguration.parse({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture' }),
    hosts: { token: 'fixture-host-token', endpoints: { surajhomeserver: 'http://127.0.0.1:1', surajhomeserver2: 'http://127.0.0.1:1' } } });
  try {
    const task = coordinator.tasks.create(randomUUID(), { goal: 'Fixture', profile: 'code', mode: 'full_control' });
    const gate = coordinator.gate(task.id), catalogue = gate.catalogue();
    for (const [name, field] of [['command.run','argv'],['browser.open','url'],['artifact.read_text','artifactId'],['file.read','path'],['file.write','expectedHash'],['host.execute','host']]) {
      const schema = catalogue.find(t => t.name === name)?.inputSchema;
      assert.ok(schema); assert.ok(Array.isArray(schema.required) && schema.required.includes(field));
    }
    for (const [name, input] of [['command.run',{ command: 'ls -la' }],['browser.open',{}],['artifact.read_text',{ path: 'STATUS.md' }]] as const)
      await assert.rejects(gate.propose(task.id, name, input));
    assert.equal(db.list('action').length, 0, 'Invalid arguments never dispatch');
    const command = await gate.propose(task.id, 'command.run', { argv: ['/bin/ls','-la'], cwd: '.' });
    const observed = await gate.dispatch(command.id);
    assert.equal(observed.data.state, 'succeeded');
    assert.equal((observed.data.result as { exitCode: number }).exitCode, 0);
    const workspace = new Workspace(join(root, 'workspaces', task.id));
    workspace.write('STATUS.md','fixture status',null);
    assert.equal(workspace.read('STATUS.md'),'fixture status');
    assert.throws(() => workspace.read('.'), /file_required_use_command_run_for_listing/);
    assert.throws(() => workspace.read('../outside'), /path_escape/);
    const prompt = outpostSystemPrompt(catalogue);
    assert.match(prompt, /inputSchema/); assert.match(prompt, /artifactId/); assert.match(prompt, /non-root/);
    assert.match(prompt, /owner-authorized root path/);
    assert.ok(!prompt.includes('fixture-host-token'));
    assert.ok(!actionFailureMessage({ code: 'untrusted-secret-body', message: 'private-value' }).includes('private-value'));
  } finally { coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
