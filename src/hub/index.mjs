// DSH host plugin: workers-hub.
// Runs DeepSeek workers as first-class in-host agent sessions (visible in the
// Web UI session list), exposes a loopback jobs API for the CC/Codex MCP shim,
// and serves the one-click installer endpoints for the settings page.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAbsoluteCwd, canonicalCwd } from '../paths.mjs';
import { createShardWriter, readMergedStatus } from '../status-shard.mjs';
import { procAlive, killWorkerProcess, parsePid, ProcKillRefused } from '../proc-kill.mjs';
import { installWorkerQuestionHandoff } from '../worker-question.mjs';
import { appendHistory, backfillHistory, historyStats, readHistory, readHistoryIds } from '../history.mjs';
import { DEFAULT_STALL_SECONDS, jobProblem, quietSeconds } from '../job-watchdog.mjs';
import { prepareSandboxTemp } from '../sandbox-temp.mjs';


/** One readable line per session event, kept in a small per-job ring so a
 *  caller can follow tool calls and commands without reading the transcript. */
function eventRecord(event, seq) {
  const at = new Date().toISOString();
  const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);
  const textBlocks = (message) => (Array.isArray(message?.content) ? message.content : [])
    .filter((c) => c?.type === 'text').map((c) => c.text).join('');
  const safeJson = (value) => { try { return JSON.stringify(value ?? ''); } catch { return String(value); } };
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'step/start':
      return { seq, at, kind: 'step', turn: data.turn ?? null, step: data.step ?? null };
    case 'tool/call':
      return { seq, at, kind: 'tool', tool: data.name ?? 'tool', detail: clip(safeJson(data.input ?? data.arguments ?? ''), 300) };
    case 'tool/result': {
      const text = textBlocks(data.message).replace(/\s+/g, ' ');
      const detail = text || (typeof data.error === 'object' ? data.error?.name ?? '' : data.error) || '';
      return { seq, at, kind: 'tool-result', tool: data.name ?? null, ok: data.ok ?? null, detail: clip(String(detail), 400) };
    }
    case 'approval/asked':
      return { seq, at, kind: 'approval', tool: data.tool ?? data.request?.tool ?? null, detail: clip(String(data.reason ?? data.request?.reason ?? 'approval requested'), 300) };
    case 'approval/decided':
      return { seq, at, kind: 'approval-result', detail: clip(String(data.outcome ?? data.decision ?? ''), 120) };
    case 'assistant/message': {
      const text = textBlocks(data.message);
      return { seq, at, kind: 'text', text: clip(text, 500) };
    }
    case 'turn/end':
      return { seq, at, kind: 'turn-end', reason: data.reason?.kind ?? null };
    default:
      return { seq, at, kind: event?.type ?? 'event' };
  }
}

const HISTORY_TERMINAL = new Set(['done', 'failed', 'cancelled', 'needs_input']);
import { probeProvider } from '../provider-probe.mjs';

// No @deepseek-ai imports here on purpose: this plugin is loaded into the
// profile realm, and importing our own package copies would create duplicate
// module realms (symbol identity mismatches in the tool runtime). Everything
// below is either plain data or inlined logic that only touches ctx APIs.

/** Inlined from @deepseek-ai/dsh-agent model-selection.ts (same semantics). */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _cause, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
  });
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest, provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

/** Inlined shape of createUserMessage (role + fresh id, frozen). */
function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

/**
 * The rejection a worker's ask_user_question receives. Shaped like the host's
 * UserQuestionError (name + code) so the seam restores it as one and the
 * model sees the message, the same way the host answers a question from a
 * child agent that has no human either (DELEGATED_CALLER).
 */
export function unattendedQuestion() {
  const error = new Error(
    'no one is attending this dsh-adapter worker session, so a question cannot be answered and must not be waited on. '
    + 'Stop and put the unresolved question in your final message so the orchestrator can obtain the required answer or approval. '
    + 'An unanswered question grants no permission; never select an option automatically.',
  );
  error.name = 'UserQuestionError';
  error.code = 'UNATTENDED_WORKER';
  return error;
}

export const name = 'dsh-adapter';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'llm', 'attachments'];

// Optional: the host's durable locale preference seeds server-side strings
// before the panel is ever opened. Absent preference means "browser decides".
function seedLangFromHost(ctx) {
  try {
    const pref = ctx.settings?.get?.('locale')?.preference;
    if (pref) setLang(pref);
  } catch { /* settings service absent or shaped differently — keep the default */ }
}

import { setLang } from '../i18n.mjs';

const ROUTE_BASE = '/_dsh/dsh-adapter';
// Tier -> {provider, model}. The defaults live in tier-binding.mjs; the
// caller may override per dispatch, and the hub's own config is the fallback
// when it does not (the same shape the preset lookup below uses).
import { describeBindings, resolveTierBinding, TIERS } from '../tier-binding.mjs';
import { readGlobalConfig, writeGlobalConfig } from '../install/install.mjs';
import { readCapsCache, writeCapsCache, capsFor, resolveProviderEndpoint, fetchUpstreamCaps } from '../model-caps.mjs';
const CONFIG_DIR = join(homedir(), '.config', 'dsh-adapter');

// A hub process can run for weeks. Keep completed jobs long enough for the
// UI/result calls to read them, then drop them: each job retains its event
// ring, final text and (until settle) the runtime handle, so an unbounded map
// is a slow memory leak in exactly the long-lived process that must stay up.
const SETTLED_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SETTLED_JOBS = 500;
// An auto-bound route is a cache entry, not a permanent fact: a local model can
// be unloaded or a provider removed while the host keeps running.
const AUTO_ROUTE_TTL_MS = 5 * 60 * 1000;

// ---------- job registry ----------

/** Bounded task preview with a visible truncation marker (PATTERN-AUDIT D3:
// a silently truncated task reads like the whole brief in status views). */
export function clipTask(task, cap = 300) {
  const text = String(task ?? '');
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}

