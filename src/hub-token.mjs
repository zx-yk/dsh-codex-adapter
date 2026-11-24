// A per-profile bearer token for the bundled MCP client. The hub trusts a
// browser session through DSH's connection service; a non-browser loopback
// process must prove it belongs to this installation instead of merely being
// local (loopback is not user-scoped on a multi-user machine).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const HUB_TOKEN_FILE = join(homedir(), '.config', 'dsh-adapter', 'hub-token');

export function readHubToken() {
  try {
    const value = readFileSync(HUB_TOKEN_FILE, 'utf8').trim();
    return /^[a-f0-9]{64}$/i.test(value) ? value : '';
  } catch { return ''; }
}

export function ensureHubToken() {
  const existing = readHubToken();
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(HUB_TOKEN_FILE), { recursive: true });
  writeFileSync(HUB_TOKEN_FILE, token + '\n', { mode: 0o600 });
  try { chmodSync(HUB_TOKEN_FILE, 0o600); } catch {}
  return token;
}
