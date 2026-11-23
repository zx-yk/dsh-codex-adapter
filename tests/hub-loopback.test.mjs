// The hub's local-only gate. The Host header carries a port; a naive split on
// ':' turned the IPv6 literal "[::1]:59306" into "[", so every request from an
// IPv6 loopback origin was rejected with 403.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostHeaderName, isLoopbackRequest, requestRejectionFor } from '../src/hub/index.mjs';

const req = (remoteAddress, host, headers = {}) => ({
  socket: { remoteAddress },
  headers: { host, ...headers },
});
const ctxWith = (connection) => ({
  get: (name) => (name === 'connection' ? connection : undefined),
});

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

test('without the connection service, the old loopback gate still applies', () => {
  const ctx = { get: () => undefined };
  assert.equal(requestRejectionFor(ctx, req('127.0.0.1', '127.0.0.1:3080')), undefined);
  assert.equal(requestRejectionFor(ctx, req('192.168.1.5', '127.0.0.1:3080')), 403);
});

test('an authenticated/trusted request from the connection service passes', () => {
  const ctx = ctxWith({ requestRejection: () => undefined });
  assert.equal(requestRejectionFor(ctx, req('127.0.0.1', '127.0.0.1:3080')), undefined);
});

test('cross-site and untrusted requests keep the rejection from DSH', () => {
  const ctx = ctxWith({ requestRejection: () => 403 });
  assert.equal(requestRejectionFor(ctx, req('127.0.0.1', '127.0.0.1:3080', { origin: 'https://evil.example' })), 403);

  const unauthorized = ctxWith({ requestRejection: () => 401 });
  assert.equal(requestRejectionFor(unauthorized, req('127.0.0.1', '127.0.0.1:3080', { origin: 'https://evil.example' })), 401);
  assert.equal(requestRejectionFor(unauthorized, req('127.0.0.1', '127.0.0.1:3080', { cookie: 'dsh=abc' })), 401);
  assert.equal(requestRejectionFor(unauthorized, req('192.168.1.5', '127.0.0.1:3080')), 401);
});

test('the bundled MCP client (loopback, no browser markers) is not locked out by DSH auth', () => {
  const ctx = ctxWith({ requestRejection: () => 401 });
  assert.equal(requestRejectionFor(ctx, req('127.0.0.1', '127.0.0.1:3080')), undefined);
  assert.equal(requestRejectionFor(ctx, req('::1', '[::1]:3080')), undefined);
  assert.equal(requestRejectionFor(ctx, req('::ffff:127.0.0.1', 'localhost:3080')), undefined);
});

test('a throwing connection service fails closed', () => {
  const ctx = ctxWith({ requestRejection: () => { throw new Error('boom'); } });
  assert.equal(requestRejectionFor(ctx, req('127.0.0.1', '127.0.0.1:3080')), 403);
});

test('every registered hub route applies the connection gate', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/hub/index.mjs', import.meta.url), 'utf8');
  const routes = (source.match(/webServer\.register\(\{/g) ?? []).length;
  // One definition plus one call per route.
  const gates = (source.match(/requestRejectionFor\(ctx, req\)/g) ?? []).length;
  assert.ok(routes > 0, 'expected the hub to register routes');
  assert.equal(gates, routes + 1, `${routes} routes must each call requestRejectionFor`);
});

test('a real loopback fetch passes; an Origin-bearing request stays rejected', async () => {
  const { createServer } = await import('node:http');
  const ctx = ctxWith({ requestRejection: () => 401 });
  const server = createServer((req, res) => {
    const rejection = requestRejectionFor(ctx, req);
    res.statusCode = rejection ?? 200;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const browser = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'https://evil.example' } });
    assert.equal(browser.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
