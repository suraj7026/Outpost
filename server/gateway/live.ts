import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Data, RecordValue } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';

/** Live projections are replaceable snapshots, not commands or replayable effects. */
export class LiveFeed {
  private records = new Map<string,RecordValue>();
  private timers = new Map<string,ReturnType<typeof setTimeout>>();
  private checkpoints = new Map<string,number>();
  private events = new EventEmitter();
  private connections = new Map<string,number>();
  private responses = new Set<ServerResponse>();
  close() { for (const response of this.responses) response.end(); }
  constructor(private db: Ledger) { this.events.setMaxListeners(32); }
  snapshot() { return [...this.records.values()]; }
  subscribe(listener: (frame: unknown) => void) { this.events.on('frame',listener); return () => this.events.off('frame',listener); }
  publish(kind: string, id: string, data: Data) {
    const key = `${kind}:${id}`, previous = this.records.get(key);
    let record: RecordValue = { kind,id,revision: previous?.revision ?? 0,updatedAt: previous?.updatedAt ?? new Date().toISOString(),data: { ...data,streaming: true } };
    if (Date.now()-(this.checkpoints.get(key) ?? 0) >= 2000) {
      const saved = this.db.get(kind,id);
      record = this.db.put(kind,id,saved?.revision ?? 0,record.data);
      this.checkpoints.set(key,Date.now());
    }
    this.records.set(key,record);
    if (!previous) this.events.emit('frame',{ type: 'live',record });
    else if (!this.timers.has(key)) this.timers.set(key,setTimeout(() => {
      this.timers.delete(key);
      const current = this.records.get(key);
      if (current) this.events.emit('frame',{ type: 'live',record: current });
    },50));
  }
  finish(kind: string, id: string, data: Data) {
    const key = `${kind}:${id}`;
    clearTimeout(this.timers.get(key)); this.timers.delete(key); this.checkpoints.delete(key);
    const previous = this.db.get(kind,id);
    const record = this.db.put(kind,id,previous?.revision ?? 0,{ ...data,streaming: false });
    this.records.delete(key);
    this.events.emit('frame',{ type: 'settled',record });
    return record;
  }
  interrupt(taskId: string) {
    for (const record of this.snapshot()) if (record.data.taskId === taskId) this.finish(record.kind,record.id,{ ...record.data,interrupted: true });
  }
  /** Signed POST stream. Reconnection sends a fresh snapshot, never reruns work. */
  serve(response: ServerResponse, deviceId: string, kinds: string[]) {
    const count = this.connections.get(deviceId) ?? 0;
    if (count >= 4) { response.writeHead(429); response.end(JSON.stringify({ message: 'Too many live connections' })); return; }
    this.connections.set(deviceId,count+1); this.responses.add(response);
    response.writeHead(200,{ 'content-type': 'text/event-stream; charset=utf-8','cache-control': 'no-store','x-accel-buffering': 'no' });
    response.flushHeaders();
    let closed = false;
    const send = (frame: unknown) => {
      if (closed || response.writableEnded || response.destroyed) return;
      if (response.writableLength > 2*1024*1024) { response.destroy(); return; }
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    const snapshot = this.db.snapshot(kinds); let cursor = snapshot.cursor;
    send({ type: 'snapshot',...snapshot,live: this.snapshot() });
    const unsubscribe = this.subscribe(send);
    const tick = setInterval(() => {
      if (response.writableEnded || response.destroyed) return;
      if (this.db.get('device',deviceId)?.data.revoked !== false) { response.end(); return; }
      const events = this.db.events(cursor,200);
      if (events.length) {
        cursor = events.at(-1)!.feedCursor;
        const records = events.map(event => z.object({ kind: z.string() }).passthrough().parse(event.payload)).filter(record => kinds.includes(record.kind));
        if (records.length) send({ type: 'records',records,cursor });
      }
    },50);
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }),10000);
    const lifetime = setTimeout(() => response.end(),60000);
    response.once('error',() => response.destroy());
    response.once('close',() => {
      closed = true; this.responses.delete(response); clearInterval(tick); clearInterval(heartbeat); clearTimeout(lifetime); unsubscribe();
      const remaining = (this.connections.get(deviceId) ?? 1)-1;
      if (remaining) this.connections.set(deviceId,remaining); else this.connections.delete(deviceId);
    });
  }
}
