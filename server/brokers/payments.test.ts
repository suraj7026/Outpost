import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { digest } from '../core/contracts.js';
import { Payments } from './payments.js';
test('whole-workflow terms, concurrent budget and unknown settlement remain bounded',() => {
  const db = new Ledger(), payments = new Payments(db); db.put('device','phone',0,{ revoked: false });
  const terms = { taskId: 'task',merchant: 'Fixture shop',purpose: 'Test only',itemsHash: 'a'.repeat(64),identityId: 'agent',fundingAlias: 'sandbox',delivery: 'Fixture',maxMinor: 1000,currency: 'USD',recurrence: 'none',steps: ['checkout','receipt'],expiresAt: Date.now()+60000 };
  const mandate = payments.authorize(terms,digest(terms),'phone');
  payments.reserve(mandate.id,'order',terms,700,'checkout'); payments.reserve(mandate.id,'order',terms,700,'checkout');
  assert.throws(() => payments.reserve(mandate.id,'second',terms,400,'checkout'),/payment_budget_exceeded/);
  assert.throws(() => payments.reserve(mandate.id,'changed',{ ...terms,merchant: 'Other' },100,'checkout'),/payment_scope_changed/);
  payments.unknown('order',1); assert.equal(db.need('mandate',mandate.id).data.consumedMinor,700);
  payments.revoke(mandate.id,2); assert.throws(() => payments.reserve(mandate.id,'new',terms,100,'checkout')); db.close();
});