export class WorkerRegistry {
  constructor(ctx, shard = createShardWriter('hub')) {
    this.ctx = ctx;
    this.jobs = new Map();
    this.nextId = 1;
    this.shard = shard;
  }

  view(job, withResult = false) {
    const v = {
      id: job.id, sessionId: job.sessionId, tier: job.tier, model: job.model, provider: job.provider,
      effort: job.effort, status: job.status, source: job.source, task: clipTask(job.task),
      cwd: job.cwd, turn: job.turn, step: job.step, currentTool: job.currentTool,
      toolCalls: job.toolCalls, tokens: job.tokens, mode: 'hub',
      startedAt: job.startedAt, endedAt: job.endedAt,
      lastEventAt: job.lastEventAt ?? null, timeoutSeconds: job.timeoutSeconds ?? null,
      deadlineAt: job.deadlineAt ?? null, staleSeconds: quietSeconds(job),
      eventSeq: job.eventSeq ?? 0, events: (job.events ?? []).slice(-12),
      disposing: job.disposing === true,
      ...(job.questions === undefined ? {} : { questions: job.questions }),
    };
    if (withResult) {
      v.result = job.result; v.error = job.error; v.stopReason = job.stopReason;
      v.reasonDetail = job.reasonDetail;
    }
    return v;
  }

  publish() {
    const jobs = [...this.jobs.values()];
    this.shard.publish(jobs.map((j) => this.view(j)));
    // Persist each terminal job exactly once; the live board forgets on restart.
    this.recorded ??= readHistoryIds();
    for (const job of jobs) {
      if (!HISTORY_TERMINAL.has(job.status) || this.recorded.has(job.id)) continue;
      try { appendHistory(job); this.recorded.add(job.id); } catch { /* history is best-effort */ }
    }
  }

  /**
   * Ask the host what reasoning efforts this exact model accepts. DSH resolves
   * model metadata through the adapter (the same call that rejects an
   * unsupported effort before any provider I/O), so this is the authoritative
   * dictionary - no provider-specific guessing. Returns {effort} for the value
   * to dispatch with, or null when the adapter offers no reasoning metadata.
   */
  /** The provider's own catalog, cached on disk; undefined when unreachable. */
  async upstreamCaps(provider) {
    const cfg = this.getConfig?.() ?? {};
    const ttl = Number(cfg.caps_ttl_seconds) || undefined;
    this.capsCache ??= readCapsCache();
    const cached = capsFor(this.capsCache, provider, ttl);
    if (cached) return cached;
    const endpoint = resolveProviderEndpoint(provider, (cfg.upstream_caps ?? {})[provider]);
    if (!endpoint) return undefined;
    const entry = await fetchUpstreamCaps(provider, endpoint, { ttlSeconds: ttl });
    this.capsCache = writeCapsCache(provider, entry);
    return entry;
  }

  /**
   * Which effort to dispatch with, using the upstream catalog when it answers
   * and the host's local metadata as the fallback. Both describe the same model,
   * so only the intersection is safe: the upstream may have dropped a level the
   * profile still declares (the pro-model thrash this plugin kept hitting).
   *   { effort }  dispatch this effort (undefined = no reasoning option)
   *   { skip: true } the two sources disagree; do not bind this model
   *   null        no local reasoning metadata at all; let the probe decide
   */
  async effortForModel(llm, binding, desired) {
    if (typeof llm.resolveModelInfo !== 'function') return null;
    let info;
    try { info = await llm.resolveModelInfo(binding.provider, binding.model); }
    catch { return null; }
    const reasoning = info?.reasoning;
    if (!reasoning) return { effort: undefined, supported: [] };
    const local = (reasoning.efforts ?? []).map((e) => e.id).filter((id) => typeof id === 'string');
    if (local.length === 0) return null;

    let upstream;
    try {
      const caps = await this.upstreamCaps(binding.provider);
      const entry = caps?.models?.[binding.model];
      if (entry && Array.isArray(entry.efforts)) upstream = entry.efforts;
    } catch { /* catalog optional */ }

    const allowed = upstream ? local.filter((id) => upstream.includes(id)) : local;
    const source = upstream ? 'upstream' : 'local';
    if (allowed.length === 0) return { skip: true, supported: [], source };
    const pick = (wanted) => {
      if (wanted === undefined) return reasoning.defaultEffort && allowed.includes(reasoning.defaultEffort) ? reasoning.defaultEffort : allowed[0];
      if (allowed.includes(wanted)) return wanted;
      for (const candidate of ['max', 'high', 'medium', 'low', 'off']) {
        if (allowed.includes(candidate)) return candidate;
      }
      return allowed[0];
    };
    return { effort: pick(desired), supported: allowed, source };
  }

  /** One bounded capability probe; the route counts as usable when it streams. */
  async probeRoute(llm, binding, effort) {
    try {
      const result = await probeProvider(llm, { ...binding, ...(effort ? { reasoningEffort: effort } : {}) }, { timeoutMs: 12000 });
      return result.status === 'verified' || result.status === 'no_tool_call';
    } catch { return false; }
  }

