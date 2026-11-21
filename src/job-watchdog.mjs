// A hub job is a DSH agent session. Some tool paths can wait forever (a PTC
// REPL evaluation whose nested await never settles is the case we measured),
// and the agent loop has no deadline of its own. These two rules are the
// safety net: a hard runtime cap and a no-progress cap, both evaluated
// independently of what the tool is doing.

export const DEFAULT_STALL_SECONDS = 600;

/**
 * Why a running job should be stopped, or null.
 * @param {{status?: string, lastEventAt?: string|null, startedAt?: string|null, deadlineAt?: string|null, timeoutSeconds?: number|null}} job
 * @param {number} now
 * @param {number} stallSeconds
 */
export function jobProblem(job, now, stallSeconds = DEFAULT_STALL_SECONDS) {
  if (!job || job.status !== 'running') return null;
  const deadline = job.deadlineAt ? Date.parse(job.deadlineAt) : NaN;
  if (Number.isFinite(deadline) && now >= deadline) {
    return { kind: 'timeout', reason: `timed out after ${job.timeoutSeconds ?? Math.round((deadline - Date.parse(job.startedAt ?? '')) / 1000)}s` };
  }
  const last = Date.parse(job.lastEventAt ?? job.startedAt ?? '');
  if (!Number.isFinite(last)) return null;
  const quiet = Math.round((now - last) / 1000);
  if (quiet >= stallSeconds) {
    return { kind: 'stall', reason: `stalled: no session events for ${quiet}s (last tool: ${job.currentTool ?? 'none'})` };
  }
  return null;
}

/** How long a running job has been quiet, in seconds (null when unknown). */
export function quietSeconds(job, now = Date.now()) {
  const last = Date.parse(job?.lastEventAt ?? job?.startedAt ?? '');
  if (!Number.isFinite(last)) return null;
  return Math.max(0, Math.round((now - last) / 1000));
}
