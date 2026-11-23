// One builder for the spec sent to the hub's POST /jobs route.
//
// Both blocking and async dispatch used to assemble this object inline. The
// async path once referenced `timeout` without declaring it, so every
// hub-mode dsh_spawn_worker threw "timeout is not defined" before the request
// was sent. Keeping the shape here means the timeout is a required argument
// and cannot silently disappear from one call site again.

/**
 * @param {object} spec
 * @param {string} spec.task
 * @param {'flash'|'pro'} spec.tier
 * @param {string} spec.effort
 * @param {string} spec.cwd absolute workspace path
 * @param {string} spec.source orchestrator id stamped on the job
 * @param {string|undefined} [spec.preset] hub agent preset
 * @param {number} spec.timeoutSeconds positive per-job cap
 * @param {{provider?: string, model?: string}} [spec.binding] tier route
 * @param {{chain: unknown[], depth: number}|null} [spec.origin] origin guard hop
 */
export function hubSpawnSpec({ task, tier, effort, cwd, source, preset, timeoutSeconds, binding, origin }) {
  // A config file edited by hand may carry "1800"; accept that, but never
  // undefined/NaN/0 (the bug this builder exists to prevent).
  const seconds = typeof timeoutSeconds === 'number' ? timeoutSeconds : Number(timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`hub dispatch needs a positive timeout in seconds, got: ${String(timeoutSeconds)}`);
  }
  return {
    task,
    tier,
    effort,
    cwd,
    source,
    ...(preset === undefined ? {} : { preset }),
    timeout_seconds: seconds,
    ...(binding ?? {}),
    ...(origin ? { origin_chain: origin.chain, origin_depth: origin.depth } : {}),
  };
}
