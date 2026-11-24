import test from 'node:test';
import assert from 'node:assert/strict';
import { clipTask, WorkerRegistry } from '../src/hub/index.mjs';
import { jobView } from '../src/jobs.mjs';
import { applyGlobalConfigPatch, GLOBAL_CONFIG_DEFAULTS } from '../src/install/install.mjs';

test('job views tolerate a missing task', () => {
  const view = jobView({ id: 'j1', task: undefined, tier: 'flash', status: 'done' });
  assert.equal(view.task, '');
});

test('spawn refuses a missing or blank task before creating a job', async () => {
  const registry = Object.create(WorkerRegistry.prototype);
  await assert.rejects(() => registry.spawn({}), /task must be a non-empty string/);
  await assert.rejects(() => registry.spawn({ task: '   ' }), /task must be a non-empty string/);
});

test('clipTask tolerates a missing task and still marks truncation', () => {
  assert.equal(clipTask(undefined), '');
  assert.equal(clipTask(null), '');
  assert.equal(clipTask('short'), 'short');
  const long = 'x'.repeat(400);
  assert.equal(clipTask(long, 300), 'x'.repeat(300) + '…');
});

test('config patches cannot reach Object.prototype names', () => {
  const patch = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"toString":"evil","default_tier":"pro"}');
  const next = applyGlobalConfigPatch(GLOBAL_CONFIG_DEFAULTS, patch);

  assert.equal(next.default_tier, 'pro');
  assert.equal(Object.hasOwn(next, '__proto__'), false);
  assert.equal(next.polluted, undefined);
  assert.equal(Object.getPrototypeOf(next), Object.prototype);
  assert.equal(Object.hasOwn(next, 'toString'), false);
});
