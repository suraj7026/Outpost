import { Ledger } from '../core/ledger.js';
import { id, requireThat } from '../core/contracts.js';
export async function probeHealth(url: string, enrolledURLs: Set<string>, expectedStatus = 200) {
  requireThat(enrolledURLs.has(url),'health_target_not_enrolled');
  const start = Date.now();
  try {
    const response = await fetch(url,{ redirect: 'error',signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return { url,healthy: response.status === expectedStatus,status: response.status,latencyMs: Date.now()-start,observedAt: Date.now() };
  } catch { return { url,healthy: false,status: null,latencyMs: Date.now()-start,observedAt: Date.now() }; }
}
export async function verifyRollout(db: Ledger, deploymentId: string, revision: string, probe: () => Promise<{ healthy: boolean }>, rollback: () => Promise<void>) {
  const result = await probe();
  if (result.healthy) return db.put('deployment_evidence',id(),0,{ deploymentId,revision,state: 'verified',result });
  await rollback();
  const restored = await probe();
  return db.put('deployment_evidence',id(),0,{ deploymentId,revision,state: restored.healthy ? 'rolled_back_verified' : 'recovery_required',result,restored });
}
