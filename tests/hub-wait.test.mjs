// A hub long-poll used to leave both its timer and its waiter behind after
// every 60 s slice: the timer kept an event-loop handle alive and the waiter
// list grew for the whole run of the job. Both are observable from the public
// wait() method, so this test drives it directly with a stubbed job.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

function registryWith(job) {
  const registry = new WorkerRegistry({}, { publish() {} });
  registry.jobs.set(job.id, job);
  return registry;
}

test('a settled job wakes the wait and clears its timer', async () => {
  const job = { id: 'hub-1', status: 'running', waiters: [] };
  const registry = registryWith(job);
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  let timers = 0;
  let cleared = 0;
  global.setTimeout = (fn, ms, ...args) => { timers += 1; return realSet(fn, ms, ...args); };
  global.clearTimeout = (timer) => { cleared += 1; return realClear(timer); };
  try {
    const pending = registry.wait('hub-1', 60_000);
    assert.equal(job.waiters.length, 1);
    job.status = 'done';
    for (const wake of job.waiters.splice(0)) wake();
    const seen = await pending;
    assert.equal(seen.status, 'done');
    assert.equal(timers, 1);
    assert.equal(cleared, 1, 'the losing timer branch must be cleared');
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
});

test('a timed-out wait removes its waiter instead of leaking it onto the job', async () => {
  const job = { id: 'hub-2', status: 'running', waiters: [] };
  const registry = registryWith(job);
  const started = Date.now();
  const seen = await registry.wait('hub-2', 25);
  assert.equal(seen, job);
  assert.ok(Date.now() - started >= 20);
  assert.equal(job.waiters.length, 0, 'no waiter may remain after the wait budget expires');
});
