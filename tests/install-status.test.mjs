// Host detection is independent of the integration marker files this plugin
// writes. A fresh machine with Codex installed has ~/.codex/config.toml but no
// ds-flash.toml yet; the settings page used to call that "not installed" and
// offered only an Install button. The same false negative applied to Claude
// Code, Antigravity and Grok.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let home;
let install;
let original = {};

before(async () => {
  original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  home = mkdtempSync(join(tmpdir(), 'dsh-adapter-install-status-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Do not let a real CLI on this machine mask a missing fixture.
  process.env.PATH = '';
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  install = await import('../src/install/install.mjs');
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function write(rel, text = '') {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('a Codex install is detected before this plugin writes ds-flash.toml', () => {
  write('.codex/config.toml', '[model]\nname = "gpt-5"\n');
  const status = install.installStatus({ home });
  assert.equal(status.codex.detected, true);
  assert.equal(status.codex.installed, false);
});

test('an existing Codex integration is still reported as installed', () => {
  write('.codex/agents/ds-flash.toml', 'name = "ds-flash"\n');
  const status = install.installStatus({ home });
  assert.equal(status.codex.detected, true);
  assert.equal(status.codex.installed, true);
});

test('Claude Code, Antigravity and Grok are detected from their own files', () => {
  write('.claude/settings.json', '{}\n');
  write('.gemini/config/mcp_config.json', '{ "mcpServers": {} }\n');
  write('.grok/config.toml', '[model]\nname = "grok-4.5"\n');
  const status = install.installStatus({ home });
  assert.equal(status.claude.detected, true);
  assert.equal(status.claude.installed, false);
  assert.equal(status.agy.detected, true);
  assert.equal(status.agy.installed, false);
  assert.equal(status.grok.detected, true);
  assert.equal(status.grok.installed, false);
});

test('an empty home detects nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-adapter-install-empty-'));
  try {
    const status = install.installStatus({ home: empty });
    assert.deepEqual(
      { claude: status.claude.detected, codex: status.codex.detected, agy: status.agy.detected, grok: status.grok.detected },
      { claude: false, codex: false, agy: false, grok: false },
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a CLI on PATH counts as host software even without config files', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-adapter-install-bin-'));
  const empty = mkdtempSync(join(tmpdir(), 'dsh-adapter-install-empty-'));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '');
    process.env.PATH = bin;
    const status = install.installStatus({ home: empty });
    assert.equal(status.codex.detected, true);
    assert.equal(status.codex.installed, false);
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
