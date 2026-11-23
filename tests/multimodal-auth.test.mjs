// Custom-provider auth and the Claude model flag. A saved api_key can be the
// empty string (the provider form always writes the field), and `??` treated
// it as a real key, so api_key_env was ignored and requests went out with no
// Authorization header. The default vision_model is "default", which is not a
// Claude model id and must not be passed to --model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeModelArgs, resolveApiKey } from '../src/multimodal.mjs';

test('a blank api_key falls through to api_key_env', () => {
  assert.equal(resolveApiKey({ api_key: '   ', api_key_env: 'ADAPTER_TEST_KEY' }, { ADAPTER_TEST_KEY: 'secret' }), 'secret');
  assert.equal(resolveApiKey({ api_key_env: 'ADAPTER_TEST_KEY' }, { ADAPTER_TEST_KEY: 'secret' }), 'secret');
});

test('an explicit api_key wins and is trimmed', () => {
  assert.equal(resolveApiKey({ api_key: ' direct-key ', api_key_env: 'ADAPTER_TEST_KEY' }, { ADAPTER_TEST_KEY: 'env' }), 'direct-key');
});

test('no key and no env name means no Authorization header', () => {
  const absent = 'ADAPTER_TEST_KEY_' + process.pid;
  assert.equal(resolveApiKey({}, {}), undefined);
  assert.equal(resolveApiKey({ api_key_env: '' }, {}), undefined);
  assert.equal(resolveApiKey({ api_key_env: absent }, {}), undefined);
});

test('Claude gets no --model flag for "default"', () => {
  assert.deepEqual(claudeModelArgs('default'), []);
  assert.deepEqual(claudeModelArgs(undefined), []);
  assert.deepEqual(claudeModelArgs(''), []);
  assert.deepEqual(claudeModelArgs('sonnet'), ['--model', 'sonnet']);
});
