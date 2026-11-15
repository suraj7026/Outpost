import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostExecutor, executorConfiguration } from './host-executor.mjs';

const token = 'fixture-token-that-is-at-least-32-characters';
test('native executor is loopback-only and supports protected token files without changing legacy mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-executor-'));
  try {
    const file = join(root, 'token'); writeFileSync(file, token + '\n', { mode: 0o600 });
    assert.deepEqual(executorConfiguration({ OUTPOST_HOST_MODE: 'native', OUTPOST_HOST_TOKEN_FILE: file }),
      { token, host: 'local', mode: 'native', port: 4519, address: '127.0.0.1' });
    const legacy = executorConfiguration({ OUTPOST_HOST_TOKEN: token });
    assert.equal(legacy.mode, 'namespace'); assert.equal(legacy.port, 4319);
    assert.throws(() => executorConfiguration({ OUTPOST_HOST_MODE: 'wrong' }));
    assert.throws(() => executorConfiguration({ OUTPOST_HOST_PORT: '0' }));
    assert.throws(() => createHostExecutor({ token: 'short', host: 'local', mode: 'native' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('authenticated native execution runs locally without leaking tokens, bounds output and cancels', async () => {
  // This fixture runs as the test user, never elevates or touches host services.
  const server = createHostExecutor({ token, host: 'local', mode: 'native' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/execute`;
  const run = (command, timeoutMs = 3000, authorization = `Bearer ${token}`) => fetch(endpoint, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ command, timeoutMs, taskId: randomUUID() }),
  });
  try {
    assert.equal((await run('printf must-not-run', 3000, 'Bearer wrong')).status, 401);
    assert.equal((await run('printf no', 1)).status, 400);
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await run('invalid\0command')).status, 400);
    process.env.OUTPOST_EXECUTOR_TEST_SECRET = 'must-not-leak';
    const success = await (await run('printf "%s:%s:%s" "$OUTPOST_EXECUTOR_TEST_SECRET" "$OUTPOST_HOST_TOKEN" "$OUTPOST_HOST_TOKEN_FILE"; /usr/bin/id -u')).json();
    assert.equal(success.exitCode, 0); assert.equal(success.host, 'local');
    assert.equal(success.stdout, `::${process.getuid()}\n`);
    const timeout = await (await run('sleep 10', 100)).json();
    assert.equal(timeout.timedOut, true);
    const large = await (await run('yes output', 3000)).json();
    assert.equal(large.outputLimitReached, true);
    assert.ok(Buffer.byteLength(large.stdout) <= 2 * 1024 * 1024);
    const failed = await (await run('exit 17')).json();
    assert.equal(failed.exitCode, 17);
  } finally {
    delete process.env.OUTPOST_EXECUTOR_TEST_SECRET;
    await new Promise(resolve => server.close(resolve));
  }
});
