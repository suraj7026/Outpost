import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrowserWorker } from './browser-use.js';

test('browser subprocess validates results and reports failures without inventing success',async () => {
  const directory = mkdtempSync(join(tmpdir(),'outpost-browser-worker-'));
  const fixture = (name: string, code: string) => { const path = join(directory,name); writeFileSync(path,`#!${process.execPath}\n${code}`,{ mode: 0o700 }); return path; };
  try {
    const valid = fixture('valid',`process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({done:true,agent_reported_success:true,result:'observed',urls:['https://example.com'],errors:[],screenshots:[],steps:1,duration_seconds:0.1})));`);
    assert.equal((await runBrowserWorker(valid,{},new AbortController().signal)).result,'observed');
    const invalid = fixture('invalid',`console.log(JSON.stringify({success:true}));`);
    await assert.rejects(runBrowserWorker(invalid,{},new AbortController().signal));
    const failed = fixture('failed',`console.error('fixture browser could not start'); process.exit(4);`);
    await assert.rejects(runBrowserWorker(failed,{},new AbortController().signal),/fixture browser could not start/);
    await assert.rejects(runBrowserWorker(join(directory,'missing'),{},new AbortController().signal),/ENOENT/);
    const sleeping = fixture('sleeping',`process.stdin.resume(); setInterval(()=>{},1000);`), controller = new AbortController();
    const execution = runBrowserWorker(sleeping,{},controller.signal); setTimeout(() => controller.abort(),50);
    await assert.rejects(execution,/Browser worker stopped/);
  } finally { rmSync(directory,{ recursive: true,force: true }); }
});
