// Advisory per-cwd concurrency lock (WPC9 guardrail 2).
//
// Real incident (2026-08-2x): two workers writing the same repo at once left
// another process reading a half-written file (939 lines, unparseable). As
// the backend matrix (hub / standalone / agy / grok / ...) grows, concurrent
// same-repo workers stop being an edge case, so the dispatcher now REFUSES a
// second running job for one cwd instead of queueing it: queueing would hide
// the caller bug ("you should not have dispatched two writers at one repo")
// behind a silent wait, and a second writer usually corrupts whatever the
// first one is doing anyway.
//
// Scope and lifetime:
//   - Keyed by the canonical absolute path of the cwd — realpath when the
//     directory exists (symlink aliases like macOS's /tmp -> /private/tmp
//     then share one lock), resolve() otherwise.
//   - Canonical cwd -> an in-memory map plus a per-cwd JSON file under
//     ~/.config/dsh-adapter/cwd-locks. The file lets separate MCP sessions
//     coordinate; a lock whose pid is dead is removed on the next acquire.
//     A crashed dispatcher therefore cannot deadlock the workspace forever.
//   - Advisory: allow_concurrent_cwd: true skips acquisition entirely
//     (read-only fan-out over one repo is legitimate).
//   - Released on every terminal path (done / failed / cancelled / timeout)
//     through the job settle hooks: jobs.mjs startJob finally (standalone)
//     and cli-workers settle (CLI). Hub jobs have no settle callback on the
//     client, so their locks are released when a settled state is observed
//     (hub.get after wait, dsh_worker_status purge, stale-check on acquire).

