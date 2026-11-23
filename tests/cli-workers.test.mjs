// CLI workers are killed through their process group on POSIX. Windows has no
// POSIX process groups: process.kill(-pid) throws there, and because killGroup
// swallowed it the CLI process survived every timeout and cancel. The platform
// branch and the grok fallback are pure enough to drive with stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cliFallbackText, killGroup } from '../src/cli-workers.mjs';

const immediate = (fn) => { fn(); return { unref() {} }; };

test('Windows signals the child itself and never a negative process group', () => {
  const childSignals = [];
  const groupSignals = [];
  killGroup(
    { pid: 4242, kill: (signal) => { childSignals.push(signal); return true; } },
    {
      platform: 'win32',
      kill: (pid, signal) => groupSignals.push([pid, signal]),
      schedule: immediate,
    },
  );
  assert.deepEqual(childSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(groupSignals, [], 'negative-pid group kill must not be attempted on Windows');
});

test('POSIX keeps the detached process-group kill', () => {
  const groupSignals = [];
  killGroup(
    { pid: 4242, kill: () => assert.fail('child.kill must not be used on POSIX') },
    {
      platform: 'linux',
      kill: (pid, signal) => groupSignals.push([pid, signal]),
      schedule: immediate,
    },
  );
  assert.deepEqual(groupSignals, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
});

test('a grok run without a result event reports the assistant text, not empty', () => {
  // _text is initialised to '' for every job; `??` let it mask grok's _msgText.
  assert.equal(cliFallbackText({ result: null, _text: '', _msgText: 'the answer' }), 'the answer');
  assert.equal(cliFallbackText({ result: null, _text: 'agy answer', _msgText: '' }), 'agy answer');
  assert.equal(cliFallbackText({ result: 'explicit result', _text: '', _msgText: 'other' }), 'explicit result');
  assert.equal(cliFallbackText({ result: null, _text: '', _msgText: '' }), '');
});
