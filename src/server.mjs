// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubAvailable, hub } from './hub-client.mjs';
import { startCliJob } from './cli-workers.mjs';
import { listProfiles, resolveProfile } from './worker-profiles.mjs';
import { readInheritedOrigin, extendOrigin, DEFAULT_ORIGIN_DEPTH_LIMIT } from './origin-guard.mjs';
import { acquireCwdLock, releaseCwdLockByJobId, updateCwdLockHolder, getCwdLocks, settledHubLockIds, CwdLockError } from './cwd-lock.mjs';
import { hubSpawnSpec } from './dispatch-spec.mjs';
import { resolveWorkerCwd } from './paths.mjs';
import { detectOrchestrator } from './process-info.mjs';
import { prepareSandboxTemp } from './sandbox-temp.mjs';

// A custom TEMP without inheritable FullControl breaks every sandboxed command;
// switch to the plugin's own directory before any dispatch.
const sandboxTemp = prepareSandboxTemp();

const server = new McpServer({ name: 'dsh-adapter', version: '0.1.32' });

const tierSchema = z.enum(['flash', 'pro']).optional().describe('Worker model tier. flash = mechanical, well-scoped work (single-file edits, lookups, formatting); pro = multi-file changes, debugging, design judgment. Omit to use the session default. Ignored when worker= is set.');
const effortSchema = z.enum(['off', 'high', 'max']).optional().describe('Reasoning effort for the worker. Omit to use the session default. With worker= it only applies when passed explicitly and the profile supports it (agy maps to low/medium/high).');
const workerSchema = z.string().optional().describe('Named CLI worker profile (e.g. "agy" or "grok"). Explicit opt-in only: set it when the user explicitly asks for that external coding CLI, never as a default. When set, dispatch bypasses tier/mode and runs the task through that CLI; the profile pins backend×model×effort. See dsh_worker_config output, worker_profiles field, for the available profiles.');
const allowConcurrentCwdSchema = z.boolean().optional().describe('Allow this dispatch even though another running worker already holds the same cwd (workspace) lock. Default false: concurrent writers corrupt a shared repo, so the second dispatch is refused with the holder info instead of queueing. Set true only for read-only tasks.');

// Session-level configuration. This MCP server process lives exactly as long
// as one Claude Code / Codex session, so plain memory IS session scope.
// Initial values come from the global config (~/.config/dsh-adapter/config.json,
// edited on the DSH settings page); dsh_worker_config overrides per session.
import { readGlobalConfig } from './install/install.mjs';
import { describeBindings, resolveTierBinding } from './tier-binding.mjs';
const globalDefaults = readGlobalConfig();
const sessionConfig = {
  enabled: true,
  default_tier: globalDefaults.default_tier,
  default_effort: globalDefaults.default_effort,
  mode: globalDefaults.mode, // auto | hub | standalone
  default_timeout_seconds: globalDefaults.default_timeout_seconds,
  tier_policy: globalDefaults.tier_policy, // auto | flash-only | pro-only
  escalate_on_failure: globalDefaults.escalate_on_failure,
  preset_flash: globalDefaults.preset_flash ?? 'default',
  preset_pro: globalDefaults.preset_pro ?? 'default',
  // Tier -> LLM route. A provider id names a route the HOST already has
  // configured; blank means the tier's built-in DeepSeek default (#10).
  flash_provider: globalDefaults.flash_provider ?? '',
  flash_model: globalDefaults.flash_model ?? '',
  pro_provider: globalDefaults.pro_provider ?? '',
  pro_model: globalDefaults.pro_model ?? '',
  // WPC9: max worker→worker nesting depth before a dispatch is refused.
  origin_depth_limit: DEFAULT_ORIGIN_DEPTH_LIMIT,
};

/**
 * The {provider, model} this session pins for `tier`, or {} when the user has
 * not pinned anything. Sending the resolved default here would look like an
 * explicit choice to the hub and disable its usable-route fallback, which is
 * exactly how an install without DEEPSEEK_API_KEY kept failing.
 */
