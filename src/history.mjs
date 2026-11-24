// Persistent worker-task history. The live board only knows the jobs of the
// current process (plus shards of other running processes); a finished job
// disappears on restart. Every terminal job is appended here once, so the
// settings page can show a durable history board with basic aggregates.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.config', 'dsh-adapter');
const FILE = join(CONFIG_DIR, 'history.jsonl');
const MAX_RECORDS = 2000;
const MAX_BYTES = 8 * 1024 * 1024;

const clip = (value, max) => {
  if (typeof value !== 'string') return value ?? null;
  return value.length > max ? value.slice(0, max) + '…' : value;
};

/** The durable subset of a job, with long text clipped. */
export function historyRecord(job) {
  return {
    id: job.id,
    sessionId: job.sessionId ?? null,
    tier: job.tier ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    effort: job.effort ?? null,
    status: job.status ?? null,
    source: job.source ?? null,
    cwd: job.cwd ?? null,
    mode: job.mode ?? null,
    backend: job.backend ?? null,
    profile: job.profile ?? null,
    task: clip(job.task, 400),
    result: clip(job.result, 1500),
    error: clip(job.error, 400),
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    tokens: job.tokens ?? null,
    toolCalls: job.toolCalls ?? null,
    turn: job.turn ?? null,
    ...(job.questions === undefined ? {} : { questions: job.questions }),
  };
}

function lines() {
  if (!existsSync(FILE)) return [];
  try { return readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

/** Ids already persisted, so a restart does not duplicate a job. */
export function readHistoryIds() {
  const ids = new Set();
  for (const line of lines()) {
    try { const rec = JSON.parse(line); if (rec?.id) ids.add(rec.id); } catch { /* skip */ }
  }
  return ids;
}

function pruneIfNeeded() {
  try {
    if (statSync(FILE).size <= MAX_BYTES) return;
  } catch { return; }
  const kept = lines().slice(-MAX_RECORDS);
  writeFileSync(FILE, kept.join('\n') + (kept.length ? '\n' : ''));
}

export function appendHistory(job) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  appendFileSync(FILE, JSON.stringify(historyRecord(job)) + '\n');
  pruneIfNeeded();
}

/** Newest first, filtered and paged. */
export function readHistory({ limit = 100, offset = 0, tier, status, source } = {}) {
  const records = [];
  for (const line of lines()) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec?.id) continue;
    if (tier && rec.tier !== tier) continue;
    if (status && rec.status !== status) continue;
    if (source && rec.source !== source) continue;
    records.push(rec);
  }
  records.reverse();
  const page = records.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
  return { records: page, total: records.length };
}

/** Aggregates over the filtered set (all of it, not just the page). */
export function historyStats(filter = {}) {
  const { records } = readHistory({ ...filter, limit: 100000, offset: 0 });
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let durationMs = 0;
  let timed = 0;
  const byTier = {};
  for (const rec of records) {
    if (rec.status === 'done') done += 1;
    else if (rec.status === 'failed') failed += 1;
    else if (rec.status === 'cancelled') cancelled += 1;
    const start = Date.parse(rec.startedAt ?? '');
    const end = Date.parse(rec.endedAt ?? '');
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) { durationMs += end - start; timed += 1; }
    const tier = rec.tier ?? 'unknown';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  return {
    total: records.length,
    done,
    failed,
    cancelled,
    avgSeconds: timed === 0 ? 0 : Math.round(durationMs / timed / 1000),
    byTier,
  };
}

export function historyPath() { return FILE; }

/**
 * One-time import of jobs still sitting in the status shards, so a fresh
 * history file is not empty just because the board predates this feature.
 */
export function backfillHistory() {
  const dir = join(CONFIG_DIR, 'status.d');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  const known = readHistoryIds();
  let imported = 0;
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    for (const job of parsed?.jobs ?? []) {
      if (!job?.id || known.has(job.id) || !['done', 'failed', 'cancelled'].includes(job.status)) continue;
      try { appendHistory(job); known.add(job.id); imported += 1; } catch { /* skip */ }
    }
  }
  return imported;
}
