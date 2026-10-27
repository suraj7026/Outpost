import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from './runner.js';

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
