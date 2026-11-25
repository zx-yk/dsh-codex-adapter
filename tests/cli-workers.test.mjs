// CLI workers are killed through their process group on POSIX. Windows has no
// POSIX process groups: process.kill(-pid) throws there, and because killGroup
// swallowed it the CLI process survived every timeout and cancel. The platform
// branch and the grok fallback are pure enough to drive with stubs.
//
// The settlement tests below drive a fake child process. They reproduce the
// real race without a CLI or network: Node may emit stdout 'data' after
// 'exit', and only emits 'close' once the stdio pipes are drained. A final
// NDJSON result/is_error record can also lack its trailing newline.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the adapter's config/status/history/lock paths at a throwaway home so
// a unit test never writes fake jobs into the user's real history file.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-cli-workers-home-'));
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;
process.env.DSH_ADAPTER_LOCK_DIR = join(TEST_HOME, '.config', 'dsh-adapter', 'cwd-locks');

const {
  cliFallbackText,
  createNdjsonLineReader,
  killGroup,
  startCliJob,
} = await import('../src/cli-workers.mjs');
const { cancelJob } = await import('../src/jobs.mjs');
const { getCwdLocks, normalizeCwd } = await import('../src/cwd-lock.mjs');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const immediate = (fn) => { fn(); return { unref() {} }; };

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 987_654;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

const AGY = { name: 'agy-test', backend: 'agy', cli: 'agy-test', model: 'agy-test', effortMap: null };
const GROK = { name: 'grok-test', backend: 'grok', cli: 'grok-test', model: 'grok-4.5', effortMap: null };

function fakeSpawn(child) {
  return (command, args, options) => {
    child.spawned = { command, args, options };
    return child;
  };
}

function testJob(profile, child, overrides = {}) {
  return startCliJob({
    worker: profile,
    task: 'settlement regression',
    cwd: process.cwd(),
    timeoutMs: 60_000,
    source: 'test',
    allowConcurrentCwd: true,
    spawnImpl: fakeSpawn(child),
    killGroupImpl: (c) => c.kill('SIGTERM'),
    ...overrides,
  });
}

function waitSettled(job) {
  if (job._settled) return Promise.resolve();
  return new Promise((resolve) => job.waiters.push(resolve));
}

function record(value) {
  return JSON.stringify(value);
}

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

test('the NDJSON reader holds an unterminated final record until EOF flush', () => {
  const lines = [];
  const reader = createNdjsonLineReader((line) => lines.push(line));

  reader.feed(Buffer.from('{"a":1}\r\n\n{"b":'));
  reader.feed(Buffer.from('2}'));
  assert.deepEqual(lines, ['{"a":1}'], 'only complete lines are delivered while streaming');

  reader.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'], 'flush consumes the last record without a newline');
  reader.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'], 'flush is idempotent');
});

test('agy final result without a trailing newline at EOF is parsed and wins', async () => {
  const child = new FakeChild();
  const job = await testJob(AGY, child);

  child.stdout.emit('data', Buffer.from([
    record({ event: 'init', init: { permission_mode: 'acceptEdits', tools: [{ name: 'read' }] } }),
    record({ event: 'step_update', step_update: { step_index: 0, step_type: 'agent_response', text_delta: 'streamed partial' } }),
    record({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'final agy answer',
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3, thinking_tokens: 1 },
      },
    }),
  ].join('\n'))); // last record deliberately has no trailing newline

  child.emit('exit', 0, null);
  assert.equal(job.status, 'running', 'exit alone must not settle before stdio close');
  assert.equal(job.endedAt, null);
  assert.equal(job.result, null, 'the unterminated record stays pending until EOF');

  child.emit('close', 0, null);
  await waitSettled(job);

  assert.equal(job.status, 'done');
  assert.equal(job.result, 'final agy answer');
  assert.deepEqual(job.tokens, { input: 12, output: 3, reasoning: 1 });
  assert.equal(job.stopReason, 'completed');
});

