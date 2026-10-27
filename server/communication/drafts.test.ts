import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { prepareMail, calendarProposal } from './drafts.js';
test('drafts bind recipient and attachment while calendar distinguishes private reminders',() => {
  const db = new Ledger(); const input = { taskId: 'task',identityId: 'agent-mail',to: ['owner@example.com'],subject: 'Report',body: 'Draft',attachments: [] };
  const draft = prepareMail(db,input); assert.equal(draft.data.sent,false);
  assert.notEqual(prepareMail(db,{ ...input,to: ['other@example.com'] }).data.digest,draft.data.digest);
  assert.throws(() => prepareMail(db,{ ...input,subject: 'x\r\nBcc: other@example.com' }));
  const event = calendarProposal({ title: 'Reminder',start: '2026-10-28T10:00:00Z',end: '2026-10-28T11:00:00Z',timezone: 'Asia/Kolkata',attendees: [] });
  assert.equal(event.sendsInvitations,false); db.close();
});
