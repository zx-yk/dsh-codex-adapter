// Workspace group headers must understand Windows separators: a hub running on
// Windows reports cwds like D:\repo\sub, and basenameOf() used to return the
// whole path there, so every group header showed the full path instead of the
// repo name. Node's built-in type stripping lets this import the TypeScript
// source directly; older runtimes skip instead of failing.

import test from 'node:test';
import assert from 'node:assert/strict';

const canLoadTs = typeof process.features?.typescript === 'string';
const loadOpts = canLoadTs ? {} : { skip: 'this Node cannot import TypeScript sources' };

let mod;
async function view() {
  mod ??= await import('../src/client/jobs-view.ts');
  return mod;
}

test('POSIX and Windows paths both yield their last component', loadOpts, async () => {
  const { basenameOf } = await view();
  assert.equal(basenameOf('/a/b/c/'), 'c');
  assert.equal(basenameOf('/'), '/');
  assert.equal(basenameOf('D:\\repo\\sub'), 'sub');
  assert.equal(basenameOf('C:/repo/sub/'), 'sub');
  assert.equal(basenameOf('\\\\server\\share\\proj'), 'proj');
  assert.equal(basenameOf('D:\\'), 'D:\\');
  assert.equal(basenameOf('D:'), 'D:');
  assert.equal(basenameOf(null), '');
  assert.equal(basenameOf(''), '');
});

test('abbrevPath collapses a Windows home with the separator the home uses', loadOpts, async () => {
  const { abbrevPath } = await view();
  assert.equal(abbrevPath('C:\\Users\\me\\repo', 'C:\\Users\\me'), '~\\repo');
  assert.equal(abbrevPath('/home/me/repo', '/home/me'), '~/repo');
  assert.equal(abbrevPath('/home/me', '/home/me'), '~');
});

test('abbrevPath accepts mixed separators between home and cwd', loadOpts, async () => {
  const { abbrevPath } = await view();
  assert.equal(abbrevPath('C:/Users/me/repo', 'C:\\Users\\me'), '~/repo');
  assert.equal(abbrevPath('C:\\Users\\me/repo', 'C:/Users/me'), '~/repo');
  assert.equal(abbrevPath('C:/Users/me/repo/', 'C:\\Users\\me\\'), '~/repo/');
});

test('invalid timestamps render empty, never NaN', loadOpts, async () => {
  const { timeAgo, lockAge } = await view();
  assert.equal(timeAgo('not-a-date'), '');
  assert.equal(timeAgo(undefined), '');
  assert.equal(lockAge('not-a-date'), '');
  assert.equal(lockAge(undefined), '');
});

test('needs_input is tracked as active instead of being treated as a terminal ghost', loadOpts, async () => {
  const { reconcileGhosts, displayJobs } = await view();
  const now = 1000;
  let ghosts = reconcileGhosts([{ id: 'a', status: 'running', startedAt: new Date(now).toISOString() }], {}, now);
  ghosts = reconcileGhosts([{ id: 'a', status: 'needs_input', startedAt: new Date(now).toISOString() }], ghosts, now + 1);
  assert.equal(ghosts.a.job.status, 'needs_input');
  ghosts = reconcileGhosts([], ghosts, now + 2);
  ghosts = reconcileGhosts([], ghosts, now + 3);
  assert.equal(ghosts.a.job.status, 'orphaned');
  assert.equal(displayJobs([], ghosts)[0].status, 'orphaned');
});

test('the ghost cap never evicts live rows', loadOpts, async () => {
  const { reconcileGhosts } = await view();
  const now = 1000;
  let ghosts = reconcileGhosts([], {
    g1: { job: { id: 'g1', status: 'running' }, lastSeenAt: now, misses: 0 },
  }, now);
  const live = Array.from({ length: 45 }, (_, i) => ({ id: 'live-' + i, status: 'running' }));
  ghosts = reconcileGhosts(live, ghosts, now + 1);
  assert.equal(Object.keys(ghosts).length, 46);
  assert.ok(ghosts.g1);
  assert.ok(ghosts['live-0']);
});

test('a needs_input job holds the workspace lock only while disposing', loadOpts, async () => {
  const { workspaceLocks } = await view();
  const base = { id: 'j', cwd: '/repo', status: 'needs_input' };
  assert.equal(workspaceLocks([{ ...base, disposing: true }]).length, 1);
  assert.equal(workspaceLocks([{ ...base, disposing: false }]).length, 0);
  assert.equal(workspaceLocks([{ id: 'f', cwd: '/repo', status: 'failed', disposing: true }]).length, 1);
});
