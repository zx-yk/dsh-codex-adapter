// Grok's config is one shared TOML file. The installer removes the previous
// dsh-adapter section before appending a new one; if it stopped at the first
// header it left [mcp_servers.dsh-adapter.env] behind (and installStatus then
// still reported the plugin as installed after uninstall).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home;
let install;
let originalEnv;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-adapter-grok-table-'));
  originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  install = await import('../src/install/install.mjs');
});

after(() => {
  if (originalEnv) {
    process.env.HOME = originalEnv.HOME;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

function writeConfig(text) {
  const dir = join(home, '.grok');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), text);
}

function headers(text) {
  return [...text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)].map((m) => m[1]);
}

test('reinstall replaces the whole dsh-adapter block, including sub-tables', () => {
  writeConfig('[model]\nname = "grok-4.5"\n\n'
    + '[mcp_servers.dsh-adapter]\ncommand = "old"\n\n'
    + '[mcp_servers.dsh-adapter.env]\nOLD = "1"\n\n'
    + '[other]\nkeep = true\n');
  install.installGrok({ home });
  const text = readFileSync(join(home, '.grok', 'config.toml'), 'utf8');
  const mcpHeaders = headers(text).filter((h) => h.startsWith('mcp_servers.dsh-adapter'));
  assert.deepEqual(mcpHeaders, ['mcp_servers.dsh-adapter']);
  assert.equal(text.includes('OLD = "1"'), false);
  assert.deepEqual(headers(text).filter((h) => h === 'model' || h === 'other').sort(), ['model', 'other']);
});

test('uninstall leaves unrelated TOML tables intact', () => {
  install.uninstallGrok({ home });
  const text = readFileSync(join(home, '.grok', 'config.toml'), 'utf8');
  assert.equal(text.includes('mcp_servers.dsh-adapter'), false);
  assert.match(text, /\[model\]/);
  assert.match(text, /\[other\]/);
});
