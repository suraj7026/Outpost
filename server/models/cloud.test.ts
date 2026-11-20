import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoles } from './cloud.js';
const roles = { operator: 'fixture-operator',vision: 'fixture-vision',contextWindow: 8192,maxTokens: 1024,qualified: true,qualificationRef: 'fixture-only' };
test('qualified runtime roles no longer require an independent permission reviewer',() => {
  assert.deepEqual(validateRoles(roles),roles);
  assert.equal(validateRoles({ ...roles,reviewer: roles.operator }).reviewer,roles.operator);
  assert.throws(() => validateRoles({ ...roles,qualified: false }),/models_not_qualified/);
  assert.throws(() => validateRoles({ ...roles,operator: '' }));
});
