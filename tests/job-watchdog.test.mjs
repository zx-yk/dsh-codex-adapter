// The hub has no external supervisor: a DSH agent session whose tool awaits
// forever stays "running" forever. These rules are the safety net, so they are
// tested directly rather than through a live session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobProblem, quietSeconds, DEFAULT_STALL_SECONDS } from '../src/job-watchdog.mjs';

const NOW = Date.parse('2026-11-21T16:00:00Z');
const job = (over = {}) => ({
  status: 'running',
  startedAt: '2026-11-21T15:55:00Z',
  lastEventAt: '2026-11-21T15:59:30Z',
  currentTool: 'run_code',
  ...over,
});

test('a running job quiet beyond the stall window is a stall', () => {
  const problem = jobProblem(job({ lastEventAt: '2026-11-21T15:45:00Z' }), NOW, 600);
  assert.equal(problem?.kind, 'stall');
  assert.match(problem.reason, /no session events for 900s/);
  assert.match(problem.reason, /run_code/);
});

test('a recently active job is not a stall', () => {
  assert.equal(jobProblem(job(), NOW, 600), null);
});

test('a passed deadline is a timeout even when events are recent', () => {
  const problem = jobProblem(job({ deadlineAt: '2026-11-21T15:59:00Z', timeoutSeconds: 240 }), NOW, 600);
  assert.equal(problem?.kind, 'timeout');
  assert.match(problem.reason, /timed out after 240s/);
});

test('finished or interactive jobs are never swept', () => {
  assert.equal(jobProblem(job({ status: 'done' }), NOW, 600), null);
  assert.equal(jobProblem(job({ status: 'needs_input' }), NOW, 600), null);
});

test('missing timestamps do not produce a false stall', () => {
  assert.equal(jobProblem(job({ startedAt: null, lastEventAt: null }), NOW, 600), null);
});

test('quietSeconds reports the silence, and the default window is ten minutes', () => {
  assert.equal(quietSeconds(job(), NOW), 30);
  assert.equal(quietSeconds(job({ lastEventAt: null, startedAt: '2026-11-21T15:58:00Z' }), NOW), 120);
  assert.equal(DEFAULT_STALL_SECONDS, 600);
});
