import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiProfile } from './profile.js';

test('legacy Ollama migration is additive, exact, idempotent and refuses endpoint conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-migration-')), profile = new PiProfile(root);
  try {
    const auth = '{"fixture":{"type":"api_key","key":"unrelated-fixture-secret"}}';
    writeFileSync(join(root,'auth.json'),auth,{mode:0o600});
    writeFileSync(join(root,'settings.json'),'{"theme":"light"}',{mode:0o600});
    const configuration = { providerId:'outpost-ollama',baseUrl:'http://127.0.0.1:11434/v1',api:'openai-completions',models:[{id:'exact/model:cloud',name:'Exact',contextWindow:32768,maxTokens:4096,input:['text','image']}] };
    await profile.migrateLegacyOllama(configuration,'exact/model:cloud');
    const first = readFileSync(join(root,'models.json'),'utf8');
    await profile.migrateLegacyOllama(configuration,'exact/model:cloud');
    assert.equal(readFileSync(join(root,'models.json'),'utf8'),first);
    assert.equal(readFileSync(join(root,'auth.json'),'utf8'),auth);
    const settings = JSON.parse(readFileSync(join(root,'settings.json'),'utf8'));
    assert.equal(settings.theme,'light'); assert.equal(settings.defaultProvider,'outpost-ollama'); assert.equal(settings.defaultModel,'exact/model:cloud');
    const models = await (await profile.runtime()).getAvailable('outpost-ollama');
    assert.equal(models[0]?.id,'exact/model:cloud');
    await assert.rejects(profile.migrateLegacyOllama({...configuration,baseUrl:'https://other.test/v1'},'exact/model:cloud'),/conflict/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
