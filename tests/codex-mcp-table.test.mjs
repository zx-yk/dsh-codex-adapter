// The Codex global MCP entry can have a sub-table
// [mcp_servers.dsh-adapter.env] (an Electron launcher writes
// ELECTRON_RUN_AS_NODE there). Replacing only the parent table left the old
// env behind and — when the new launcher also has env — emitted a duplicate
// TOML table, so Codex silently refused to start the server. Removing only the
// parent left an orphan env table behind after uninstall.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = 'C:\\app\\lib\\server.mjs';
const electron = { command: 'C:\\app\\electron.exe', env: { ELECTRON_RUN_AS_NODE: '1' } };
const node = { command: 'node' };

let home;
let upsertCodexMcp;
let removeCodexMcp;

before(async () => {
  // install.mjs migrates ~/.config at import time; keep that off the real home.
  home = mkdtempSync(join(tmpdir(), 'dsh-adapter-codex-table-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  ({ upsertCodexMcp, removeCodexMcp } = await import('../src/install/install.mjs'));
});

after(() => { if (home) rmSync(home, { recursive: true, force: true }); });

function tableHeaders(text) {
  return [...text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)].map((m) => m[1]).sort();
}

test('re-upserting an Electron launcher produces one parent table and one env table', () => {
  const once = upsertCodexMcp('', SERVER, electron);
  const twice = upsertCodexMcp(once, SERVER, electron);
  assert.deepEqual(tableHeaders(twice), ['mcp_servers.dsh-adapter', 'mcp_servers.dsh-adapter.env']);
  assert.equal((twice.match(/ELECTRON_RUN_AS_NODE/g) ?? []).length, 1);
});

test('switching launchers drops the stale env table instead of keeping it', () => {
  const once = upsertCodexMcp('', SERVER, electron);
  const switched = upsertCodexMcp(once, SERVER, node);
  assert.deepEqual(tableHeaders(switched), ['mcp_servers.dsh-adapter']);
  assert.equal(switched.includes('ELECTRON_RUN_AS_NODE'), false);
  assert.match(switched, /command = "node"/);
});

test('uninstall removes the parent table and its sub-tables, keeping other config', () => {
  const before = '[model]\nname = "gpt-5"\n\n'
    + upsertCodexMcp('', SERVER, electron)
    + '\n[other]\nvalue = 1\n';
  const after = removeCodexMcp(before);
  assert.equal(after.includes('mcp_servers.dsh-adapter'), false);
  assert.match(after, /\[model\]/);
  assert.match(after, /\[other\]/);
});

test('a child written as an array of tables is removed with its parent', () => {
  const before = '[model]\nname = "gpt-5"\n\n'
    + '[mcp_servers.dsh-adapter]\ncommand = "old"\n\n'
    + '[[mcp_servers.dsh-adapter.env]]\nOLD = "1"\n\n'
    + '[other]\nkeep = true\n';
  const after = removeCodexMcp(before);
  assert.equal(after.includes('mcp_servers.dsh-adapter'), false);
  assert.match(after, /\[model\]/);
  assert.match(after, /\[other\]/);
});