import { resolve, join } from 'node:path';
import { realpathSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const locks = new Map(); // canonical cwd -> holder
const LOCK_DIR = process.env.DSH_ADAPTER_LOCK_DIR || join(homedir(), '.config', 'dsh-adapter', 'cwd-locks');

function lockPath(key) {
  return join(LOCK_DIR, createHash('sha1').update(key).digest('hex') + '.json');
}
function readLockFile(key) {
  try { const raw = JSON.parse(readFileSync(lockPath(key), 'utf8')); return raw && typeof raw === 'object' ? raw : null; }
  catch { return null; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}
function staleHolder(key) {
  const holder = readLockFile(key);
  if (!holder || !pidAlive(Number(holder.pid))) { try { unlinkSync(lockPath(key)); } catch (e) { if (e?.code !== 'ENOENT') try { rmSync(lockPath(key), { force: true }); } catch {} } return true; }
  return false;
}
function writeLockFile(key, holder) {
  try { mkdirSync(LOCK_DIR, { recursive: true }); writeFileSync(lockPath(key), JSON.stringify({ ...holder, pid: process.pid })); } catch { /* disk lock best-effort */ }
}
function acquireDiskLock(key, holder) {
  mkdirSync(LOCK_DIR, { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath(key), 'wx');
      // Write the payload through the same exclusive descriptor: opening then
      // closing empty lets a concurrent process mistake our half-created lock
      // for a stale one and remove it.
      writeFileSync(fd, JSON.stringify({ ...holder, pid: process.pid }));
      closeSync(fd);
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') return; // no disk lock available; memory remains
      if (staleHolder(key)) continue;
      const existing = readLockFile(key) ?? { cwd: key, jobId: null, backend: 'unknown', mode: 'unknown', startedAt: null };
      throw new CwdLockError(existing);
    }
  }
}

/** Canonical absolute path of a workspace cwd (realpath when it exists). */
export function normalizeCwd(cwd) {
  try { return realpathSync.native(String(cwd)); } catch { return resolve(String(cwd)); }
}

/** Thrown by acquireCwdLock when another running job holds the cwd. */
export class CwdLockError extends Error {
  constructor(holder) {
    const job = holder.jobId ?? '(starting)';
    super(
      `workspace "${holder.cwd}" is already held by a running worker (job ${job}, backend ${holder.backend}, mode ${holder.mode}, started at ${holder.startedAt}). ` +
      'Refusing this dispatch instead of queueing it: two workers writing the same repo concurrently corrupt files. ' +
      'Wait for that job to settle, cancel it, or pass allow_concurrent_cwd: true if this task is read-only.',
    );
    this.name = 'CwdLockError';
    this.holder = { ...holder };
  }
}

/**
 * Acquire the advisory lock for one cwd. Returns { holder, release } where
 * release() is idempotent and safe to call from any settle path. With
 * allowConcurrent: true this is a deliberate no-op (the lock stays advisory).
 */
export function acquireCwdLock({ cwd, jobId, backend, mode, startedAt, allowConcurrent = false }) {
  if (allowConcurrent) return { holder: null, release() {} };
  const key = normalizeCwd(cwd);
  const existing = locks.get(key);
  if (existing) throw new CwdLockError(existing);
  const holder = { jobId, backend, mode, startedAt, cwd: key, pid: process.pid };
  acquireDiskLock(key, holder);
  locks.set(key, holder);
  let released = false;
  return {
    holder,
    release() {
      if (released) return;
      released = true;
      if (locks.get(key) === holder) locks.delete(key);
      try {
        const current = readLockFile(key);
        if (!current || current.pid === holder.pid && current.jobId === holder.jobId) { try { unlinkSync(lockPath(key)); } catch (e) { if (e?.code !== 'ENOENT') try { rmSync(lockPath(key), { force: true }); } catch {} } }
      } catch {}
    },
  };
}

/** Backfill the real job id after a spawn whose id was unknown at acquire time (hub path). */
export function updateCwdLockHolder({ cwd, jobId }) {
  const key = normalizeCwd(cwd);
  const holder = locks.get(key);
  if (holder) { holder.jobId = jobId; writeLockFile(key, holder); }
}

/** Release whichever lock the given job holds (idempotent). */
export function releaseCwdLockByJobId(jobId) {
  let found = false;
  for (const [key, holder] of locks) {
    if (holder.jobId === jobId) { locks.delete(key); found = true; }
  }
  try {
    for (const name of readdirSync(LOCK_DIR)) {
      if (!name.endsWith('.json')) continue;
      while (true) { const raw = JSON.parse(readFileSync(join(LOCK_DIR, name), 'utf8')); if (raw?.jobId === jobId) { try { unlinkSync(join(LOCK_DIR, name)); } catch (e) { if (e?.code !== 'ENOENT') try { rmSync(join(LOCK_DIR, name), { force: true }); } catch {} } found = true; } break; }
    }
  } catch {}
  return found;
}

/** Current lock table for dsh_worker_status: which cwd is held by whom. */
export function getCwdLocks() {
  const out = [...locks.entries()].map(([cwd, holder]) => ({ cwd, holder: { ...holder } }));
  try {
    const seen = new Set(out.map((e) => e.cwd));
    for (const name of readdirSync(LOCK_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        const holder = JSON.parse(readFileSync(join(LOCK_DIR, name), 'utf8'));
        if (!holder?.cwd || seen.has(holder.cwd) || !pidAlive(Number(holder.pid))) continue;
        seen.add(holder.cwd); out.push({ cwd: holder.cwd, holder: { ...holder } });
      } catch {}
    }
  } catch {}
  return out;
}

/**
 * A hub view is terminal only when its status has left `running` AND runtime
 * disposal has finished. `needs_input` flips the status before the old runtime
 * has stopped writing; treating that as settled lets a second writer into the
 * workspace during the disposal window.
 */
export function hubViewTerminal(view) {
  return Boolean(view) && view.status !== 'running' && view.disposing !== true;
}

/**
 * Job ids whose hub-held locks are provably stale, given one authoritative job
 * list from the hub. A lock is stale when its job is absent from that list or
 * is no longer running. Callers must only pass a list that actually arrived:
 * an empty array from a failed fetch would release every hub lock and defeat
 * the same-workspace guardrail.
 */
export function settledHubLockIds(remoteJobs, currentLocks) {
  // No array means no authoritative answer; never turn that into "release all".
  if (!Array.isArray(remoteJobs)) return [];
  const byId = new Map(remoteJobs.map((j) => [j?.id, j]));
  const out = [];
  for (const entry of currentLocks ?? []) {
    const holder = entry?.holder;
    if (holder?.mode !== 'hub') continue;
    // A hub lock is acquired with jobId: null and backfilled only after
    // hub.spawn returns. That window is NOT evidence the job is gone:
    // treating it as stale would release the lock while the first worker is
    // still starting, letting a second writer into the same workspace.
    if (typeof holder.jobId !== 'string' || holder.jobId === '') continue;
    const job = byId.get(holder.jobId);
    if (job === undefined || hubViewTerminal(job)) out.push(holder.jobId);
  }
  return out;
}
