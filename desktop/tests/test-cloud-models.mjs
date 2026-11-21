import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ollamaCloudModels, preferredCloudModel } from '../src/models.ts';

test('only advertised Ollama cloud tags are listed, retaining exact identifiers', () => {
  assert.deepEqual(ollamaCloudModels([
    'glm-5.3-flash:cloud', 'local:latest', 'gpt-oss:120b-cloud',
    'qwen3-coder:480b-cloud', 'custom-cloud:latest', 'glm-5.3-flash:cloud',
  ]), ['glm-5.3-flash:cloud', 'gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud']);
});

test('an empty or local-only catalogue never falls back to a local default', () => {
  assert.deepEqual(ollamaCloudModels(['local:latest']), []);
  assert.equal(preferredCloudModel([], '', 'local:latest'), '');
  assert.equal(preferredCloudModel([], 'missing:cloud', 'missing:cloud'), '');
});

test('selection must still be advertised; valid selection wins over server default', () => {
  const available = ['first:cloud', 'second:cloud'];
  assert.equal(preferredCloudModel(available, 'second:cloud', 'first:cloud'), 'second:cloud');
  assert.equal(preferredCloudModel(available, 'removed:cloud', 'second:cloud'), 'second:cloud');
  assert.equal(preferredCloudModel(available, '', 'local:latest'), 'first:cloud');
});
