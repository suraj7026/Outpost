import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Notifications } from './apns.js';
test('invalid APNs tokens retire without losing the authoritative inbox',async () => {
  const db = new Ledger(), notifier = new Notifications(db);
  db.put('device','phone',0,{ revoked: false }); db.put('inbox','notice',0,{ state: 'pending',title: 'Private command omitted from push' });
  notifier.register('phone','a'.repeat(64),'dev.outpost.ios','sandbox'); let sends = 0;
  const config = { teamId: 'fixture',keyId: 'fixture',privateKeyPEM: 'not used',topic: 'dev.outpost.ios',environment: 'sandbox' as const };
  const transport = async () => { sends++; return { status: 410,reason: 'Unregistered' }; };
  await notifier.deliver('notice',config,transport); await notifier.deliver('notice',config,transport);
  assert.equal(sends,1); assert.equal(db.need('inbox','notice').data.state,'pending'); assert.equal(db.list('push_token')[0]?.data.disabled,true); db.close();
});
