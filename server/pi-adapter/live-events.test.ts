import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../core/ledger.js';
import { LiveFeed } from '../gateway/live.js';
import { liveEvents } from './live-events.js';

test('live projections exclude redacted reasoning and opaque signatures, and finalize once',() => {
  const db = new Ledger(), feed = new LiveFeed(db), consume = liveEvents(feed,'task','session','fixture');
  const event: AgentSessionEvent = { type: 'message_start',message: {
    role: 'assistant',api: 'openai-completions',provider: 'outpost-ollama',model: 'fixture',timestamp: 1,stopReason: 'pending',
    usage: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,totalTokens: 0,cost: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,total: 0 } },
    content: [{ type: 'thinking',thinking: 'redacted-secret',thinkingSignature: 'opaque-secret',redacted: true },{ type: 'thinking',thinking: 'provider-visible',thinkingSignature: 'opaque-replay' },{ type: 'text',text: 'answer' }],
  } };
  try {
    consume(event);
    const wire = JSON.stringify(feed.snapshot());
    assert.match(wire,/provider-visible/); assert.doesNotMatch(wire,/redacted-secret|opaque-secret|opaque-replay/);
    consume({ type: 'message_end',message: event.message });
    assert.equal(feed.snapshot().length,0);
    assert.equal(db.list('message').length,1);
    assert.equal(db.list('message')[0]?.data.streaming,false);
  } finally { db.close(); }
});