  /**
   * Resolve a tier that the user has not pinned. The shipped default route
   * (deepseek-official) fails on installs without DEEPSEEK_API_KEY, and a
   * provider that exists may still have no channel for the requested model —
   * the pro tier hits exactly that. Probe the configured providers, take the
   * first route that streams, and persist it so later dispatches skip the
   * search. Pinned bindings never reach this path.
   */
  async resolveUsableTier(tier, bound, effort) {
    this.autoTier ??= {};
    const cacheKey = tier + ':' + effort + ':' + bound.provider + ':' + bound.model;
    const cached = this.autoTier[cacheKey];
    if (cached && Date.now() - (cached.at ?? 0) < AUTO_ROUTE_TTL_MS) return cached;
    const llm = this.ctx?.get?.('llm') ?? this.ctx?.llm;
    if (!llm) return cached ?? { binding: bound, effort };
    if (cached && await this.probeRoute(llm, cached.binding, cached.effort)) {
      cached.at = Date.now();
      return cached;
    }
    if (cached) delete this.autoTier[cacheKey];
    if (await this.probeRoute(llm, bound, effort)) { this.autoTier[cacheKey] = { binding: bound, effort, at: Date.now() }; return this.autoTier[cacheKey]; }
    const builtin = new Set(['deepseek-official', 'deepseek-account']);
    let ids = [];
    try {
      ids = llm.listProviders().map((p) => p.id).filter((id) => id !== bound.provider);
    } catch { return { binding: bound, effort }; }
    ids.sort((a, b) => Number(builtin.has(a)) - Number(builtin.has(b)));
    const candidates = [];
    for (const id of ids) {
      let models = [];
      try { models = await llm.listModels(id); } catch { continue; }
      for (const m of models.slice(0, 3)) candidates.push({ provider: id, model: m.id });
      if (candidates.length >= 5) break;
    }
    for (const candidate of candidates) {
      const known = await this.effortForModel(llm, candidate, effort);
      let attemptEffort;
      if (known?.skip) continue;
      if (known) {
        // The host already answered which efforts this model accepts; the
        // probe below only proves the route streams.
        attemptEffort = known.supported.length === 0 ? undefined : known.effort;
        if (!(await this.probeRoute(llm, candidate, attemptEffort))) continue;
      } else {
        // No reasoning metadata from the adapter: probe the wanted effort, then
        // 'off', which is the cheapest compatible setting.
        attemptEffort = undefined;
        for (const candidateEffort of effort && effort !== 'off' ? [effort, 'off'] : [effort ?? undefined]) {
          if (await this.probeRoute(llm, candidate, candidateEffort)) { attemptEffort = candidateEffort; break; }
        }
        if (attemptEffort === undefined && !(await this.probeRoute(llm, candidate, undefined))) continue;
      }
      const chosen = { binding: candidate, effort: attemptEffort, at: Date.now() };
      this.autoTier[cacheKey] = chosen;
      try {
        writeGlobalConfig({
          [`${tier}_provider`]: candidate.provider,
          [`${tier}_model`]: candidate.model,
          [`${tier}_auto`]: true,
        });
      } catch { /* read-only home: keep the in-memory choice */ }
      this.ctx?.logger?.info?.(`dsh-adapter: ${tier} auto-bound to ${candidate.provider}/${candidate.model} @ ${attemptEffort ?? '(none)'} [${known?.source ?? 'probe'}]`);
      return chosen;
    }
    this.ctx?.logger?.warn?.(`dsh-adapter: no usable ${tier} route; keeping ${bound.provider}/${bound.model}`);
    return { binding: bound, effort };
  }

