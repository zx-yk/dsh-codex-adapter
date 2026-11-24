import test from 'node:test';
import assert from 'node:assert/strict';
import { clipTask, WorkerRegistry } from '../src/hub/index.mjs';
import { jobView, pruneSettledJobs } from '../src/jobs.mjs';
import { applyGlobalConfigPatch, GLOBAL_CONFIG_DEFAULTS } from '../src/install/install.mjs';
import { shardFresh } from '../src/status-shard.mjs';

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

test('settled hub jobs are pruned by age and count, running jobs stay', () => {
  const registry = Object.create(WorkerRegistry.prototype);
  const now = Date.now();
  const old = new Date(now - 7 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now - 60 * 1000).toISOString();
  registry.jobs = new Map([
    ['old', { id: 'old', status: 'done', endedAt: old, disposing: false }],
    ['recent', { id: 'recent', status: 'done', endedAt: recent, disposing: false }],
    ['running', { id: 'running', status: 'running', endedAt: null, disposing: false }],
  ]);
  registry.recorded = new Set(['old', 'recent']);
  registry.pruneSettled(now);
  assert.equal(registry.jobs.has('old'), false);
  assert.equal(registry.jobs.has('recent'), true);
  assert.equal(registry.jobs.has('running'), true);
  assert.equal(registry.recorded.has('old'), false);

  for (let i = 0; i < 510; i += 1) {
    registry.jobs.set('settled-' + i, { id: 'settled-' + i, status: 'done', endedAt: recent, disposing: false });
  }
  registry.pruneSettled(now);
  const settled = [...registry.jobs.values()].filter((j) => j.status !== 'running').length;
  assert.equal(settled, 500);
});

test('standalone/CLI job cache is pruned by age and count', () => {
  const now = Date.now();
  const old = new Date(now - 7 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now - 1000).toISOString();
  const map = new Map([
    ['old', { status: 'done', endedAt: old }],
    ['recent', { status: 'done', endedAt: recent }],
    ['running', { status: 'running', endedAt: null }],
  ]);
  pruneSettledJobs(now, map);
  assert.equal(map.has('old'), false);
  assert.equal(map.has('recent'), true);
  assert.equal(map.has('running'), true);
});

test('a status shard with an unparseable timestamp is never fresh', () => {
  assert.equal(shardFresh(undefined), false);
  assert.equal(shardFresh('not-a-date'), false);
  assert.equal(shardFresh(new Date().toISOString()), true);
});