test('grok final result without a trailing newline at EOF is parsed and wins', async () => {
  const child = new FakeChild();
  const job = await testJob(GROK, child);

  child.stdout.emit('data', Buffer.from([
    record({ type: 'system', subtype: 'init', model: 'grok-4.5', tools: [] }),
    record({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }),
    record({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'final grok answer',
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
  ].join('\n')));

  child.emit('exit', 0, null);
  assert.equal(job.status, 'running');
  assert.equal(job.result, null);

  child.emit('close', 0, null);
  await waitSettled(job);

  assert.equal(job.status, 'done');
  assert.equal(job.result, 'final grok answer');
  assert.deepEqual(job.tokens, { input: 5, output: 7, reasoning: 0 });
});

test('stdout that arrives after exit is consumed before close, not replaced by fallback', async () => {
  const child = new FakeChild();
  const job = await testJob(GROK, child);

  child.stdout.emit('data', Buffer.from([
    record({ type: 'system', subtype: 'init', model: 'grok-4.5', tools: [] }),
    record({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fallback text' } } }),
  ].join('\n') + '\n'));

  // The process exits first; stdout is still open and has not been drained.
  child.emit('exit', 0, null);
  assert.equal(job.status, 'running', 'must not settle on exit');
  assert.equal(job.result, null, 'must not fall back to partial text yet');

  // Final record arrives after exit, still without a trailing newline.
  child.stdout.emit('data', Buffer.from(record({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'after-exit answer',
    usage: { input_tokens: 4, output_tokens: 6 },
  })));
  assert.equal(job.status, 'running');
  assert.equal(job.result, null, 'no newline yet: record is buffered, not parsed');

  child.emit('close', 0, null);
  await waitSettled(job);

  assert.equal(job.status, 'done');
  assert.equal(job.result, 'after-exit answer');
  assert.deepEqual(job.tokens, { input: 4, output: 6, reasoning: 0 });
});

test('grok is_error record at EOF without a newline fails the job', async () => {
  const child = new FakeChild();
  const job = await testJob(GROK, child);

  child.stdout.emit('data', Buffer.from([
    record({ type: 'system', subtype: 'init', model: 'grok-4.5', tools: [] }),
    record({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['rate limit exceeded'],
    }),
  ].join('\n')));

  child.emit('exit', 0, null);
  assert.equal(job.status, 'running');

  child.emit('close', 0, null);
  await waitSettled(job);

  assert.equal(job.status, 'failed', 'an errored result must never settle as done');
  assert.equal(job.stopReason, 'error');
  assert.match(job.error, /rate limit exceeded/);
});

test('spawn error settles once, releases the cwd lock, and close cannot overwrite it', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-cli-spawn-'));
  try {
    const child = new FakeChild();
    const job = await testJob(GROK, child, { cwd: workspace, allowConcurrentCwd: false });
    const key = normalizeCwd(workspace);

    assert.equal(typeof job._releaseCwdLock, 'function');
    assert.ok(getCwdLocks().some((entry) => entry.cwd === key), 'spawn holds the cwd lock');

    child.emit('error', new Error('spawn grok-test ENOENT'));
    assert.equal(job.status, 'failed');
    assert.equal(job.stopReason, 'spawn-failed');
    assert.match(job.error, /is it installed/);
    assert.equal(job._releaseCwdLock, null, 'spawn error path releases the lock');
    assert.equal(getCwdLocks().some((entry) => entry.cwd === key), false);

    const endedAt = job.endedAt;
    child.emit('close', null, null);
    assert.equal(job.status, 'failed');
    assert.equal(job.stopReason, 'spawn-failed');
    assert.equal(job.endedAt, endedAt, 'a later close must not resettle or rewrite the result');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a done run releases its cwd lock only when close settles it', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-cli-done-'));
  try {
    const child = new FakeChild();
    const job = await testJob(GROK, child, { cwd: workspace, allowConcurrentCwd: false });
    const key = normalizeCwd(workspace);

    child.stdout.emit('data', Buffer.from(record({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'locked answer',
      usage: { input_tokens: 1, output_tokens: 2 },
    })));
    child.emit('exit', 0, null);
    assert.equal(job._releaseCwdLock != null, true, 'lock stays held until stdio closes');
    assert.ok(getCwdLocks().some((entry) => entry.cwd === key));

    child.emit('close', 0, null);
    await waitSettled(job);

    assert.equal(job.status, 'done');
    assert.equal(job.result, 'locked answer');
    assert.equal(job._releaseCwdLock, null);
    assert.equal(getCwdLocks().some((entry) => entry.cwd === key), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cancel stays cancelled when close arrives later', async () => {
  const child = new FakeChild();
  const kills = [];
  const job = await testJob(GROK, child, { killGroupImpl: (c) => kills.push(c) });

  await cancelJob(job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.error, 'cancelled by request');
  assert.equal(kills.length, 1, 'cancel still kills the CLI process');
  assert.equal(job._settled, false, 'cancel waits for stdio close to release/notify');

  child.emit('close', null, 'SIGTERM');
  await waitSettled(job);

  assert.equal(job.status, 'cancelled');
  assert.equal(job.stopReason, 'cancelled');
  assert.equal(job.error, 'cancelled by request', 'close must not overwrite the cancel reason');
});

test('timeout keeps its error and settles once when close arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const child = new FakeChild();
  const kills = [];
  const job = await testJob(GROK, child, {
    timeoutMs: 500,
    killGroupImpl: (c) => kills.push(c),
  });

  t.mock.timers.tick(500);
  assert.equal(job.status, 'failed');
  assert.equal(job.stopReason, 'timeout');
  assert.match(job.error, /timed out after 1s/);
  assert.equal(kills.length, 1);

  child.emit('close', null, 'SIGTERM');
  await waitSettled(job);

  assert.equal(job.status, 'failed');
  assert.equal(job.stopReason, 'timeout');
  assert.match(job.error, /timed out after 1s/);
});