function bindingForTier(tier) {
  const pinned = [sessionConfig[`${tier}_provider`], sessionConfig[`${tier}_model`]]
    .some((v) => typeof v === 'string' && v.trim() !== '');
  return pinned ? resolveTierBinding(tier, sessionConfig) : {};
}

function presetForTier(tier) {
  const p = tier === 'flash' ? sessionConfig.preset_flash : sessionConfig.preset_pro;
  return !p || p === 'default' ? undefined : p;
}

/** Tool-layer tier enforcement: the policy overrides whatever was requested. */
function applyTierPolicy(tier) {
  if (sessionConfig.tier_policy === 'flash-only') return 'flash';
  if (sessionConfig.tier_policy === 'pro-only') return 'pro';
  return tier ?? sessionConfig.default_tier;
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// Which orchestrator spawned this MCP server — stamped on every job so the
// panel can show where a dispatch came from.
const ORCHESTRATOR = detectOrchestrator();

// ---------- WPC9 guardrails ----------

// Origin chain this adapter instance inherited from whoever spawned it (read at
// startup from the env written by the dispatching adapter — origin-guard.mjs).
// Every dispatch appends its own hop and refuses loops / over-deep chains
// BEFORE anything is spawned, so recursion can never start burning quota.
const INHERITED_ORIGIN = readInheritedOrigin(process.env);
const depthLimitNow = () => sessionConfig.origin_depth_limit ?? DEFAULT_ORIGIN_DEPTH_LIMIT;

// Hub jobs run inside the DSH host and have no settle callback on this side,
// so the origin recorded at spawn time is kept here and re-attached to every
// hub view this session returns (the hub itself ignores the extra spawn
// fields until the hub side adopts them).
const hubOrigins = new Map();

function attachOrigin(view, jobId) {
  if (!view || typeof view !== 'object') return view;
  const o = hubOrigins.get(jobId);
  if (o && view.origin_depth === undefined) {
    view.origin_depth = o.depth;
    view.origin_chain = o.chain;
  }
  return view;
}

/** Readable refusal payload for the two origin guard checks. */
function originRefusal(res) {
  return text({ error: `dispatch refused by origin guard: ${res.error.reason}`, ...res.error });
}

/**
 * Acquire the cwd advisory lock for a hub dispatch (job id is unknown until
 * the hub answers, so it is backfilled by updateCwdLockHolder). A conflict
 * against a hub-held lock is re-checked once against the hub: a hub job can
 * settle without this side ever hearing about it, and a stale lock must not
 * permanently block the cwd.
 */
async function acquireDispatchLock({ cwd, backend, mode, allowConcurrent }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireCwdLock({ cwd, jobId: null, backend, mode, startedAt: new Date().toISOString(), allowConcurrent });
    } catch (err) {
      if (!(err instanceof CwdLockError) || attempt > 0 || err.holder.mode !== 'hub') throw err;
      // The holder may still be inside hub.spawn: its jobId is null until the
      // spawn response comes back. "null" is not "no such job" — probing it
      // would release the in-flight lock and let two writers into one cwd.
      if (typeof err.holder.jobId !== 'string' || err.holder.jobId === '') throw err;
      let settled = false;
      try { settled = (await hub.get(err.holder.jobId, 0)).status !== 'running'; }
      catch (e) { if (String(e?.message ?? e).includes('no such job')) settled = true; }
      if (!settled) throw err;
      releaseCwdLockByJobId(err.holder.jobId);
    }
  }
}

function dispatchDisabled() {
  return text({
    error: 'worker dispatch is disabled for this session (set via dsh_worker_config). Report this to the user instead of doing the task yourself.',
  });
}

async function resolveMode() {
  if (sessionConfig.mode === 'standalone') return 'standalone';
  const up = await hubAvailable();
  if (sessionConfig.mode === 'hub' && !up) throw new Error('session mode is "hub" but the DSH workers hub is not reachable');
  return up ? 'hub' : 'standalone';
}

