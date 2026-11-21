// The temp-root decision is what makes the plugin work on machines whose TEMP
// was moved somewhere without an inheritable FullControl entry (the sandbox
// then fails with SetNamedSecurityInfoW Win32 5 on every command).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chooseTempRoot } from '../src/sandbox-temp.mjs';

const base = { platform: 'win32', currentRoot: 'D:\\local\\Temp', localAppData: 'C:\\Users\\u\\AppData\\Local', home: 'C:\\Users\\u' };

test('a temp root that inherits full control is used unchanged', () => {
  const d = chooseTempRoot({ ...base, inheritableFullControl: true });
  assert.equal(d.switched, false);
  assert.equal(d.root, 'D:\\local\\Temp');
});

test('a temp root without inheritable full control switches to the plugin directory', () => {
  const d = chooseTempRoot({ ...base, inheritableFullControl: false });
  assert.equal(d.switched, true);
  assert.equal(d.root, 'C:\\Users\\u\\AppData\\Local\\dsh-adapter\\temp');
});

test('non-Windows platforms keep the system temp root', () => {
  const d = chooseTempRoot({ platform: 'linux', currentRoot: '/tmp', inheritableFullControl: false, localAppData: undefined, home: '/home/u' });
  assert.equal(d.switched, false);
  assert.equal(d.root, '/tmp');
});

test('without LOCALAPPDATA the home directory is the fallback base', () => {
  const d = chooseTempRoot({ ...base, localAppData: undefined, inheritableFullControl: false });
  assert.equal(d.root, join('C:\\Users\\u', 'dsh-adapter', 'temp'));
});
