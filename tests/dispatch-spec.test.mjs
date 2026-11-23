// The hub spawn spec is shared by blocking and async dispatch. Its timeout is
// mandatory: the async path previously sent `timeout_seconds: timeout` where
// `timeout` was never declared, so every hub-mode dsh_spawn_worker died with
// ReferenceError before making a request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hubSpawnSpec } from '../src/dispatch-spec.mjs';

const base = {
  task: 'fix the parser',
  tier: 'flash',
  effort: 'high',
  cwd: '/repo',
  source: 'claude-code',
  timeoutSeconds: 1800,
  binding: { provider: 'ollama', model: 'qwen3:8b' },
  origin: { chain: [{ backend: 'standalone', cwd: '/repo', source: 'codex' }], depth: 1 },
};

test('the spec carries the timeout, route binding and origin hop', () => {
  const spec = hubSpawnSpec(base);
  assert.equal(spec.timeout_seconds, 1800);
  assert.equal(spec.provider, 'ollama');
  assert.equal(spec.model, 'qwen3:8b');
  assert.deepEqual(spec.origin_chain, base.origin.chain);
  assert.equal(spec.origin_depth, 1);
  assert.equal(spec.preset, undefined);
  assert.equal(spec.task, 'fix the parser');
});

test('the preset rides the spec only when one is configured', () => {
  assert.equal(hubSpawnSpec({ ...base, preset: 'minimal' }).preset, 'minimal');
  assert.equal(Object.hasOwn(hubSpawnSpec(base), 'preset'), false);
});

test('a missing or non-positive timeout is refused instead of sent as undefined', () => {
  for (const timeoutSeconds of [undefined, null, 0, -5, NaN, Infinity, 'abc', '']) {
    assert.throws(() => hubSpawnSpec({ ...base, timeoutSeconds }), /positive timeout/);
  }
  // A hand-edited config may carry the number as a string; tolerate it.
  assert.equal(hubSpawnSpec({ ...base, timeoutSeconds: '1800' }).timeout_seconds, 1800);
});
