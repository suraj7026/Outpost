import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import type { Task } from '../tasks/tasks.js';
import type { Action, Gate } from '../policy/trust.js';
import type { WorkerClient } from '../pi-worker/client.js';
import { Coordinator } from './coordinator.js';

type CoordinatorInternals = {
  gates: Map<string, Gate>;
  runtimes: Map<string, { isActive(taskId: string): boolean; abort(taskId: string): Promise<void> }>;
  runtimeJobs: Set<Promise<void>>;
};
const internals = (coordinator: Coordinator) => coordinator as unknown as CoordinatorInternals;

function command(deviceId: string, type: string, aggregateId: string, expectedRevision: number, payload: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    commandId: id(),
    idempotencyKey: id(),
    deviceId,
    issuedAt: Date.now(),
    type,
    aggregateId,
    expectedRevision,
    payload,
  };
}

test('Coordinator evicts gates and runtimes when a task is cancelled (idle and after active runtime settles)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-coord-cancel-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const deviceId = id();
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
  let activeRun: { runId: string; taskId: string; model: { providerId: string; modelId: string }; aborted: boolean; settled: boolean } | undefined;
  let startedRun!: () => void;
  const runStarted = new Promise<void>(resolve => { startedRun = resolve; });

  const worker = {
    request: async (packet: Record<string, unknown>) => {
      if (packet.type === 'run.start') {
        activeRun = {
          runId: String(packet.runId),
          taskId: String(packet.taskId),
          model: packet.model as { providerId: string; modelId: string },
          aborted: false,
          settled: false,
        };
        startedRun();
        return { ok: true };
      }
      if (packet.type === 'run.abort') {
        await abortGate;
        if (activeRun && activeRun.runId === packet.runId) {
          activeRun.aborted = true;
          activeRun.settled = true;
        }
        return { ok: true };
      }
      if (packet.type === 'run.poll') {
        assert.ok(activeRun);
        return {
          runId: activeRun.runId,
          taskId: activeRun.taskId,
          model: activeRun.model,
          state: activeRun.aborted ? 'cancelled' : 'running',
          session: null,
          cursor: 0,
          hasMore: false,
          projections: [],
          actions: [],
          error: null,
          settled: activeRun.settled,
          needsAttention: false,
        };
      }
      throw new Error(`unexpected worker packet ${String(packet.type)}`);
    },
  } as unknown as WorkerClient;

  const coordinator = new Coordinator(db, root, { worker });
  try {
    // 1) Idle task with cached gate -> task.cancel evicts immediately
    const idleTaskId = id();
    coordinator.command(command(deviceId, 'task.create', idleTaskId, 0, { goal: 'Idle cancel', profile: 'code' }));
    coordinator.gate(idleTaskId);
    assert.equal(internals(coordinator).gates.size, 1);

    const idleTask = db.need<Task>('task', idleTaskId);
    coordinator.command(command(deviceId, 'task.cancel', idleTaskId, idleTask.revision));
    assert.equal(internals(coordinator).gates.size, 0);
    assert.equal(internals(coordinator).runtimes.size, 0);

    // Re-inspecting a cancelled task recreates Gate idempotently, and next drain evicts it again
    const tools = coordinator.query('tools', { taskId: idleTaskId });
    assert.ok(Array.isArray(tools) && tools.length > 0);
    assert.equal(internals(coordinator).gates.size, 1);
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 0);

    // 2) Active runtime task -> NOT evicted while runtime is active, evicted once settled
    const activeTaskId = id();
    coordinator.command(command(deviceId, 'task.create', activeTaskId, 0, {
      goal: 'Active cancel',
      profile: 'code',
      modelRef: { providerId: 'fixture', modelId: 'test-model' },
    }));
    await coordinator.drain();
    await runStarted;
    assert.equal(internals(coordinator).gates.size, 1);
    assert.equal(internals(coordinator).runtimes.size, 1);
    assert.equal(internals(coordinator).runtimes.get(activeTaskId)!.isActive(activeTaskId), true);

    const runningTask = db.need<Task>('task', activeTaskId);
    coordinator.command(command(deviceId, 'task.cancel', activeTaskId, runningTask.revision));
    // Runtime is still active waiting on abortGate -> must NOT evict prematurely
    assert.equal(internals(coordinator).gates.size, 1);
    assert.equal(internals(coordinator).runtimes.size, 1);

    // Release abort and wait for runtimeJobs to settle
    releaseAbort();
    await Promise.allSettled([...internals(coordinator).runtimeJobs]);
    assert.equal(internals(coordinator).gates.size, 0);
    assert.equal(internals(coordinator).runtimes.size, 0);
  } finally {
    await coordinator.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Coordinator evicts gates and runtimes when a task completes and preserves non-terminal tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-coord-complete-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const deviceId = id();
  let lastRun: { runId: string; taskId: string; model: { providerId: string; modelId: string } } | undefined;

  const worker = {
    request: async (packet: Record<string, unknown>) => {
      if (packet.type === 'run.start') {
        lastRun = {
          runId: String(packet.runId),
          taskId: String(packet.taskId),
          model: packet.model as { providerId: string; modelId: string },
        };
        return { ok: true };
      }
      if (packet.type === 'run.poll') {
        assert.ok(lastRun);
        return {
          runId: lastRun.runId,
          taskId: lastRun.taskId,
          model: lastRun.model,
          state: 'finished',
          session: null,
          cursor: 0,
          hasMore: false,
          projections: [],
          actions: [],
          error: null,
          settled: true,
          needsAttention: false,
        };
      }
      return { ok: true };
    },
  } as unknown as WorkerClient;

  const coordinator = new Coordinator(db, root, { worker });
  try {
    const taskId = id();
    coordinator.command(command(deviceId, 'task.create', taskId, 0, {
      goal: 'Complete cleanly',
      profile: 'code',
      modelRef: { providerId: 'fixture', modelId: 'test-model' },
    }));
    await coordinator.drain();
    await Promise.allSettled([...internals(coordinator).runtimeJobs]);

    // Task is now in verifying (non-terminal): gates and runtimes remain cached
    const verifying = db.need<Task>('task', taskId);
    assert.equal(verifying.data.state, 'verifying');
    assert.equal(internals(coordinator).gates.size, 1);
    assert.equal(internals(coordinator).runtimes.size, 1);
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 1);
    assert.equal(internals(coordinator).runtimes.size, 1);

    // Non-terminal paused task also stays cached
    coordinator.command(command(deviceId, 'task.pause', taskId, verifying.revision));
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 1);
    assert.equal(internals(coordinator).runtimes.size, 1);

    // Transition task to completed -> drain evicts both gate and runtime
    const paused = db.need<Task>('task', taskId);
    db.put<Task>('task', taskId, paused.revision, { ...paused.data, state: 'completed', blocker: null }, 'task.completed');
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 0);
    assert.equal(internals(coordinator).runtimes.size, 0);
  } finally {
    await coordinator.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Coordinator defers eviction while a terminal task still has pending or dispatching actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-coord-actions-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const deviceId = id();
  const coordinator = new Coordinator(db, root);
  try {
    const taskId = id();
    coordinator.command(command(deviceId, 'task.create', taskId, 0, {
      goal: 'Wait for action settlement',
      profile: 'code',
      mode: 'auto',
    }));
    await coordinator.drain();

    // Propose a non-routine action in auto mode so it enters `pending` state
    const gate = coordinator.gate(taskId);
    const pendingAction = await gate.propose(taskId, 'document.report', { summary: 'draft' });
    assert.equal(pendingAction.data.state, 'pending');
    assert.equal(internals(coordinator).gates.size, 1);

    // Mark task completed while the action is still pending -> must NOT evict
    const task = db.need<Task>('task', taskId);
    db.put<Task>('task', taskId, task.revision, { ...task.data, state: 'completed', blocker: null }, 'task.completed');
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 1);

    // Move action to dispatching -> still must NOT evict
    const act1 = db.need<Action>('action', pendingAction.id);
    db.put<Action>('action', act1.id, act1.revision, { ...act1.data, state: 'dispatching' });
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 1);

    // Settle action to succeeded -> now drain evicts gate
    const act2 = db.need<Action>('action', pendingAction.id);
    db.put<Action>('action', act2.id, act2.revision, { ...act2.data, state: 'succeeded' });
    await coordinator.drain();
    assert.equal(internals(coordinator).gates.size, 0);
    assert.equal(internals(coordinator).runtimes.size, 0);
  } finally {
    await coordinator.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Coordinator retains runtime fence when aborted remote runtime reports needsAttention', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-coord-attention-'));
  const db = new Ledger(join(root, 'ledger.sqlite'));
  const deviceId = id();
  let activeRun: { runId: string; taskId: string; model: { providerId: string; modelId: string }; aborted: boolean } | undefined;
  let startedRun!: () => void;
  const runStarted = new Promise<void>(resolve => { startedRun = resolve; });

  const worker = {
    request: async (packet: Record<string, unknown>) => {
      if (packet.type === 'run.start') {
        activeRun = {
          runId: String(packet.runId),
          taskId: String(packet.taskId),
          model: packet.model as { providerId: string; modelId: string },
          aborted: false,
        };
        startedRun();
        return { ok: true };
      }
      if (packet.type === 'run.abort') {
        if (activeRun) activeRun.aborted = true;
        return { ok: true };
      }
      if (packet.type === 'run.poll') {
        assert.ok(activeRun);
        return {
          runId: activeRun.runId,
          taskId: activeRun.taskId,
          model: activeRun.model,
          state: activeRun.aborted ? 'cancelled' : 'running',
          session: null,
          cursor: 0,
          hasMore: false,
          projections: [],
          actions: [],
          error: null,
          settled: false,
          needsAttention: activeRun.aborted,
        };
      }
      return { ok: true };
    },
  } as unknown as WorkerClient;

  const coordinator = new Coordinator(db, root, { worker });
  try {
    const taskId = id();
    coordinator.command(command(deviceId, 'task.create', taskId, 0, {
      goal: 'Attention fence',
      profile: 'code',
      modelRef: { providerId: 'fixture', modelId: 'test-model' },
    }));
    await coordinator.drain();
    await runStarted;

    const task = db.need<Task>('task', taskId);
    coordinator.command(command(deviceId, 'task.cancel', taskId, task.revision));
    await Promise.allSettled([...internals(coordinator).runtimeJobs]);
    await coordinator.drain();

    // Runtime reports needsAttention -> isActive() stays true -> fence must NOT be evicted
    assert.equal(internals(coordinator).runtimes.size, 1);
    assert.equal(internals(coordinator).gates.size, 1);
  } finally {
    await coordinator.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
