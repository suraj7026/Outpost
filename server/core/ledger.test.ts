import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.js';
import { Fault, canonical, digest, formatErrorForLog, id } from './contracts.js';
import type { Command } from './contracts.js';

test('canonical contracts reject non-JSON and hash order independently', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonical({ a: undefined })); assert.throws(() => canonical(NaN));
});

test('acceptance, record, event and outbox commit atomically with replay-safe keys', () => {
  const db = new Ledger();
  const cmd: Command = { protocolVersion: 1, commandId: id(), deviceId: id(), idempotencyKey: 'one', type: 'task.create', aggregateId: id(), expectedRevision: 0, payload: { title: 'Test' }, issuedAt: Date.now() };
  const apply = () => { db.put('task',cmd.aggregateId,0,cmd.payload); db.enqueue('run',cmd.payload); return { accepted: true }; };
  assert.deepEqual(db.accept(cmd,apply), db.accept(cmd,apply));
  assert.equal(db.events().length,1);
  assert.throws(() => db.accept({ ...cmd,payload: { title: 'Different' } },apply), /idempotency_conflict/);
  assert.throws(() => db.transaction(() => { db.put('task',id(),0,{}); throw Error('crash'); }));
  assert.equal(db.events().length,1);
  assert.throws(() => db.put('task',cmd.aggregateId,0,{}),/stale_revision/);
  db.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'fixture_event_failure'); END");
  assert.throws(() => db.put('task','atomic',0,{}),/fixture_event_failure/);
  assert.equal(db.get('task','atomic'),undefined);
  db.db.exec('DROP TRIGGER reject_event');
  assert.deepEqual(db.events(1),[]);
  assert.throws(() => db.events(2),/invalid_cursor/);
  db.close();
});

test('Ledger.list() executes exactly 1 SQLite statement regardless of row count and uses records_kind_updated index', t => {
  const db = new Ledger();
  try {
    const plan = db.db.prepare('EXPLAIN QUERY PLAN SELECT id, revision, data, updated_at FROM records WHERE kind=? ORDER BY updated_at DESC, id').all('task');
    const detail = plan.map(row => String(row.detail)).join(' | ');
    assert.match(detail, /records_kind_updated/);
    assert.doesNotMatch(detail, /TEMP B-TREE/i);

    const prepareSpy = t.mock.method(db.db, 'prepare');

    // 0 rows
    assert.deepEqual(db.list('task'), []);
    assert.equal(prepareSpy.mock.callCount(), 1);

    // 1 row
    prepareSpy.mock.resetCalls();
    db.put('task', 't-only', 0, { n: 1 });
    prepareSpy.mock.resetCalls();
    const one = db.list<{ n: number }>('task');
    assert.equal(prepareSpy.mock.callCount(), 1);
    assert.equal(one.length, 1);
    assert.deepEqual(one[0]!.data, { n: 1 });

    // 50 rows (+ unrelated kind) with explicit timestamps to verify updated_at DESC, id ASC ordering
    db.put('other', 'o-1', 0, { other: true });
    for (let i = 0; i < 49; i++) {
      db.put('task', `t-${String(i).padStart(2, '0')}`, 0, { index: i });
    }
    // Pin deterministic timestamps: two tied newest timestamps to verify secondary `id ASC` tie-breaker
    db.db.prepare("UPDATE records SET updated_at='2026-11-20T12:00:00.000Z' WHERE kind='task' AND id IN ('t-02','t-10')").run();
    db.db.prepare("UPDATE records SET updated_at='2026-11-19T12:00:00.000Z' WHERE kind='task' AND id NOT IN ('t-02','t-10')").run();

    prepareSpy.mock.resetCalls();
    const many = db.list<{ index?: number; n?: number }>('task');
    assert.equal(prepareSpy.mock.callCount(), 1);
    assert.equal(many.length, 50);
    assert.equal(many[0]!.id, 't-02');
    assert.equal(many[1]!.id, 't-10');
    assert.equal(many[0]!.kind, 'task');
    assert.equal(many[0]!.revision, 1);
    assert.equal(many[0]!.updatedAt, '2026-11-20T12:00:00.000Z');
    assert.deepEqual(many[0]!.data, { index: 2 });
  } finally {
    db.close();
  }
});

