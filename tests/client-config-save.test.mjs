import test from 'node:test';
import assert from 'node:assert/strict';
import { persistConfigPatch } from '../src/client/config-save.mjs';

const copy = {
  saved: 'Saved',
  saveFailed: 'Save failed:',
  emptyResponse: (path, status) => `${path} HTTP ${status}`,
};

test('a failed config save restores server state and reports the error', async () => {
  const seen = { config: null, notice: null, installCalls: 0 };
  const saved = await persistConfigPatch({ codex_global_mcp: false }, {
    post: async () => ({ ok: false, error: 'disk full' }),
    get: async () => ({ ok: true, config: { codex_global_mcp: true } }),
    onConfig: (value) => { seen.config = value; },
    onNotice: (value) => { seen.notice = value; },
    copy,
  });
  if (saved) seen.installCalls++;
  assert.equal(saved, false);
  assert.deepEqual(seen.config, { codex_global_mcp: true });
  assert.match(seen.notice, /disk full/);
  assert.equal(seen.installCalls, 0);
});

test('a network failure remains visible even when config refresh also fails', async () => {
  let notice = '';
  const saved = await persistConfigPatch({}, {
    post: async () => { throw new Error('offline'); },
    get: async () => { throw new Error('offline'); },
    onConfig: () => assert.fail('no authoritative config was returned'),
    onNotice: (value) => { notice = value; },
    copy,
  });
  assert.equal(saved, false);
  assert.equal(notice, 'Save failed: offline');
});

test('a successful config save updates state and reports success', async () => {
  let config;
  let notice;
  const saved = await persistConfigPatch({ mode: 'hub' }, {
    post: async () => ({ ok: true, config: { mode: 'hub' } }),
    get: async () => assert.fail('successful save must not refetch'),
    onConfig: (value) => { config = value; },
    onNotice: (value) => { notice = value; },
    copy,
  });
  assert.equal(saved, true);
  assert.deepEqual(config, { mode: 'hub' });
  assert.equal(notice, 'Saved');
});