  async spawn({ task, tier = 'flash', effort = 'max', cwd, source = 'api', provider, model, preset, timeout_seconds }) {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new Error('task must be a non-empty string');
    }
    if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
    if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}"`);
    // Accept POSIX, Windows drive (D:\x, C:/x) and UNC (\\srv\share) roots.
    if (!isAbsoluteCwd(cwd)) throw new Error('cwd must be an absolute path');
    if (timeout_seconds !== undefined) {
      const n = Number(timeout_seconds);
      if (!Number.isFinite(n) || n <= 0) throw new Error('timeout_seconds must be a positive number');
    }
    // An explicit {provider, model} from the caller wins (the MCP process owns
    // session-level overrides, exactly as it does for presets); otherwise the
    // hub's own stored config decides, and failing that the tier default.
    const tierConfig = this.getConfig?.() ?? {};
    const explicitArgs = [provider, model].some((v) => typeof v === 'string' && v.trim() !== '');
    const configPinned = [tierConfig[`${tier}_provider`], tierConfig[`${tier}_model`]]
      .some((v) => typeof v === 'string' && v.trim() !== '') && tierConfig[`${tier}_auto`] !== true;
    const pinned = explicitArgs || configPinned;
    let bound = resolveTierBinding(tier, tierConfig);
    let dispatchEffort = effort;
    // An unpinned tier gets a route that actually works for this effort; an
    // auto-bound one is re-checked because the model catalog can change.
    if (!pinned) {
      const usable = await this.resolveUsableTier(tier, bound, effort);
      bound = usable.binding;
      // `undefined` is a real answer here: a model whose local metadata
      // declares no reasoning must be dispatched WITHOUT an effort, or DSH
      // rejects the call. Only a missing key falls back to the requested one.
      dispatchEffort = Object.prototype.hasOwnProperty.call(usable, 'effort') ? usable.effort : effort;
    }
    const resolvedProvider = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : bound.provider;
    const resolvedModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : bound.model;
    // One canonical form for the job, the advisory lock and the workspace
    // lookup: D:/x and D:\x must map to the same workspace on Windows.
    const cwdPath = canonicalCwd(cwd);
    await this.ctx.get('loader')?.await();

    const id = `hub-${this.nextId++}-${process.pid.toString(36)}-${Date.now().toString(36)}`;
    const sessionId = `session-${randomUUID()}`;
    const timeoutSec = Number(timeout_seconds) > 0
      ? Number(timeout_seconds)
      : (Number(this.getConfig?.().default_timeout_seconds) || 1800);
    const startedAt = new Date().toISOString();
    const job = {
      id, sessionId, tier, model: resolvedModel, provider: resolvedProvider, effort: dispatchEffort, task, source, cwd: cwdPath, mode: 'hub',
      status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      startedAt, endedAt: null, lastEventAt: startedAt, timeoutSeconds: timeoutSec,
      deadlineAt: new Date(Date.now() + timeoutSec * 1000).toISOString(),
      result: null, error: null, stopReason: null, handle: null, waiters: [],
      lastText: '', events: [], eventSeq: 0, disposing: false,
    };
    const selection = { provider: resolvedProvider, model: resolvedModel, reasoningEffort: dispatchEffort };
    const presets = this.ctx.get('agentPresets');
    const cfg = this.getConfig?.() ?? {};
    const wanted = preset ?? (tier === 'flash' ? cfg.preset_flash : cfg.preset_pro);
    const presetId = presets === undefined
      ? undefined
      : (await presets.resolve(!wanted || wanted === 'default' ? undefined : wanted)).id;
    this.jobs.set(id, job);

    const onEvent = (session, event) => {
      // Late events from a disposed/cancelled session must not revive the live
      // view (or refresh lastEventAt) after the job has settled.
      if (job.status !== 'running') return;
      job.lastEventAt = new Date().toISOString();
      job.events.push(eventRecord(event, ++job.eventSeq));
      if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
      switch (event.type) {
        case 'step/start':
          job.turn = event.data?.turn ?? job.turn;
          job.step = event.data?.step ?? job.step;
          break;
        case 'tool/call': job.currentTool = event.data?.name ?? null; job.toolCalls += 1; break;
        case 'tool/result': job.currentTool = null; break;
        case 'assistant/message': {
          const u = event.data?.usage;
          if (u) {
            job.tokens.input += u.inputTokens ?? 0;
            job.tokens.output += u.outputTokens ?? 0;
            job.tokens.reasoning += u.reasoningTokens ?? 0;
          }
          const text = (event.data?.message?.content ?? [])
            .filter((c) => c?.type === 'text').map((c) => c.text).join('');
          if (text) job.lastText = text;
          break;
        }
        case 'turn/end':
          job.stopReason = event.data?.reason?.kind ?? null;
          job.reasonDetail = event.data?.reason;
          break;
      }
      this.publish();
    };

    const run = async () => {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: cwdPath, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
          if (presets !== undefined) await presets.mount(agentCtx, presetId);
          // Nobody attends a worker session, so a question would wait forever
          // (#13). Claim this agent's requests ahead of the Web answerer.
          installWorkerQuestionHandoff(agentCtx, job, () => this.publish());
          agentCtx.on('session/event', onEvent);
          agentCtx.on('agent/error', (payload) => {
            const err = payload?.error;
            if (job.status !== 'needs_input') job.error = err?.message ?? String(err);
          });
        },
      });
      job.handle = handle;
      if (job.status !== 'running') {
        try { await handle.dispose(); } catch {}
        job.disposing = false;
        return;
      }
      // Nobody attends a worker session, so an interactive approval would sit
      // until the job timeout (or forever before the watchdog existed).
      // 'never' makes the tool call fail closed immediately with a clear
      // message the model can react to.
      try {
        const approval = this.ctx.get?.('approval') ?? this.ctx.approval;
        approval?.setPolicy?.(handle.agent, 'never');
      } catch { /* older hosts: leave the default policy */ }
      if (job.status === 'needs_input') { await handle.dispose(); return; }
      try {
        // Group the worker session under the workspace of its cwd; create the
        // workspace when none exists yet (resolveByPath is exact-match, so a
        // job cwd never inherits a parent directory's workspace).
        const registry = this.ctx.get('workspaceRegistry');
        if (registry !== undefined) {
          const ws = (await registry.resolveByPath(cwdPath)) ?? (await registry.create(cwdPath));
          await ws.attachSession(sessionId);
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`dsh-adapter: workspace attach failed for ${cwdPath}: ${err?.message ?? err}`);
      }
      await handle.agent.whenIdle();
      if (job.status !== 'running') return;
      handle.agent.followup(userMessage(task));
      await handle.agent.whenIdle();
      if (job.status === 'running') {
        job.result = job.lastText ?? '';
        job.status = job.stopReason === 'completed' ? 'done' : 'failed';
      }
      if (job.status === 'failed' && !job.error) job.error = `turn ended: ${job.stopReason ?? 'unknown'}`;
      await this.ctx.sessions.flush(handle.agent.session);
      // Normal completion must dispose the handle too: DSH keeps the agent
      // registered and its session/listeners alive until dispose(), which is
      // what unregisters it. Relying on job-map pruning alone would leave one
      // live agent per completed task in a long-lived host.
      try { await handle.dispose(); } catch { /* already disposed */ }
    };

    job.promise = run()
      .catch((err) => {
        if (job.status === 'running') job.status = 'failed';
        job.error = job.error ?? (err?.message ?? String(err));
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        job.handle = null;
        if (job.status === 'cancelled') job.disposing = false;
        this.publish();
        for (const w of job.waiters.splice(0)) w();
      });

    this.publish();
    this.startWatchdog();
    return job;
  }

  /** One interval for every job in this process; cheap and unref'd. */
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.sweepStalled(), 30_000);
    this.watchdog.unref?.();
  }

  sweepStalled() {
    const stall = Number(this.getConfig?.().stall_timeout_seconds) > 0
      ? Number(this.getConfig().stall_timeout_seconds)
      : DEFAULT_STALL_SECONDS;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const problem = jobProblem(job, now, stall);
      if (!problem) continue;
      job.status = 'failed';
      job.error = problem.reason;
      job.endedAt = new Date().toISOString();
      // Keep the cwd lock until the runtime has actually stopped: a status
      // flip alone is not proof that the old session stopped writing.
      job.disposing = true;
      this.publish();
      const handle = job.handle;
      let disposal;
      try { disposal = Promise.resolve(handle?.dispose?.()); }
      catch { disposal = Promise.resolve(); }
      disposal
        .catch(() => {})
        .finally(() => { job.disposing = false; this.publish(); });
      for (const w of job.waiters.splice(0)) w();
    }
    this.pruneSettled(now);
  }

  /**
   * Drop settled jobs after a retention window and cap the terminal backlog.
   * The live board is a UI convenience; durable history is already written by
   * publish(), so losing a terminal job here only changes /jobs lookups.
   */
  pruneSettled(now = Date.now()) {
    const terminal = [];
    for (const [id, job] of this.jobs) {
      if (job.status === 'running' || job.disposing === true || !job.endedAt) continue;
      const ended = Date.parse(job.endedAt);
      if (Number.isFinite(ended)) terminal.push({ id, ended });
    }
    terminal.sort((a, b) => a.ended - b.ended);
    for (const { id, ended } of terminal) {
      if (now - ended > SETTLED_JOB_TTL_MS) {
        this.jobs.delete(id);
        this.recorded?.delete(id);
      }
    }
    let settled = [...this.jobs.entries()]
      .filter(([, job]) => job.status !== 'running' && job.disposing !== true && job.endedAt)
      .sort((a, b) => Date.parse(a[1].endedAt) - Date.parse(b[1].endedAt));
    while (settled.length > MAX_SETTLED_JOBS) {
      const [id] = settled.shift();
      this.jobs.delete(id);
      this.recorded?.delete(id);
    }
  }

  async wait(id, timeoutMs) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== 'running') return job;
    let timer;
    let resolveWaiter;
    const waiter = new Promise((res) => { resolveWaiter = res; job.waiters.push(res); });
    try {
      await Promise.race([
        waiter,
        timeoutMs > 0
          ? new Promise((res) => { timer = setTimeout(res, timeoutMs); timer.unref?.(); })
          : Promise.resolve(),
      ]);
    } finally {
      // A long-poll that timed out must not leave its timer or its waiter
      // behind: one is an event-loop handle, the other grows the job's waiter
      // list for as long as the job runs (every poll added one before).
      if (timer) clearTimeout(timer);
      const at = job.waiters.indexOf(resolveWaiter);
      if (at !== -1) job.waiters.splice(at, 1);
    }
    return job;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.stopReason = 'cancelled';
      job.error = 'cancelled by request';
      job.endedAt = new Date().toISOString();
      job.disposing = true;
      this.publish();
      const hadHandle = job.handle !== null && job.handle !== undefined;
      try { await job.handle?.dispose(); } catch {}
      finally {
        // Before agents.create resolves there is no handle to dispose; run()
        // re-checks the status after create and clears this flag itself.
        if (hadHandle) job.disposing = false;
        this.publish();
        for (const w of job.waiters.splice(0)) w();
      }
    }
    return job;
  }

  async dispose() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
    for (const job of this.jobs.values()) {
      if (job.status === 'running') { try { await job.handle?.dispose(); } catch {} }
    }
  }
}