server.registerTool('dsh_run_worker', {
  title: 'Run DSH worker (blocking)',
  description: 'Run one DSH (DeepSeek Harness) coding agent task and block until it finishes. Tier guidance: flash for mechanical, well-scoped work (single-file edits, lookups, formatting); pro for multi-file changes, debugging, and design judgment. The task string must be self-contained: the worker has zero conversation context, so include absolute paths, exact acceptance criteria, and constraints. Set worker="agy" or "grok" only when the user explicitly asks for that CLI, never as a default. Guardrails refuse (never queue) worker→worker recursion beyond the origin-chain depth cap and a second writer on the same cwd; allow_concurrent_cwd: true only for read-only tasks.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained'),
    tier: tierSchema,
    effort: effortSchema,
    worker: workerSchema,
    cwd: z.string().optional().describe('Workspace directory for the worker. Relative paths resolve against the caller\'s current workspace; "." or "current" mean the current workspace. Omit for the current workspace.'),
    timeout_seconds: z.number().int().positive().max(7200).optional(),
    allow_concurrent_cwd: allowConcurrentCwdSchema,
  },
}, async ({ task, tier, effort, worker, cwd, timeout_seconds, allow_concurrent_cwd }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const e = effort ?? sessionConfig.default_effort;
  const timeout = timeout_seconds ?? sessionConfig.default_timeout_seconds;
  const depthLimit = depthLimitNow();

  // CLI profile dispatch: worker= names a profile and bypasses the
  // hub/standalone tier logic entirely (no tier policy, no escalation — the
  // profile pins backend×model×effort). Calls without worker= are untouched.
  if (worker) {
    const profile = resolveProfile(worker); // throws listing the available profile names
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let job;
    try {
      job = await startCliJob({ worker, task, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    const view = jobView(job, { withResult: true });
    if (view.status === 'running') return text({ ...view, note: `still running after ${timeout}s; poll with dsh_worker_result` });
    return text(view);
  }

  const runOnce = async (t) => {
    if ((await resolveMode()) === 'hub') {
      const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
      if (!origin.ok) return { refusal: originRefusal(origin) };
      let lock;
      try {
        lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
      } catch (err) {
        if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
        throw err;
      }
      let spawned;
      try {
        spawned = await hub.spawn(hubSpawnSpec({
          task, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR,
          preset: presetForTier(t), timeoutSeconds: timeout,
          binding: bindingForTier(t), origin: origin.origin,
        }));
        updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
        hubOrigins.set(spawned.id, origin.origin);
      } catch (err) {
        lock.release();
        throw err;
      }
      // The hub client slices this wait internally; a single request that
      // waits minutes would be cut by undici's 300 s header timeout and
      // reported as a bare "fetch failed" while the job kept running.
      const got = await hub.get(spawned.id, timeout);
      attachOrigin(got, spawned.id);
      if (got.status !== 'running') releaseCwdLockByJobId(spawned.id);
      return { view: got };
    }
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return { refusal: originRefusal(origin) };
    let job;
    try {
      job = await startJob({ task, tier: t, effort: e, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, ...bindingForTier(t) });
    } catch (err) {
      if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    return { view: jobView(job, { withResult: true }) };
  };

  const firstTier = applyTierPolicy(tier);
  let res = await runOnce(firstTier);
  if (res.refusal) return res.refusal;
  let job = res.view;
  if (job.status === 'running') return text({ ...job, note: `still running after ${timeout}s; poll with dsh_worker_result` });

  // Escalate on evidence, not prediction: a failed flash run retries once on
  // pro — unless the policy pins the tier to flash.
  if (job.status === 'failed' && sessionConfig.escalate_on_failure
      && firstTier === 'flash' && sessionConfig.tier_policy !== 'flash-only') {
    const firstError = job.error ?? job.stopReason ?? 'unknown failure';
    res = await runOnce('pro');
    if (res.refusal) return res.refusal;
    job = res.view;
    if (job.status === 'running') return text({ ...job, escalated: true, note: `escalated to pro, still running after ${timeout}s; poll with dsh_worker_result` });
    return text({ ...job, escalated: true, flash_failure: String(firstError).slice(0, 200) });
  }
  return text(job);
});

server.registerTool('dsh_worker_probe', {
  title: 'Probe a configured worker model route',
  description: 'Explicitly test one DSH-configured provider/model with a small no-op tool-call request. Requires the hub. Does not start a worker, touch files, or change bindings; it may consume one model request. A listed provider is not proof of agent/tool support. Results are observations at checked_at, not a permanent capability guarantee.',
  inputSchema: { tier: z.enum(['flash', 'pro']).optional(), provider: z.string().optional(), model: z.string().optional() },
}, async ({ tier, provider, model }) => {
  if (!(await hubAvailable())) return text({ status: 'hub_unavailable', tool_call_verified: false });
  const bound = bindingForTier(tier ?? sessionConfig.default_tier);
  return text(await hub.probe({ provider: provider?.trim() || bound.provider, model: model?.trim() || bound.model }));
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or update session-level worker settings: enable/disable dispatch, default tier/effort/timeout, execution mode (auto = prefer hub, hub = require the DSH hub, standalone = never use it), tier policy, failure escalation, and which LLM route each tier dispatches to. Call with no arguments to read. To run workers on a local model (Ollama and the like), configure that provider ONCE in DSH and then name it here with flash_provider/flash_model or pro_provider/pro_model — this plugin never defines providers of its own. available_providers lists what the host has configured (hub mode only); bindings shows what each tier currently resolves to. The output includes worker_profiles — the external-CLI backends (agy, grok) usable via the worker= parameter of dsh_run_worker / dsh_spawn_worker — and origin, the inherited worker→worker dispatch chain with its depth limit. Session-only.',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub', 'standalone']).optional(),
    default_timeout_seconds: z.number().int().positive().max(7200).optional(),
    tier_policy: z.enum(['auto', 'flash-only', 'pro-only']).optional().describe('flash-only / pro-only clamp every dispatch to one tier'),
    escalate_on_failure: z.boolean().optional().describe('retry a failed blocking flash run once on pro'),
    preset_flash: z.string().optional().describe('hub-mode agent preset for flash workers (preset id, or "default")'),
    preset_pro: z.string().optional().describe('hub-mode agent preset for pro workers (preset id, or "default")'),
    flash_provider: z.string().optional().describe('LLM provider route the flash tier dispatches to. Must be a provider DSH already has configured — see available_providers in this tool\'s output. Empty string restores the built-in DeepSeek default. Configure the provider itself in DSH, not here.'),
    flash_model: z.string().optional().describe('Model id for the flash tier, as that provider names it (e.g. a local Ollama model). Empty string restores the default.'),
    pro_provider: z.string().optional().describe('LLM provider route the pro tier dispatches to. Same rules as flash_provider.'),
    pro_model: z.string().optional().describe('Model id for the pro tier. Empty string restores the default.'),
    origin_depth_limit: z.number().int().min(1).max(32).optional().describe('Max worker→worker origin-chain depth (default 3). Deeper dispatches are refused to stop recursive self-amplification; raise only for deliberate deep delegation.'),
    reset: z.boolean().optional().describe('true = restore all defaults first'),
  },
}, async ({ reset, ...patch }) => {
  if (reset) {
    Object.assign(sessionConfig, { enabled: true, ...globalDefaults });
    sessionConfig.origin_depth_limit = DEFAULT_ORIGIN_DEPTH_LIMIT;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) sessionConfig[k] = v;
  const reachable = await hubAvailable();
  // Only the hub can enumerate the host's LLM routes (this process has no
  // ctx.llm), so in standalone mode the list is honestly absent rather than
  // empty — "we cannot see them" is not "there are none".
  const available = reachable ? (await hub.providers()).providers : null;
  const bindings = describeBindings(sessionConfig);
  const custom = Object.entries(bindings).filter(([, b]) => b.custom).map(([tier]) => tier);
  const unknown = available === null
    ? []
    : custom.filter((tier) => !available.some((p) => p.id === bindings[tier].provider));
  const availableModels = available === null
    ? null
    : Object.fromEntries(available.map((p) => [p.id, p.models ?? []]));
  return text({
    ...sessionConfig,
    hub_reachable: reachable,
    bindings,
    available_providers: available,
    available_models: availableModels,
    ...(available === null && custom.length > 0
      ? { providers_note: 'The hub is not reachable, so the configured provider ids could not be checked against what DSH actually has. A route DSH does not know will fail at dispatch, not here.' }
      : {}),
    ...(unknown.length > 0
      ? { providers_warning: `DSH has no provider route named ${unknown.map((t) => JSON.stringify(bindings[t].provider)).join(', ')} (bound to: ${unknown.join(', ')}). Configure it in DSH first, or these dispatches will fail.` }
      : {}),
    ...(custom.length > 0
      ? { route_caveat: 'Appearing in available_providers only means an adapter is registered, NOT that it can run a worker. Measured: a route registered purely to re-route another provider fails a dispatch with "registration.adapter.prepareCall is not a function". Nor does DSH report tool-calling support anywhere, and a worker that cannot call tools returns prose and touches no files. A tier bound to a custom route is therefore UNVERIFIED until you call dsh_worker_probe for the configured route; the probe observes one request and is not a permanent capability guarantee.' }
      : {}),
    worker_profiles: listProfiles(),
    origin: { chain: INHERITED_ORIGIN.chain, depth: INHERITED_ORIGIN.depth, depth_limit: depthLimitNow() },
  });
});

