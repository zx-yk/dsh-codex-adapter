// Releasing hub-held cwd locks is only safe against an authoritative job list.
// dsh_worker_status used to pass [] when the hub was unreachable, which looked
// exactly like "the hub has no jobs" and released every lock — letting a second
// writer into a workspace whose worker was still running.

import test from 'node:test';
import assert from 'node:assert/strict';
import { settledHubLockIds } from '../src/cwd-lock.mjs';

const lock = (jobId, mode = 'hub') => ({ cwd: '/repo', holder: { jobId, mode } });

test('a hub lock whose job is running is not released', () => {
  assert.deepEqual(settledHubLockIds([{ id: 'hub-1', status: 'running' }], [lock('hub-1')]), []);
});

test('a lock whose job settled or vanished is released', () => {
  assert.deepEqual(
    settledHubLockIds([{ id: 'hub-1', status: 'done' }], [lock('hub-1'), lock('hub-2')]),
    ['hub-1', 'hub-2'],
  );
});

test('non-hub locks and lock entries without a holder are ignored', () => {
  assert.deepEqual(
    settledHubLockIds([], [lock('job-1', 'standalone'), { cwd: '/x' }, { cwd: '/y', holder: null }]),
    [],
  );
});

test('an absent list (hub down) is the caller\'s decision, not something this helper guesses', () => {
  // The server must pass null/undefined only when it will not release at all;
  // this helper sees [] as a real, empty answer from the hub.
  assert.deepEqual(settledHubLockIds(undefined, [lock('hub-1')]), []);
});