// ---------- loopback route helpers (pattern from dsh-noema) ----------

export function isIpv4Loopback(a) { return /^127(\.\d{1,3}){3}$/.test(a); }
export function isLoopbackAddress(address) {
  if (!address) return false;
  const n = address.toLowerCase().split('%', 1)[0];
  if (n === '::1' || isIpv4Loopback(n)) return true;
  if (!n.startsWith('::ffff:')) return false;
  return isIpv4Loopback(n.slice(7));
}
/**
 * Host header without its port. IPv6 literals keep their brackets: splitting
 * "[::1]:59306" on every colon yields "[" and would reject every request the
 * browser makes to an IPv6 loopback origin.
 */
export function hostHeaderName(value) {
  const host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}
export function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = hostHeaderName(req.headers?.host);
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || isIpv4Loopback(host);
}

// A browser request aimed at this loopback listener: it carries the DSH
// browser cookie, an Origin/Referer, or Fetch-Site metadata. `sec-fetch-mode`
// is deliberately not listed: Node's own fetch (the bundled MCP client) sends
// `sec-fetch-mode: cors`, while a browser also sends `sec-fetch-site`.
const BROWSER_MARKER_HEADERS = ['origin', 'referer', 'cookie', 'sec-fetch-site', 'sec-fetch-dest'];

function hasBrowserMarkers(req) {
  const headers = req?.headers ?? {};
  return BROWSER_MARKER_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * DSH's `connection` service is the authority on browser trust. Its
 * `requestRejection()` applies the Host/Origin fence (defeating DNS rebinding
 * and cross-site calls) and requires an authenticated live Peer. These routes
 * used to check only `isLoopbackRequest`, which accepts a request from any Web
 * page open in the user's browser — a page can reach 127.0.0.1 even though it
 * cannot read the response, and state-changing POSTs would still run.
 *
 * The bundled MCP server is a local non-browser client: it has no browser
 * cookie, so `requestRejection()` returns 401 for it. A 401 on a plain
 * loopback request with no browser markers is therefore allowed through; the
 * MCP process can already do anything the signed-in user can do locally.
 * Anything carrying browser markers, or coming from a non-loopback peer, is
 * subject to the rejection unchanged.
 *
 * @returns undefined when the request may proceed, otherwise 401 or 403.
 */
export function requestRejectionFor(ctx, req) {
  let connection;
  try {
    connection = ctx?.get?.('connection') ?? ctx?.connection;
  } catch {
    connection = undefined;
  }
  if (connection === undefined || typeof connection?.requestRejection !== 'function') {
    // Older DSH without the connection service: keep the previous loopback gate.
    return isLoopbackRequest(req) ? undefined : 403;
  }
  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch {
    rejection = 403;
  }
  if (rejection === undefined) return undefined;
  if (rejection === 401 && isLoopbackRequest(req) && !hasBrowserMarkers(req)) return undefined;
  return rejection;
}
function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}
/**
 * The panel is the authority on the active locale (DSH's setting may be unset,
 * leaving it to the browser), so it tags requests with ?lang= / body.lang and
 * the hub adopts it. Conversation-side paths with no request behind them —
 * pasted-image transcription — then follow the same language.
 */
function adoptLang(value) {
  if (value === 'zh' || value === 'en') setLang(value);
}

/**
 * `?wait` as a non-negative integer second count. Absent/empty means 0;
 * anything non-numeric, fractional or negative is null (HTTP 400) — a
 * garbage wait must be an error, never a silent no-wait (PATTERN-AUDIT D2:
 * `?wait=abc` used to return immediately with 200 OK because
 * Math.min(NaN, 600) is NaN and the wait promise resolved instantly).
 */
