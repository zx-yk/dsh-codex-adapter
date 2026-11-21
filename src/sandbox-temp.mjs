// DSH's Windows ACL sandbox needs a temp root where the current user can write
// an inheritable DACL: it creates a private child directory there and grants it
// a capability SID. A custom TEMP (say D:\local\Temp) whose FullControl entry
// is not inheritable makes every command fail with
// "SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)".
//
// Instead of asking the user to repair ACLs, point TMP/TEMP at a directory the
// plugin owns under LOCALAPPDATA, which inherits the user's FullControl on
// every normal Windows profile. Only done when the current temp root cannot
// pass the same check the sandbox performs.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Pure decision helper, tested without touching the filesystem. */
export function chooseTempRoot({ platform, currentRoot, inheritableFullControl, localAppData, home }) {
  if (platform !== 'win32') return { root: currentRoot, switched: false, reason: 'not windows' };
  if (inheritableFullControl) return { root: currentRoot, switched: false, reason: 'current temp root inherits full control' };
  const base = localAppData || (home ?? homedir());
  return { root: join(base, 'dsh-adapter', 'temp'), switched: true, reason: 'current temp root has no inheritable full control' };
}

/** Does a freshly created child of `root` inherit FullControl for this user? */
export function tempRootInheritsFullControl(root) {
  if (process.platform !== 'win32') return true;
  let probe;
  try {
    probe = mkdtempSync(join(root, 'dsh-probe-'));
    const out = execFileSync('icacls', [probe], { encoding: 'utf8', timeout: 10_000 });
    const user = userInfo().username;
    return out.split(/\r?\n/).some((line) => line.includes(user) && /\(F\)/.test(line));
  } catch {
    return false;
  } finally {
    if (probe) { try { rmSync(probe, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/** Create the plugin temp dir and trim stale children (best effort). */
function prepareOwnTemp(root) {
  mkdirSync(root, { recursive: true });
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      try { if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  } catch { /* best effort */ }
}

let cached;

/**
 * Prepare the temp root for sandboxed commands and apply it to this process.
 * Idempotent; returns { root, switched, reason }.
 */
export function prepareSandboxTemp() {
  if (cached) return cached;
  const current = tmpdir();
  const decision = chooseTempRoot({
    platform: process.platform,
    currentRoot: current,
    inheritableFullControl: tempRootInheritsFullControl(current),
    localAppData: process.env.LOCALAPPDATA,
    home: homedir(),
  });
  if (decision.switched) {
    try {
      prepareOwnTemp(decision.root);
      process.env.TMP = decision.root;
      process.env.TEMP = decision.root;
    } catch {
      cached = { root: current, switched: false, reason: 'could not create the plugin temp directory' };
      return cached;
    }
  }
  cached = decision;
  return cached;
}
