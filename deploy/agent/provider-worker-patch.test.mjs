import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerWorkerPatch } from './provider-worker-patch.mjs';

test('worker mounts only source subset, dependencies, profile, sessions and workspaces; no coordinator secrets or shared process namespace', () => {
  const spec = providerWorkerPatch('fixture-release').spec.template.spec;
  assert.equal(spec.shareProcessNamespace, false);
  const worker = spec.containers.find(c => c.name === 'pi-worker');
  assert.equal(worker.securityContext.runAsNonRoot, true);
  assert.equal(worker.securityContext.readOnlyRootFilesystem, true);
  assert.equal(worker.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(worker.securityContext.capabilities.drop, ['ALL']);
  for (const mount of worker.volumeMounts.filter(m => m.name === 'home')) {
    assert.ok(mount.subPath);
    assert.ok(!['/home/node','/home/node/.outpost','/opt/outpost'].includes(mount.mountPath));
    assert.ok(!mount.subPath.includes('ledger') && !mount.subPath.endsWith('/server'));
  }
  assert.ok(worker.volumeMounts.find(m => m.mountPath === '/opt/outpost/server').subPath.endsWith('/worker-server'));
  assert.ok(!worker.env.some(e => /HOST_TOKEN|PAIRING|APNS/.test(e.name)));
  assert.equal(spec.containers.find(c => c.name === 'coordinator').workingDir, '/opt/outpost');
  assert.ok(spec.containers.find(c => c.name === 'workspace').volumeMounts.some(m => m.mountPath === '/opt/outpost' && m.readOnly));
  assert.throws(() => providerWorkerPatch('../escape'));
});