server.registerTool('dsh_spawn_worker', {
  title: 'Spawn DSH worker (async)',
  description: 'Start a DSH (DeepSeek Harness) coding agent in the background and return immediately with a job id — use it to fan out several workers in parallel. The spawn response carries claims, not results: always fetch each job\'s final result later with dsh_worker_result. Same tier guidance as dsh_run_worker: flash for mechanical, well-scoped work, pro for multi-file changes and debugging. The task string must be self-contained (absolute paths, acceptance criteria, constraints) — the worker sees nothing of your conversation. worker="agy" or "grok" only when the user explicitly asks for that CLI, never a default. Guardrails refuse (never queue) origin-chain recursion and a second writer on the same cwd; allow_concurrent_cwd: true only for read-only fan-out.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained — the worker has no conversation context, so include absolute paths, acceptance criteria and constraints'),
    tier: tierSchema,
    effort: effortSchema,
    worker: workerSchema,
    cwd: z.string().optional().describe('Workspace directory for the worker. Relative paths resolve against the caller\'s current workspace; "." or "current" mean the current workspace. Omit for the current workspace.'),
    allow_concurrent_cwd: allowConcurrentCwdSchema,
  },
}, async ({ task, tier, effort, worker, cwd, allow_concurrent_cwd }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const depthLimit = depthLimitNow();
  // This tool starts the job and returns immediately, so the cap is the
  // session default (there is no per-call timeout_seconds in its schema).
  const timeout = sessionConfig.default_timeout_seconds;
  if (worker) {
    // CLI profile dispatch; no hub/standalone involvement, no tier policy.
    const profile = resolveProfile(worker);
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    try {
      const job = await startCliJob({ worker, task, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
      return text(jobView(job));
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
  }
  const t = applyTierPolicy(tier);
  const e = effort ?? sessionConfig.default_effort;
  if ((await resolveMode()) === 'hub') {
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let lock;
    try {
      lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    let spawned;
    try {
      spawned = await hub.spawn(hubSpawnSpec({
        task, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR,
        preset: presetForTier(t), timeoutSeconds: timeout,
        binding: bindingForTier(t), origin: origin.origin,
      }));
      updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
      hubOrigins.set(spawned.id, origin.origin);
    } catch (err) {
      lock.release();
      throw err;
    }
    attachOrigin(spawned, spawned.id);
    return text(spawned);
  }
  const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
  if (!origin.ok) return originRefusal(origin);
  try {
    const job = await startJob({ task, tier: t, effort: e, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, ...bindingForTier(t) });
    return text(jobView(job));
  } catch (err) {
    if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
    throw err;
  }
});

server.registerTool('dsh_worker_status', {
  title: 'DSH worker status',
  description: 'List all DSH worker jobs in this session with live progress (turn/step, current tool, token usage) plus the cwd advisory locks (kind: "cwd-lock" entries show which workspace is held by which running job). Use it before dispatching into a busy workspace and to see whether spawned jobs are still running.',
  inputSchema: {},
}, async () => {
  const hubUp = await hubAvailable();
  // null means "the list did not arrive" (hub down or the fetch failed); []
  // means the hub answered and has no jobs. Only the latter may release locks:
  // a down hub says nothing about whether its jobs still run.
  const remote = hubUp ? await hub.list().catch(() => null) : null;
  // Only an actual array is an authoritative answer. A hub that answered 200
  // without a jobs field yields undefined, which must not be converted to []
  // and then treated as "the hub has no jobs" (that would release every lock).
  const arrived = Array.isArray(remote);
  const remoteJobs = arrived ? remote : [];
  if (arrived) {
    // The list actually arrived: hub-held locks whose job is settled or gone
    // release now.
    for (const jobId of settledHubLockIds(remoteJobs, getCwdLocks())) releaseCwdLockByJobId(jobId);
  }
  for (const j of remoteJobs) attachOrigin(j, j.id);
  const local = listJobs().map((j) => jobView(j));
  const locks = getCwdLocks().map((l, i) => ({
    kind: 'cwd-lock',
    id: `cwd-lock-${i + 1}`,
    cwd: l.cwd,
    holder: l.holder,
    note: 'advisory workspace lock: a running worker holds this cwd, so a new dispatch to it is refused (unless allow_concurrent_cwd is set)',
  }));
  return text([...remoteJobs, ...local, ...locks]);
});

server.registerTool('dsh_worker_result', {
  title: 'DSH worker result',
  description: 'Fetch the final result of a worker job, optionally waiting up to wait_seconds. Always call this for spawned jobs: the dsh_spawn_worker response returns only the job id and status claims, never the result. If a result seems missing or stale (for example after a hub restart orphaned the job), verify against the working tree and dsh_worker_status instead of trusting the summary.',
  inputSchema: {
    job_id: z.string(),
    wait_seconds: z.number().int().min(0).max(7200).default(0).describe('0 = return current state immediately'),
  },
}, async ({ job_id, wait_seconds }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    const view = await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      if (view.status !== 'running') releaseCwdLockByJobId(job_id);
    }
    return text(view);
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  return text(jobView(job, { withResult: true }));
});


server.registerTool('dsh_worker_watch', {
  title: 'Follow a DSH worker live',
  description: 'Return the next slice of a running worker live events: tool calls (with their arguments), tool results, assistant text, step boundaries, as they happen. Call it repeatedly with the returned cursor to narrate real progress to the user instead of guessing. Blocks up to wait_seconds while waiting for something to happen. Hub mode only.',
  inputSchema: {
    job_id: z.string(),
    after: z.number().int().min(0).default(0).describe('Cursor from the previous response; 0 starts from the earliest retained event'),
    wait_seconds: z.number().int().min(0).max(120).default(30).describe('How long to wait for new events before returning an empty slice'),
  },
}, async ({ job_id, after, wait_seconds }) => {
  if (!(await hubAvailable())) return text({ error: 'hub not reachable; live events are only available in hub mode' });
  try {
    return text(await hub.events(job_id, after, wait_seconds));
  } catch (err) {
    return text({ error: err?.message ?? String(err) });
  }
});

server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a running worker job: terminates its runtime process and releases its cwd lock. Use it when a workspace lock is held by a job that is stuck or no longer needed, so a new dispatch to that cwd can proceed.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    const view = await hub.cancel(job_id).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      releaseCwdLockByJobId(job_id); // cancelled = holder being disposed
    }
    return text(view);
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  return text(jobView(await cancelJob(job_id), { withResult: true }));
});

await server.connect(new StdioServerTransport());
