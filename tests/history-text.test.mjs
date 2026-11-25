import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord } from '../src/history.mjs';

test('historyRecord never writes objects into text columns', () => {
  const rec = historyRecord({
    id: 'job-x', task: {}, result: [], error: { code: 1 }, tier: {}, model: [],
    effort: { x: 1 }, status: {}, source: {}, backend: {}, profile: {}, cwd: {},
  });
  for (const key of ['task', 'result', 'error', 'tier', 'model', 'effort', 'status', 'source', 'backend', 'profile', 'cwd']) {
    assert.equal(typeof rec[key], 'string', `${key} must be a string`);
  }
});
