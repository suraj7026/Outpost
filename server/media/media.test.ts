import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../artifacts/files.js';
import { MediaTools } from './media.js';
test('media jobs reject out-of-scope paths and invalid duration before launching a converter',async () => {
  const root = mkdtempSync(join(tmpdir(),'outpost-media-'));
  try {
    const tools = new MediaTools(new Workspace(root),'/usr/bin/ffmpeg','/usr/bin/ffprobe');
    await assert.rejects(tools.audioClip('../secret','clip.wav',0,10),/path_escape/);
    await assert.rejects(tools.audioClip('source.wav','clip.wav',-1,10),/invalid_clip/);
    await assert.rejects(tools.audioClip('source.wav','clip.wav',0,Infinity),/invalid_clip/);
  } finally { rmSync(root,{ recursive: true,force: true }); }
});
