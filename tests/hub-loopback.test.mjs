// The hub's local-only gate. The Host header carries a port; a naive split on
// ':' turned the IPv6 literal "[::1]:59306" into "[", so every request from an
// IPv6 loopback origin was rejected with 403.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostHeaderName, isLoopbackRequest } from '../src/hub/index.mjs';

const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: { host } });

test('host headers lose the port but keep IPv6 brackets', () => {
  assert.equal(hostHeaderName('127.0.0.1:3080'), '127.0.0.1');
  assert.equal(hostHeaderName('localhost:59306'), 'localhost');
  assert.equal(hostHeaderName('[::1]:59306'), '[::1]');
  assert.equal(hostHeaderName('[::1]'), '[::1]');
  assert.equal(hostHeaderName(undefined), '');
});

test('IPv4 and IPv6 loopback requests are accepted', () => {
  assert.equal(isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080')), true);
  assert.equal(isLoopbackRequest(req('::1', '[::1]:59306')), true);
  assert.equal(isLoopbackRequest(req('::ffff:127.0.0.1', 'localhost:3080')), true);
});

test('a non-loopback peer or a foreign Host is refused', () => {
  assert.equal(isLoopbackRequest(req('192.168.1.5', '127.0.0.1:3080')), false);
  assert.equal(isLoopbackRequest(req('127.0.0.1', 'evil.example:3080')), false);
  assert.equal(isLoopbackRequest(req('127.0.0.1', '127.0.0.1.evil.example')), false);
  assert.equal(isLoopbackRequest({ headers: { host: '127.0.0.1' } }), false);
});