test('Ledger.compact() deletes aged done outbox rows without touching pending, claimed, unknown, or recent done rows', () => {
  const db = new Ledger();
  try {
    const nowMs = Date.parse('2026-11-20T12:00:00.000Z');
    const oldTs = '2026-11-10T12:00:00.000Z'; // 10 days old
    const recentTs = '2026-11-18T12:00:00.000Z'; // 2 days old
    const fixtures = [
      { key: 'done-old', state: 'done', createdAt: oldTs },
      { key: 'done-recent', state: 'done', createdAt: recentTs },
      { key: 'pending-old', state: 'pending', createdAt: oldTs },
      { key: 'claimed-old', state: 'claimed', createdAt: oldTs },
      { key: 'unknown-old', state: 'unknown', createdAt: oldTs },
    ];
    for (const item of fixtures) {
      db.enqueue('task.run', { key: item.key }, item.key);
      db.db.prepare('UPDATE outbox SET state=?, created_at=? WHERE id=?').run(item.state, item.createdAt, item.key);
    }

    const result = db.compact({ retainDoneOutboxMs: 7 * 24 * 60 * 60 * 1000, nowMs });
    assert.equal(result.deletedOutbox, 1);
    assert.equal(result.deletedEvents, 0);

    const remaining = db.db.prepare('SELECT id, state FROM outbox ORDER BY id').all();
    assert.deepEqual(
      remaining.map(row => ({ id: String(row.id), state: String(row.state) })),
      [
        { id: 'claimed-old', state: 'claimed' },
        { id: 'done-recent', state: 'done' },
        { id: 'pending-old', state: 'pending' },
        { id: 'unknown-old', state: 'unknown' },
      ],
    );
  } finally {
    db.close();
  }
});

test('Ledger.compact() trims oldest events while preserving cursor monotonicity and validation', () => {
  const db = new Ledger();
  try {
    for (let i = 1; i <= 25; i++) db.put('task', `t-${i}`, 0, { i });
    assert.equal(db.cursor(), 25);

    const first = db.compact({ retainEventsCount: 5 });
    assert.equal(first.deletedEvents, 20);
    assert.equal(db.cursor(), 25);
    assert.deepEqual(db.events(25), []);
    assert.deepEqual(db.events(20).map(e => e.feedCursor), [21, 22, 23, 24, 25]);

    // Next write still advances monotonically past 25
    db.put('task', 't-26', 0, { i: 26 });
    assert.equal(db.cursor(), 26);

    // Compaction is a no-op when count is already within retention window
    const second = db.compact({ retainEventsCount: 10 });
    assert.equal(second.deletedEvents, 0);

    // Invalid retention options fail closed
    assert.throws(() => db.compact({ retainDoneOutboxMs: -1 }), /invalid_retention/);
    assert.throws(() => db.compact({ retainDoneOutboxMs: Number.NaN }), /invalid_retention/);
    assert.throws(() => db.compact({ retainEventsCount: 0 }), /invalid_retention/);
    assert.throws(() => db.compact({ retainEventsCount: -5 }), /invalid_retention/);
    assert.throws(() => db.compact({ retainEventsCount: 1.5 }), /invalid_retention/);
  } finally {
    db.close();
  }
});

test('formatErrorForLog() emits Fault codes and redacts bearer tokens, keys, URLs and PEM blocks', () => {
  assert.equal(formatErrorForLog(new Fault('maintenance_in_progress', 'Bearer super-secret')), 'maintenance_in_progress');
  const err = new Error(
    'Request failed Authorization: Bearer tok_live_abc123; key=sk-secretkey123456; ' +
    'ghp_MyGitHubSecret999; token="quoted-secret"; api_key=rawSecret; ' +
    'url=https://user:pass123@example.com/v1; jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345',
  );
  const formatted = formatErrorForLog(err);
  assert.ok(formatted.includes('Request failed'));
  for (const leak of ['tok_live_abc123', 'sk-secretkey123456', 'ghp_MyGitHubSecret999', 'quoted-secret', 'rawSecret', 'pass123', 'sig12345']) {
    assert.ok(!formatted.includes(leak), `expected ${leak} to be redacted in: ${formatted}`);
  }
  const pem = formatErrorForLog('bad key:\n-----BEGIN PRIVATE KEY-----\nMIIEowIBAAK\n-----END PRIVATE KEY-----\nBasic dXNlcjpwYXNz');
  assert.ok(!pem.includes('MIIEowIBAAK'));
  assert.ok(!pem.includes('dXNlcjpwYXNz'));
  assert.ok(!pem.includes('\n'));
});
