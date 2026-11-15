import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Ledger } from '../../server/core/ledger.js';
import { Devices } from '../../server/policy/trust.js';

const db = new Ledger(join(process.env.OUTPOST_DATA ?? '/home/node/.outpost','ledger.sqlite'));
assert.ok(db.list('device').some(device => !device.data.revoked),'Pair the actual owner app before verification');
const keys = generateKeyPairSync('ed25519');
const deviceId = randomUUID(), taskId = randomUUID();
const devices = new Devices(db);
devices.pair(deviceId,'Temporary integration verifier',keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64'));
async function command(type: string, revision: number, payload: Record<string,unknown>) {
  const body = Buffer.from(JSON.stringify({ protocolVersion: 1,deviceId,issuedAt: Date.now(),commandId: randomUUID(),idempotencyKey: randomUUID(),aggregateId: taskId,expectedRevision: revision,type,payload }));
  const response = await fetch('http://127.0.0.1:4318/v1/commands',{ method: 'POST',headers: { 'content-type': 'application/json','x-outpost-signature': sign(null,body,keys.privateKey).toString('base64') },body });
  assert.ok(response.ok,await response.text());
}
try {
  await command('task.create',0,{
    profile: 'operations',mode: 'full_control',
    goal: 'Integration verification only. Perform these real actions through outpost_action, then summarize the observed evidence. 1. file.write: create integration-check.txt containing exactly OUTPOST_WORKSPACE_OK with expectedHash null. 2. command.run: argv ["/bin/bash","-lc","pwd; cat integration-check.txt"], cwd ".". 3. host.execute on surajhomeserver with command "id -u; hostname". 4. host.execute on surajhomeserver2 with command "id -u; hostname". 5. browser.open with url https://example.com, then browser.capture. Report the observed title and heading. Do not visit other sites or submit forms. Do not install, restart, deploy or change any other files or services. Do not claim success for failed actions.',
  });
  console.log(`Real signed-API integration task: ${taskId}`);
  const deadline = Date.now()+420000;
  let settled = false;
  while (Date.now() < deadline) {
    const task = db.need('task',taskId);
    if (['verifying','interrupted','waiting_for_approval','waiting_for_capacity'].includes(String(task.data.state))) { settled = true; break; }
    await new Promise(resolve => setTimeout(resolve,2000));
  }
  assert.ok(settled,'Timed out waiting for live Pi execution');
  const task = db.need('task',taskId);
  const actions = db.list('action').filter(action => action.data.taskId === taskId);
  console.log(JSON.stringify({ taskId,state: task.data.state,blocker: task.data.blocker,actions: actions.map(action => ({ tool: action.data.tool,state: action.data.state,result: action.data.result })) },null,2));
  assert.equal(task.data.state,'verifying');
  assert.equal(readFileSync(join(process.env.OUTPOST_DATA ?? '/home/node/.outpost','workspaces',taskId,'integration-check.txt'),'utf8').trim(),'OUTPOST_WORKSPACE_OK');
  const commandResult = z.object({ exitCode: z.literal(0),stdout: z.string() }).parse(actions.find(action => action.data.tool === 'command.run' && action.data.state === 'succeeded')?.data.result);
  assert.ok(commandResult.stdout.includes('OUTPOST_WORKSPACE_OK'));
  const hostResults = actions.filter(action => action.data.tool === 'host.execute' && action.data.state === 'succeeded').map(action => z.object({ exitCode: z.literal(0),host: z.string(),stdout: z.string(),timedOut: z.literal(false) }).parse(action.data.result));
  for (const host of ['surajhomeserver','surajhomeserver2']) assert.ok(hostResults.some(result => result.host === host && result.stdout.trim() === `0\n${host}`));
  const browser = z.object({ title: z.string(), url: z.string() }).parse(actions.find(action => action.data.tool === 'browser.open' && action.data.state === 'succeeded')?.data.result);
  assert.equal(new URL(browser.url).hostname, 'example.com');
  assert.equal(browser.title, 'Example Domain');
  const capture = z.object({ artifactIds: z.array(z.string()).min(1) }).parse(actions.find(action => action.data.tool === 'browser.capture' && action.data.state === 'succeeded')?.data.result);
  for (const artifactId of capture.artifactIds) assert.equal(db.need('artifact',artifactId).data.taskId,taskId);
  console.log('Signed API → Pi SDK → workspace files/commands → both root executors → direct Camoufox browser: PASSED');
} finally {
  const task = db.get('task',taskId);
  if (task && task.data.state === 'running') await command('task.cancel',task.revision,{}).catch(() => {});
  const device = db.need('device',deviceId);
  devices.revoke(deviceId,device.revision);
  db.close();
}
