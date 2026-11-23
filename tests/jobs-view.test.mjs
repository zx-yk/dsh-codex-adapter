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