export function parseWaitSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > limit) {
      const error = new Error('payload too large');
      error.code = 'E_TOO_LARGE';
      throw error;
    }
    chunks.push(buf);
  }
  // Decode once: concatenating Buffer.toString() per chunk splits multi-byte
  // UTF-8 characters and silently replaces them with U+FFFD.
  const body = Buffer.concat(chunks).toString('utf8');
  return body.trim() === '' ? {} : JSON.parse(body);
}

// ---------- plugin entry ----------

export async function apply(ctx) {
  seedLangFromHost(ctx);
  // Sandboxed commands need a temp root this user can grant on; fix that
  // before any worker session exists (see sandbox-temp.mjs).
  const sandboxTemp = prepareSandboxTemp();
  ctx.logger?.info?.(`dsh-adapter: sandbox temp ${sandboxTemp.root}${sandboxTemp.switched ? ' (switched: ' + sandboxTemp.reason + ')' : ''}`);
  const hub = new WorkerRegistry(ctx);
  // Providers DSH already has configured are offered to the multimodal bridge
  // as ready-made entries, so a vision model needs no manual base URL or key.
  let autoProviders = [];
  const mergeAutoProviders = (cfg) => {
    const user = cfg.custom_providers ?? [];
    const extra = autoProviders.filter((a) => !user.some((u) => u.id === a.id));
    return extra.length === 0 ? cfg : { ...cfg, custom_providers: [...user, ...extra] };
  };
  const refreshAutoProviders = async () => {
    try {
      const cfg = readGlobalConfig();
      const list = [];
      for (const p of ctx.llm.listProviders()) {
        const endpoint = resolveProviderEndpoint(p.id, (cfg.upstream_caps ?? {})[p.id]);
        if (!endpoint?.baseUrl) continue;
        const models = [];
        try {
          for (const m of await ctx.llm.listModels(p.id)) {
            try {
              const info = await ctx.llm.resolveModelInfo(p.id, m.id);
              if ((info.inputModalities ?? []).includes('image')) models.push(m.id);
            } catch { /* model without metadata */ }
          }
        } catch { /* adapter without a catalog */ }
        if (models.length === 0) continue;
        list.push({
          id: 'dsh-' + p.id,
          name: (p.name ?? p.id) + ' (DSH)',
          type: 'api',
          base_url: endpoint.baseUrl,
          ...(endpoint.apiKeyEnv === undefined ? {} : { api_key_env: endpoint.apiKeyEnv }),
          models,
          auto: true,
        });
      }
      autoProviders = list;
    } catch { /* multimodal stays manual */ }
  };
  try {
    const { readGlobalConfig } = await import('../install/install.mjs');
    hub.getConfig = () => mergeAutoProviders(readGlobalConfig());
    try { backfillHistory(); } catch { /* best effort */ }
    hub.refreshAutoProviders = refreshAutoProviders;
    void refreshAutoProviders();
  } catch {}
  const disposers = [];

  // Multimodal bridge: register describe_image / generate_image for the DS
  // model. Config is read per call so settings-page edits apply live.
  try {
    const { createMultimodalTools } = await import('../multimodal.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    for (const tool of createMultimodalTools(() => hub.getConfig())) {
      disposers.push(ctx.effect(() => ctx.tools.register(tool), `dsh-adapter: ${tool.name} tool`));
    }
  } catch (err) {
    ctx.logger?.warn?.(`dsh-adapter: multimodal tools unavailable: ${err?.message ?? err}`);
  }

  // Vision route: image paste on the text-only DS models (admission adapter +
  // pre-step transcription).
  try {
    const { installVisionRoute } = await import('../vision-route.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    disposers.push(installVisionRoute(ctx, () => hub.getConfig()));
  } catch (err) {
    ctx.logger?.warn?.(`dsh-adapter: vision route unavailable: ${err?.message ?? err}`);
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const disposers = [];

    // The desktop host binds an OS-assigned port on every launch, so a fixed
    // hub_url goes stale after each restart and the host-side MCP shim falls
    // back to standalone mode. Publish this instance's origin into the shared
    // config instead; a hub_url that names another machine is left untouched.
    const originOf = () => {
      try {
        const value = webServer.getOrigin?.();
        if (typeof value === 'string' && value) return value;
      } catch { /* listener not bound yet */ }
      try {
        const port = webServer.port;
        if (Number.isInteger(port) && port > 0) return 'http://127.0.0.1:' + port;
      } catch { /* port accessor unavailable */ }
      return undefined;
    };
    const syncHubUrl = (attempt = 0) => {
      const origin = originOf();
      if (!origin) {
        // The listener can bind well after plugins apply; keep trying quietly.
        if (attempt < 15) { setTimeout(() => syncHubUrl(attempt + 1), 2000).unref?.(); return; }
        ctx.logger?.warn?.('dsh-adapter: hub_url sync gave up waiting for the listener');
        return;
      }
      try {
        const current = readGlobalConfig();
        const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(current.hub_url ?? '');
        if ((!current.hub_url || isLocal) && current.hub_url !== origin) {
          writeGlobalConfig({ hub_url: origin });
          ctx.logger?.info?.('dsh-adapter: hub_url synced to ' + origin);
        }
      } catch (err) {
        ctx.logger?.warn?.('dsh-adapter: hub_url sync skipped: ' + (err?.message ?? err));
      }
    };
    syncHubUrl();

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/worker-probe`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'application/json required' });
        try {
          const body = await readBody(req);
          if (typeof body.provider !== 'string' || body.provider.trim() === '' || typeof body.model !== 'string' || body.model.trim() === '') return sendJson(res, 400, { ok: false, error: 'provider and model required' });
          const result = await probeProvider(ctx.llm, { provider: body.provider.trim(), model: body.model.trim() });
          return sendJson(res, 200, { ok: true, result });
        } catch { return sendJson(res, 400, { ok: false, error: 'invalid probe request' }); }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/ping`,
      handler: (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        return sendJson(res, 200, { ok: true, service: 'dsh-adapter-hub' });
      },
    }));

    // WPC14: liveness probe for a ghost job's recorded pid. The panel probes
    // orphaned tombstones that carry a pid so it can offer the "process still
    // alive" badge and a kill button; same process.kill(pid, 0) probe the
    // status shard uses for writer liveness (status-shard.mjs writerProcessAlive).
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-alive`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const pid = parsePid(url.searchParams.get('pid'));
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          return sendJson(res, 200, { ok: true, alive: procAlive(pid) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // WPC14: verified kill of a ghost job's recorded pid. The pid may have
    // been recycled since the job died, so the command line is read (ps) and
    // must match a process shape this plugin spawns (DSH runtime / agy /
    // grok) before anything is signalled; then SIGTERM (whole group when a
    // pgid is given) and SIGKILL after a ~3s grace. Refusals are readable,
    // in the origin-guard style.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-kill`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const body = await readBody(req);
          adoptLang(body?.lang);
          const pid = parsePid(body?.pid);
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          let pgid = null;
          if (body.pgid !== undefined && body.pgid !== null) {
            pgid = parsePid(body.pgid);
            if (pgid === null) return sendJson(res, 400, { ok: false, error: 'pgid must be a positive integer' });
          }
          const result = await killWorkerProcess({ pid, pgid });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          if (err instanceof ProcKillRefused) {
            return sendJson(res, 403, { ok: false, error: err.message, code: err.code, pid: err.pid ?? null, command: err.command ?? null });
          }
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'prefix', path: `${ROUTE_BASE}/jobs`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const suffix = url.pathname.slice(`${ROUTE_BASE}/jobs`.length);
          // The slots API matches this route by prefix; without a boundary,
          // /jobsAnything would be treated as job id "Anything".
          if (suffix !== '' && !suffix.startsWith('/')) return sendJson(res, 404, { ok: false, error: 'not found' });
          const parts = suffix.split('/').filter(Boolean);
          if (req.method === 'GET' && parts.length === 0) {
            // Machine-wide view: this hub's live jobs plus fresh shards from
            // other writers (standalone MCP sessions, other hub instances).
            const own = [...hub.jobs.values()].map((j) => ({ ...hub.view(j), origin: hub.shard.writer }));
            const foreign = readMergedStatus({ excludeWriter: hub.shard.writer });
            return sendJson(res, 200, { ok: true, jobs: [...own, ...foreign] });
          }
          if (req.method === 'GET' && parts.length === 1) {
            const wait = parseWaitSeconds(url.searchParams.get('wait'));
            if (wait === null) return sendJson(res, 400, { ok: false, error: 'wait must be a non-negative integer number of seconds' });
            const job = await hub.wait(parts[0], Math.min(wait, 600) * 1000);
            if (!job) {
              // A job listed from another writer's shard has no local handle
              // to wait on, but its current snapshot is still readable.
              const foreign = readMergedStatus({ excludeWriter: hub.shard.writer }).find((j) => j.id === parts[0]);
              if (foreign) return sendJson(res, 200, { ok: true, job: foreign, foreign: true });
              return sendJson(res, 404, { ok: false, error: 'no such job' });
            }
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          if (req.method === 'POST' && parts.length === 0) {
            const payload = await readBody(req);
            const job = await hub.spawn(payload);
            return sendJson(res, 200, { ok: true, job: hub.view(job) });
          }
          if (req.method === 'GET' && parts.length === 2 && parts[1] === 'events') {
            const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
            const wait = parseWaitSeconds(url.searchParams.get('wait'));
            // A garbage `wait` must be an error, never a silent no-wait: the
            // sibling /jobs/:id route already rejects it, and `?? 0` here made
            // `?wait=abc` look like a successful immediate poll.
            if (wait === null) return sendJson(res, 400, { ok: false, error: 'wait must be a non-negative integer number of seconds' });
            const deadline = Date.now() + Math.min(wait, 300) * 1000;
            for (;;) {
              const live = hub.jobs.get(parts[0]);
              if (!live) {
                const foreign = readMergedStatus({ excludeWriter: hub.shard.writer }).some((j) => j.id === parts[0]);
                return sendJson(res, foreign ? 409 : 404, {
                  ok: false,
                  error: foreign ? 'this job belongs to another writer; live events are only available from its writer' : 'no such job',
                  ...(foreign ? { foreign: true } : {}),
                });
              }
              const events = (live.events ?? []).filter((e) => e.seq > after);
              if (events.length > 0 || live.status !== 'running' || Date.now() >= deadline) {
                return sendJson(res, 200, {
                  ok: true,
                  status: live.status,
                  events,
                  cursor: live.eventSeq ?? after,
                  staleSeconds: quietSeconds(live),
                  currentTool: live.currentTool ?? null,
                });
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') {
            const job = await hub.cancel(parts[0]);
            if (!job) {
              const foreign = readMergedStatus({ excludeWriter: hub.shard.writer }).some((j) => j.id === parts[0]);
              if (foreign) return sendJson(res, 409, { ok: false, error: 'this job belongs to another writer; cancel it from that writer', foreign: true });
              return sendJson(res, 404, { ok: false, error: 'no such job' });
            }
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown jobs endpoint' });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/config`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const { readGlobalConfig, writeGlobalConfig } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (req.method === 'GET') {
            adoptLang(new URL(req.url, 'http://localhost').searchParams.get('lang'));
            await hub.refreshAutoProviders?.();
            return sendJson(res, 200, { ok: true, config: hub.getConfig() });
          }
          if (req.method === 'POST') {
            writeGlobalConfig(await readBody(req));
            return sendJson(res, 200, { ok: true, config: hub.getConfig() });
          }
          return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/presets`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const presets = ctx.get('agentPresets');
          if (presets === undefined) return sendJson(res, 200, { ok: true, presets: [] });
          const list = await presets.list();
          return sendJson(res, 200, {
            ok: true,
            defaultId: presets.defaultId,
            presets: list.map((p) => ({ id: p.id, name: p.name ?? p.id, trust: p.trust })),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // The MCP server runs as its own process and cannot reach ctx.llm, so the
    // routes the HOST has configured are published here. This is the whole
    // point of issue #10: a local model is configured once in DSH, and the
    // worker config names it instead of redefining it.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/providers`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const { readGlobalConfig } = await import('../install/install.mjs');
          await hub.refreshAutoProviders?.();
          const providers = [];
          for (const p of ctx.llm.listProviders()) {
            let models = [];
            const modelInfo = {};
            try { models = (await ctx.llm.listModels(p.id)).map((m) => m.id); } catch { /* adapter without a catalog */ }
            for (const id of models) {
              try {
                const info = await ctx.llm.resolveModelInfo(p.id, id);
                modelInfo[id] = {
                  efforts: (info?.reasoning?.efforts ?? []).map((e) => e.id),
                  ...(info?.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
                };
              } catch { /* metadata optional */ }
            }
            providers.push({ id: p.id, name: p.name ?? p.id, models, model_info: modelInfo });
          }
          return sendJson(res, 200, {
            ok: true,
            providers,
            bindings: describeBindings(readGlobalConfig()),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/model-caps`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const cfg = readGlobalConfig();
          if (req.method === 'POST') {
            const body = await readBody(req);
            const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
            if (!provider) return sendJson(res, 400, { ok: false, error: 'provider required' });
            const endpoint = resolveProviderEndpoint(provider, (cfg.upstream_caps ?? {})[provider]);
            const entry = await fetchUpstreamCaps(provider, endpoint, { ttlSeconds: cfg.caps_ttl_seconds });
            const cache = writeCapsCache(provider, entry);
            return sendJson(res, 200, { ok: true, entry, cached: cache.providers[provider] });
          }
          const endpoints = {};
          for (const p of ctx.llm.listProviders()) {
            const endpoint = resolveProviderEndpoint(p.id, (cfg.upstream_caps ?? {})[p.id]);
            endpoints[p.id] = endpoint ? { baseUrl: endpoint.baseUrl, apiKeyEnv: endpoint.apiKeyEnv, source: endpoint.source } : null;
          }
          return sendJson(res, 200, { ok: true, cache: readCapsCache(), endpoints });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/vision-models`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const provider = url.searchParams.get('provider');
          const force = url.searchParams.get('refresh') === '1';
          const lang = url.searchParams.get('lang');
          adoptLang(lang);
          const { listVisionModels } = await import('../multimodal.mjs');
          const { readGlobalConfig } = await import('../install/install.mjs');
          return sendJson(res, 200, { ok: true, models: await listVisionModels(provider, force, () => readGlobalConfig(), lang) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/provider-test`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        try {
          // The entry comes from the panel form so unsaved edits can be probed.
          const entry = await readBody(req);
          adoptLang(entry?.lang);
          const { testProvider } = await import('../multimodal.mjs');
          const result = await testProvider(entry, entry?.lang);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install/status`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const { installStatus } = await import(`../install/install.mjs?t=${Date.now()}`);
          return sendJson(res, 200, { ok: true, status: installStatus() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const { target, statusline } = await readBody(req);
          // Cache-busted import: the installer must always run the code
          // currently on disk, not whatever this process first loaded —
          // a stale cached copy once re-broke user settings after a fix.
          const {
            installClaudeCode, installCodex, installHudSegment, uninstallClaudeCode, uninstallCodex,
            installAgy, installGrok, uninstallAgy, uninstallGrok,
          } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (target === 'claude') {
            const base = await installClaudeCode({ statusline: !!statusline });
            const hud = installHudSegment({});
            return sendJson(res, 200, {
              ok: base.ok,
              actions: [...base.actions, ...hud.actions.map((a) => `hud: ${a}`)],
            });
          }
          if (target === 'codex') return sendJson(res, 200, installCodex({ globalMcp: hub.getConfig().codex_global_mcp !== false }));
          if (target === 'agy') return sendJson(res, 200, installAgy({}));
          if (target === 'grok') return sendJson(res, 200, installGrok({}));
          if (target === 'claude-uninstall') return sendJson(res, 200, await uninstallClaudeCode({}));
          if (target === 'codex-uninstall') return sendJson(res, 200, uninstallCodex({}));
          if (target === 'agy-uninstall') return sendJson(res, 200, uninstallAgy({}));
          if (target === 'grok-uninstall') return sendJson(res, 200, uninstallGrok({}));
          return sendJson(res, 400, { ok: false, error: 'target must be claude | codex | agy | grok | claude-uninstall | codex-uninstall | agy-uninstall | grok-uninstall' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));


    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/history`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const filter = {
            tier: url.searchParams.get('tier') || undefined,
            status: url.searchParams.get('status') || undefined,
            source: url.searchParams.get('source') || undefined,
          };
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          const { records, total } = readHistory({ ...filter, limit, offset });
          return sendJson(res, 200, { ok: true, records, total, stats: historyStats(filter) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));


    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/doctor`,
      handler: async (req, res) => {
        const rejection = requestRejectionFor(ctx, req);
        if (rejection !== undefined) return sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' });
        try {
          const cfg = hub.getConfig();
          return sendJson(res, 200, {
            ok: true,
            hub_url: cfg.hub_url,
            mode: cfg.mode,
            temp: prepareSandboxTemp(),
            hub_reachable: true,
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    return () => { for (const d of disposers.reverse()) d(); };
  });

  ctx.logger?.info?.('dsh-adapter hub mounted (jobs API + installer endpoints + multimodal tools)');
  return async () => {
    for (const d of disposers.reverse()) { try { d(); } catch {} }
    await hub.dispose();
  };
}
