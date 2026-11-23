// Browser half of dsh-adapter: integrations (install/update/restore),
// global worker configuration, and the live jobs table.
// Talks only to the plugin's own loopback routes.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { persistConfigPatch } from './config-save.mjs';
import { historyStatItems } from './history-view.mjs';

import { reconcileGhosts, displayJobs, groupJobs, workspaceKey, basenameOf, abbrevPath, workspaceLocks, lockBadgeOf, statusInfoOf, ghostPidOf, procBadgeOf, dueProcProbes } from './jobs-view';

// Build-time snapshot of the worker-profile registry — the same descriptors
// dsh_worker_config returns as worker_profiles (name / backend / label /
// model / effort / permission). The panel cannot call server tools and no
// loopback route exposes the registry yet, so the list is bundled into the
// client build; the source of truth stays src/worker-profiles.mjs.

export const inject = ['slots', 'locale'];

const API = '/_dsh/dsh-adapter';

// ---------------------------------------------------------------------------
// Collapsible-state helpers. Integrations / global config are one-time setup
// (dsh-adapter.settings.collapse.<section>); per-workspace job groups and their
// finished-job folds use dsh-adapter.jobs.collapse.<workspace-hash> and
// dsh-adapter.settings.collapse.finished-jobs.<workspace-hash> (WPC13). When
// localStorage is unavailable (privacy mode, sandboxed iframe, …) we degrade
// to session-only memory. First visit defaults to expanded.
const COLLAPSE_PREFIX = 'dsh-adapter.settings.collapse.';
const WS_COLLAPSE_PREFIX = 'dsh-adapter.jobs.collapse.';
const collapseSessionMemory: Record<string, boolean> = {};

function readCollapsed(key: string, defaultCollapsed = false): boolean {
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (stored === '1') return true;
  if (stored === '0') return false;
  return collapseSessionMemory[key] ?? defaultCollapsed;
}
function persistCollapsed(key: string, collapsed: boolean): void {
  try { window.localStorage.setItem(key, collapsed ? '1' : '0'); }
  catch { collapseSessionMemory[key] = collapsed; }
}

// Orphan ghosts (WPC10): running jobs the panel saw that later vanished from
// an OK /jobs response without reaching a terminal state. Persisted under
// dsh-adapter.jobs.ghosts so a page reload does not erase the trace of a job
// that died while nobody was looking (the WPC10 incident). Same try/catch
// degradation as the collapse keys.
const GHOST_STORE_KEY = 'dsh-adapter.jobs.ghosts';
const ghostSessionMemory: Record<string, any> = {};
function readGhosts(): Record<string, any> {
  try {
    const raw = window.localStorage.getItem(GHOST_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return ghostSessionMemory; }
}
function writeGhosts(ghosts: Record<string, any>): void {
  try { window.localStorage.setItem(GHOST_STORE_KEY, JSON.stringify(ghosts)); }
  catch { Object.assign(ghostSessionMemory, ghosts); }
}

/** Section open state + toggle, persisted under dsh-adapter.settings.collapse.<section>. */
function useCollapseSection(section: string, defaultCollapsed = false): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(COLLAPSE_PREFIX + section, defaultCollapsed));
  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    persistCollapsed(COLLAPSE_PREFIX + section, next);
  }, [section, collapsed]);
  return [collapsed, toggle];
}

/** Per-workspace job-group collapse, persisted under dsh-adapter.jobs.collapse.<workspaceKey> (WPC13). */
function useWorkspaceCollapse(wsKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(WS_COLLAPSE_PREFIX + wsKey));
  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    persistCollapsed(WS_COLLAPSE_PREFIX + wsKey, next);
  }, [wsKey, collapsed]);
  return [collapsed, toggle];
}

const COPY = {
  zh: {
    label: 'DSH Adapter',
    title: 'DSH Adapter',
    intro: 'Claude Code / Codex 可以给 DSH agent 分派任务，在宿主里显示为原生子代理、进度可见。配置派发默认值、执行方式，以及接入视觉与生图能力，一键装进宿主。',
    integrations: '集成',
    globalMcp: 'Codex 全局 MCP（CLI 与桌面端都可直接调用）',
    globalMcpHint: '关闭后只安装 ds-flash / ds-pro 子代理角色，不注册全局 MCP；桌面端将无法直接调用。',
    collapse: '折叠', expand: '展开',
    doneAt: (t: string) => `已更新 · ${t}`,
    installed: '已安装', notInstalled: '未安装', hud: 'HUD 段',
    hostDetected: '已检测到', hostMissing: '未检测到', notIntegrated: '未接入',
    install: '安装', update: '更新', restore: '还原',
    confirmRestore: (name: string) => `确定从 ${name} 移除 dsh-adapter 集成？（settings 会先备份）`,
    globalConfig: '全局配置',
    globalHint: '修改即时保存到 ~/.config/dsh-adapter/config.json；CC / Codex 的新会话自动读取为默认值（会话内可用 /dsh-adapter:config 临时覆盖）。',
    tier: '默认档位', effort: '默认推理', mode: '执行模式', timeout: '默认超时(秒)', hubUrl: 'Hub 地址',
    tierFlash: 'flash · 默认', tierPro: 'pro · 备选',
    tierPolicy: '档位策略', escalate: '失败升档',
    tierPolicyDesc: { auto: 'auto · orchestrator 自选', 'flash-only': '只用 flash', 'pro-only': '只用 pro' },
    escalateHint: 'flash 失败自动用 pro 重试一次',
    presetFlash: 'flash 模式', presetPro: 'pro 模式',
    builtInPresetNames: { standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' } as Record<string, string>,
    multimodal: '多模态',
    visionProvider: '视觉 provider', visionModel: '视觉模型', imagegenProvider: '生图 provider',
    customProviders: '自定义 Provider', addProvider: '＋ 添加 Provider',
    noCustomProviders: '暂无。添加后会出现在上方的视觉 / 生图 provider 选择里。',
    providerName: '名称', modelsField: '模型列表（逗号分隔）',
    providerType: '接入方式', typeApi: 'API · 兼容 OpenAI 接口', typeCli: 'CLI · 本地命令',
    baseUrl: 'Base URL', apiKey: 'API Key', imagegenModel: '生图模型（留空=不提供生图）',
    visionCmd: '视觉命令（可选）', imagegenCmd: '生图命令（可选）',
    apiFormHint: '走 OpenAI 兼容接口：视觉调 {base}/chat/completions（图片以 base64 内联），生图调 {base}/images/generations。Key 保存在本机 ~/.config/dsh-adapter/config.json，不会外发到第三方。',
    cliFormHint: '命令经 bash 执行，占位符会被安全引用后代入。视觉: {image} {question} {model}，stdout 即答案；生图: {prompt} {output} {size}，命令须把图片写到 {output}。两条命令至少填一条。',
    saveProvider: '保存', cancel: '取消', edit: '编辑', del: '删除',
    testProvider: '连通测试', testing: '测试中…',
    testTip: '按当前填写的内容实测：API 会检查可达性与鉴权并真发一次视觉请求；CLI 会检查可执行文件并真跑一次视觉命令。生图只校验配置，不实际出图。',
    testPass: '连通正常', testFail: '连通失败',
    staleHub: '本 DSH 实例还在跑旧版插件，缺少该接口 —— 重启 DSH 后再试',
    emptyResponse: (path: string, status: number) => `${path} → HTTP ${status}，响应为空`,
    badJson: (path: string, body: string) => `${path} → 非 JSON 响应: ${body}`,
    refreshModels: '重新从 CLI 获取模型列表',
    presetDefault: (id?: string) => `default · 跟随 DSH${id ? ` (${id})` : ''}`,
    progressTip: (t: string, turn: number, step: number, calls: number | string) => `耗时 ${t} · 第${turn}轮第${step}步 · ${calls} 次工具调用`,
    confirmDeleteProvider: (n: string) => `删除自定义 provider「${n}」？`,
    needName: '⚠ 名称必填', needCmd: '⚠ 视觉/生图命令至少填一条',
    needBaseUrl: '⚠ Base URL 必填', needModels: '⚠ 模型列表至少填一个',
    keySet: '已配置', keyPlaceholder: 'sk-…（留空则不发送 Authorization）',
    addModelTip: '添加模型到列表', removeModelTip: '从列表移除当前模型', modelPlaceholder: '模型 id，回车确认',
    capVision: '视觉', capImagegen: '生图',
    groupDispatch: '派发', groupRuntime: '运行', groupMultimodal: '多模态',
    cardDispatch: { t: '派发策略', d: 'orchestrator 未指定时的档位与推理强度，以及档位约束、失败升档与两档各自挂载的 Agent 预设。' },
    cardRuntime: { t: '执行与连接', d: 'worker 会话跑在本实例内还是独立进程，单个任务的超时上限，以及 CC / Codex 探测本实例的地址。' },
    cardMM: { t: '视觉与生图', d: '给纯文本的 DSH 模型借来眼睛和画笔：describe_image、会话贴图转写与 generate_image 都用这里的设置。' },
    cardCustomProv: { t: '自定义 Provider', d: '接入自己的 API 或本地命令；保存后会出现在上面的视觉 / 生图 provider 选择里。' },
    modeDesc: { hub: 'hub · 默认（在 DSH 内运行）', auto: 'auto · 回退独立进程（需源码依赖）', standalone: 'standalone · 独立进程（需源码依赖）' },
    save: '保存', saved: '已保存', saveFailed: '保存失败，已恢复服务器中的配置：', jobs: '实时 Worker 任务', empty: '当前没有 worker 任务。', emptyHint: '派发任务后，这里会实时显示进度。', loading: '加载中…',
    workerStatus: 'Worker 状态', liveHint: '每 3 秒自动刷新', runningCount: (n: number) => `${n} 个运行中`,
    history: '历史看板', historyEmpty: '还没有历史记录', historyEmptyHint: '完成的 Worker 任务会显示在这里。', historyTotal: '总数', historyDone: '成功', historyFailed: '失败',
    historyAvg: '平均耗时', historyRefresh: '刷新', historyTime: '时间', historyTier: '档位', historyModel: '模型',
    historyStatus: '状态', historyCost: '耗时', historyTask: '任务',
    eventsTitle: '事件流', eventsEmpty: '还没有事件。', eventsOnlyHub: '只有 hub 任务有事件流。', eventsHint: '点击行展开事件流',
    eventsMeta: (j: any) => `${j.provider ?? '?'}/${j.model ?? '?'}${j.effort ? ' @' + j.effort : ''} · ${j.timeoutSeconds ? j.timeoutSeconds + 's 上限' : '无上限'}${j.staleSeconds != null ? ' · 静默 ' + j.staleSeconds + 's' : ''}`,
    eventText: '输出', eventTool: '工具', eventResult: '结果', eventStep: '步骤', eventEnd: '结束', eventApproval: '审批',
    statusRunning: '运行中', statusStalled: '疑似卡住', statusNeedsInput: '需输入', statusDone: '完成', statusFailed: '失败', statusCancelled: '已取消', statusOrphaned: '失联',
    statusTitle: (s: string) => `状态：${s}`,
    orphanWriterGone: (origin: string) => `所属实例已消失：写入该状态的进程（${origin}）已不存在，任务随它一起终止（最后状态 running）`,
    orphanVanished: (ago: string) => `任务从状态源消失（最后状态 running，${ago} 前最后一次见到）。很可能随所属实例退出而死亡；如果它其实在两次刷新间正常结束了，可点 × 清除`,
    orphanDismiss: '清除这条失联记录',
    procAliveBadge: '进程仍在',
    procKill: '杀死',
    procKilling: '终止中…',
    procKillDone: '已向失联进程发送终止信号',
    procKillAlreadyGone: '进程已不存在（可能已自行退出）',
    procAliveBadgeTip: (pid: number) => `任务已失联，但其工作进程仍在运行（pid ${pid}）：很可能是派活宿主崩溃后留下的孤儿进程`,
    procKillTip: (pid: number) => `杀死 pid ${pid}：先读取命令行校验确为 dsh-adapter 工作进程（DSH 运行时 / agy / grok），再 SIGTERM，约 3 秒后仍存活则 SIGKILL`,
    finishedJobs: '已结束',
    noCwdGroup: '（未指定工作区）',
    lockBadgeTip: (h: any) => `「${h?.cwd ?? '此工作区'}」正被运行中任务持锁（job ${h?.jobId} · backend ${h?.backend} · 开始于 ${h?.startedAt}）：对该 cwd 的再次派发会被拒绝，除非传 allow_concurrent_cwd: true。`,
    shardStale: (min: number) => `状态源已 ${min} 分钟没有写入（任务可能已无输出地卡住，或所属进程已死但状态源尚未清理）`,
    stalledTip: (last: string) => last ? `超过 120 秒无输出（上次输出 ${last} 前），进程仍存活；长时间工具调用可能误报` : '超过 120 秒无输出，进程仍存活；长时间工具调用可能误报',
    quiet: (d: string) => `静默 ${d}`,
    quietTip: (tool: string) => `超过 120 秒没有新事件${tool ? `（最后工具：${tool}）` : ''}；无进度超过 stall_timeout_seconds 后会被自动判为失败`,
    col: { id: '任务', source: '来源', tier: '档位', status: '状态', progress: '进度', tokens: 'tokens ⇅', task: '内容' },
    working: '处理中…',
    tips: {
      claude: {
        install: '一键装进 Claude Code：注册本地 marketplace、claude plugin install、写入工具权限白名单、接线 claude-hud worker 段；修改 settings.json 前自动备份',
        update: '重跑安装流程：刷新注册与权限、迁移旧格式配置、更新 HUD 接线；幂等，可放心点',
        restore: '从 Claude Code 移除集成：清除 marketplace 注册、插件启用项与权限规则（settings 先备份）；不删除插件源码与已跑任务',
      },
      codex: {
        install: '把 ds-flash / ds-pro 角色和 /dsh-config、/dsh-status 命令复制到 ~/.codex/（MCP 路径按本机自动渲染，含 approve 审批与超时配置）',
        update: '重新渲染并覆盖角色文件与命令（插件路径或配置变更后用）；原文件先备份',
        restore: '删除 ~/.codex/ 下的 ds-flash / ds-pro 角色与 dsh 命令文件（角色文件先备份）',
      },
      agy: {
        install: '把 dsh-adapter MCP server 注册进 ~/.gemini/config/mcp_config.json，并将 ds-flash / ds-pro 代理与 dsh-config / dsh-status skills 复制到 ~/.gemini/config/agents 与 skills（修改前自动备份）',
        update: '重新覆盖 MCP 配置、代理与 skills（插件路径或配置变更后用）；原文件先备份',
        restore: '从 ~/.gemini/config 移除 dsh-adapter 的 mcp_config.json 条目、ds-flash / ds-pro 代理与 dsh-config / dsh-status skills（修改前备份）',
      },
      grok: {
        install: '把 dsh-adapter MCP server 段写入 ~/.grok/config.toml，并将 ds-flash / ds-pro 代理与 dsh-config / dsh-status 命令复制到 ~/.grok/agents 与 commands（修改前自动备份）。提示：grok 出于安全设计，在未信任的项目目录里不会启动仓库级 MCP server —— 全局安装不受影响，但在未信任目录里用 grok mcp doctor 检查时会看到 "folder untrusted"，换个目录或加 --trust 即可。',
        update: '重新覆盖 config.toml 的 MCP 段、代理与命令（插件路径或配置变更后用）；原文件先备份',
        restore: '从 ~/.grok 移除 dsh-adapter 的 config.toml 段、ds-flash / ds-pro 代理与 dsh-config / dsh-status 命令（修改前备份）',
      },
    },
  },
  en: {
    label: 'DSH Adapter',
    title: 'DSH Adapter',
    intro: 'Claude Code / Codex can dispatch tasks to DSH agents and see them as native subagents in the host with live progress. Configure dispatch defaults, execution mode, and vision / image-generation access, then install into the host in one click.',
    integrations: 'Integrations',
    globalMcp: 'Codex global MCP (callable from both CLI and the desktop client)',
    globalMcpHint: 'When off, only the ds-flash / ds-pro agent roles are installed; the desktop client cannot call the worker tools directly.',
    collapse: 'Collapse', expand: 'Expand',
    doneAt: (t: string) => `Updated · ${t}`,
    installed: 'installed', notInstalled: 'not installed', hud: 'HUD segment',
    hostDetected: 'detected', hostMissing: 'not detected', notIntegrated: 'not integrated',
    install: 'Install', update: 'Update', restore: 'Restore',
    confirmRestore: (name: string) => `Remove the dsh-adapter integration from ${name}? (settings are backed up first)`,
    globalConfig: 'Global configuration',
    globalHint: 'Changes save instantly to ~/.config/dsh-adapter/config.json; new CC / Codex sessions pick them up as defaults (override per session with /dsh-adapter:config).',
    tier: 'Default tier', effort: 'Default effort', mode: 'Mode', timeout: 'Timeout (s)', hubUrl: 'Hub URL',
    tierFlash: 'flash · default', tierPro: 'pro · alternate',
    tierPolicy: 'Tier policy', escalate: 'Escalate on failure',
    tierPolicyDesc: { auto: 'auto · orchestrator picks', 'flash-only': 'flash only', 'pro-only': 'pro only' },
    escalateHint: 'retry a failed flash run once on pro',
    presetFlash: 'flash preset', presetPro: 'pro preset',
    builtInPresetNames: { standard: 'Standard mode', ptc: 'PTC mode', minimal: 'Minimal mode', cordis: 'Creator mode' } as Record<string, string>,
    multimodal: 'Multimodal',
    visionProvider: 'Vision provider', visionModel: 'Vision model', imagegenProvider: 'Image-gen provider',
    customProviders: 'Custom providers', addProvider: '＋ Add provider',
    noCustomProviders: 'None yet. Added providers appear in the vision / image-gen selects above.',
    providerName: 'Name', modelsField: 'Models (comma-separated)',
    providerType: 'Connection', typeApi: 'API · OpenAI-compatible', typeCli: 'CLI · local command',
    baseUrl: 'Base URL', apiKey: 'API key', imagegenModel: 'Image-gen model (empty = no image generation)',
    visionCmd: 'Vision command (optional)', imagegenCmd: 'Image-gen command (optional)',
    apiFormHint: 'OpenAI-compatible: vision calls {base}/chat/completions (image inlined as base64), image-gen calls {base}/images/generations. The key is stored locally in ~/.config/dsh-adapter/config.json and never sent to third parties.',
    cliFormHint: 'Commands run via bash with shell-quoted placeholders. Vision: {image} {question} {model}, stdout is the answer; image-gen: {prompt} {output} {size}, the command must write the image to {output}. Fill in at least one command.',
    saveProvider: 'Save', cancel: 'Cancel', edit: 'Edit', del: 'Delete',
    testProvider: 'Test', testing: 'Testing…',
    testTip: 'Probes what is currently filled in: API checks reachability and auth then makes one real vision call; CLI checks the executable then runs the vision command once. Image generation is only validated, never actually run.',
    testPass: 'Connection OK', testFail: 'Connection failed',
    staleHub: 'This DSH instance is still running an older build of the plugin and lacks this route — restart DSH and retry',
    emptyResponse: (path: string, status: number) => `${path} → HTTP ${status}, empty response`,
    badJson: (path: string, body: string) => `${path} → non-JSON response: ${body}`,
    refreshModels: 'Re-fetch the model list from the CLI',
    presetDefault: (id?: string) => `default · follow DSH${id ? ` (${id})` : ''}`,
    progressTip: (t: string, turn: number, step: number, calls: number | string) => `${t} elapsed · turn ${turn}, step ${step} · ${calls} tool calls`,
    confirmDeleteProvider: (n: string) => `Delete custom provider "${n}"?`,
    needName: '⚠ Name is required', needCmd: '⚠ Fill in at least one command',
    needBaseUrl: '⚠ Base URL is required', needModels: '⚠ Add at least one model',
    keySet: 'set', keyPlaceholder: 'sk-… (leave empty to send no Authorization header)',
    addModelTip: 'Add a model to the list', removeModelTip: 'Remove the current model from the list', modelPlaceholder: 'model id, Enter to confirm',
    capVision: 'vision', capImagegen: 'image-gen',
    groupDispatch: 'Dispatch', groupRuntime: 'Runtime', groupMultimodal: 'Multimodal',
    cardDispatch: { t: 'Dispatch policy', d: 'Tier and effort used when the orchestrator names none, plus tier clamping, failure escalation and the Agent preset mounted per tier.' },
    cardRuntime: { t: 'Execution & connection', d: 'Whether worker sessions run inside this instance or a separate process, the per-job timeout, and the address CC / Codex probes.' },
    cardMM: { t: 'Vision & image generation', d: "Lends the harness's text-only models eyes and a brush: describe_image, pasted-image transcription and generate_image all use these settings." },
    cardCustomProv: { t: 'Custom providers', d: 'Bring your own API or local command; saved providers appear in the vision / image-gen selects above.' },
    modeDesc: { hub: 'hub · default (runs inside DSH)', auto: 'auto · fall back to standalone (source checkout)', standalone: 'standalone (source checkout)' },
    save: 'Save', saved: 'Saved', saveFailed: 'Save failed; restored the server configuration:', jobs: 'Live worker jobs', empty: 'No worker jobs yet.', emptyHint: 'Dispatched jobs appear here with live progress.', loading: 'Loading…',
    workerStatus: 'Workers', liveHint: 'Refreshes every 3s', runningCount: (n: number) => `${n} running`,
    history: 'History', historyEmpty: 'No history yet', historyEmptyHint: 'Finished worker jobs will appear here.', historyTotal: 'Total', historyDone: 'Done', historyFailed: 'Failed',
    historyAvg: 'Avg duration', historyRefresh: 'Refresh', historyTime: 'Time', historyTier: 'Tier', historyModel: 'Model',
    historyStatus: 'Status', historyCost: 'Duration', historyTask: 'Task',
    eventsTitle: 'Events', eventsEmpty: 'No events yet.', eventsOnlyHub: 'Only hub jobs expose an event stream.', eventsHint: 'Click a row to expand its event stream',
    eventsMeta: (j: any) => `${j.provider ?? '?'}/${j.model ?? '?'}${j.effort ? ' @' + j.effort : ''} · ${j.timeoutSeconds ? j.timeoutSeconds + 's cap' : 'no cap'}${j.staleSeconds != null ? ' · quiet ' + j.staleSeconds + 's' : ''}`,
    eventText: 'text', eventTool: 'tool', eventResult: 'result', eventStep: 'step', eventEnd: 'end', eventApproval: 'approval',
    statusRunning: 'running', statusStalled: 'stalled', statusNeedsInput: 'needs input', statusDone: 'done', statusFailed: 'failed', statusCancelled: 'cancelled', statusOrphaned: 'orphaned',
    statusTitle: (s: string) => `status: ${s}`,
    orphanWriterGone: (origin: string) => `Owning instance gone: the process that wrote this status (${origin}) no longer exists — the job died with it (last status: running)`,
    orphanVanished: (ago: string) => `Vanished from the status feed while running (last seen ${ago} ago). Likely died with its owning instance; if it actually finished between refreshes, dismiss it with ×`,
    orphanDismiss: 'Dismiss this orphaned record',
    procAliveBadge: 'process still alive',
    procKill: 'Kill',
    procKilling: 'killing…',
    procKillDone: 'Termination signal sent to the orphaned process',
    procKillAlreadyGone: 'The process is already gone (it may have exited on its own)',
    procAliveBadgeTip: (pid: number) => `The job lost contact with the board, but its worker process is still running (pid ${pid}) - most likely an orphan left behind after its dispatching host died`,
    procKillTip: (pid: number) => `Kill pid ${pid}: the command line is read and verified first (DSH runtime / agy / grok), then SIGTERM, and SIGKILL if it survives ~3s`,
    finishedJobs: 'Finished',
    noCwdGroup: '(no workspace)',
    lockBadgeTip: (h: any) => `"${h?.cwd ?? 'this workspace'}" is held by a running job (job ${h?.jobId} · backend ${h?.backend} · started ${h?.startedAt}): a second dispatch to this cwd is refused unless allow_concurrent_cwd: true is passed.`,
    shardStale: (min: number) => `status feed has not been written for ${min} min (job may be stuck with no output, or its process died but the feed was not cleaned up yet)`,
    stalledTip: (last: string) => last ? `No output for 120s (last output ${last} ago); the process is still alive — long tool runs can false-positive` : 'No output for 120s; the process is still alive — long tool runs can false-positive',
    quiet: (d: string) => `quiet ${d}`,
    quietTip: (tool: string) => `No new session event for 120s${tool ? ` (last tool: ${tool})` : ''}; jobs with no progress beyond stall_timeout_seconds are failed automatically`,
    col: { id: 'job', source: 'source', tier: 'tier', status: 'status', progress: 'progress', tokens: 'tokens ⇅', task: 'task' },
    working: 'Working…',
    tips: {
      claude: {
        install: 'One-click install into Claude Code: register local marketplace, claude plugin install, permission allowlist, claude-hud segment wiring; settings.json backed up first',
        update: 'Re-run the installer: refresh registration & permissions, migrate legacy config, update HUD wiring; idempotent',
        restore: 'Remove the integration from Claude Code: marketplace registration, plugin enablement and permission rules (settings backed up); plugin source and past jobs untouched',
      },
      codex: {
        install: 'Copy ds-flash / ds-pro roles and /dsh-config, /dsh-status prompts into ~/.codex/ (MCP paths rendered for this machine, approve mode + timeout included)',
        update: 'Re-render and overwrite role files and prompts (after path/config changes); originals backed up',
        restore: 'Delete ds-flash / ds-pro roles and dsh prompts from ~/.codex/ (roles backed up first)',
      },
      agy: {
        install: 'Register the dsh-adapter MCP server in ~/.gemini/config/mcp_config.json and copy ds-flash / ds-pro agents plus dsh-config / dsh-status skills into ~/.gemini/config/agents and skills (backed up first)',
        update: 'Re-write the MCP entry, agents and skills (after path/config changes); originals backed up',
        restore: 'Remove the dsh-adapter mcp_config.json entry, ds-flash / ds-pro agents and dsh-config / dsh-status skills from ~/.gemini/config (backed up first)',
      },
      grok: {
        install: 'Write the dsh-adapter MCP server section into ~/.grok/config.toml and copy ds-flash / ds-pro agents plus dsh-config / dsh-status commands into ~/.grok/agents and commands (backed up first). Note: by security design grok does not start repo-level MCP servers in untrusted project directories — a global install is unaffected, but grok mcp doctor reports "folder untrusted" in an untrusted directory; change directory or pass --trust.',
        update: 'Re-write the config.toml MCP section, agents and commands (after path/config changes); originals backed up',
        restore: 'Remove the dsh-adapter config.toml section, ds-flash / ds-pro agents and dsh-config / dsh-status commands from ~/.grok (backed up first)',
      },
    },
  },
};

const S = {
  // Margins are tuned against the page container's 8px flex gap: the gap alone
  // sits below each heading, the margin only adds separation above it.
  section: { margin: '8px 0 -2px', fontSize: 13, fontWeight: 600 as const, opacity: 0.9 },
  // Small muted group label, matching the host's Agent-preset page (内置 / 自定义).
  group: { margin: '4px 0 -3px', fontSize: 12, opacity: 0.55 },
  // Card with a title + description header above its fields.
  block: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 10, padding: '11px 14px 13px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  blockGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '12px 14px', alignItems: 'end' as const },
  settingTitle: { fontWeight: 600 as const, fontSize: 13 },
  settingDesc: { fontSize: 11.5, opacity: 0.6, marginTop: 2, lineHeight: 1.5 },
  card: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const },
  grid: {
    border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '12px 14px',
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 14px', alignItems: 'end' as const,
  },
  btn: { padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
  chip: (on: boolean) => ({ fontSize: 11.5, padding: '1px 8px', borderRadius: 99, border: '1px solid', borderColor: on ? 'rgba(63,185,80,0.5)' : 'rgba(128,128,128,0.35)', color: on ? '#3fb950' : 'inherit', opacity: on ? 1 : 0.55 }),
  field: { display: 'flex', flexDirection: 'column' as const, gap: 3 },
  fieldLabel: { fontSize: 11, opacity: 0.6 },
  input: { padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 12.5 },
  cell: { padding: '5px 10px 5px 0', borderBottom: '1px solid rgba(128,128,128,0.16)', textAlign: 'left' as const, verticalAlign: 'top' as const },
  tight: {
    padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(128,128,128,0.16)', textAlign: 'left' as const,
    verticalAlign: 'top' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
  },
  mono: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontVariantNumeric: 'tabular-nums' as const },
  // History summary: four compact tiles on one row; auto-fit is avoided on
  // purpose because two rows of oversized cards pushed the table off-screen.
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(88px, 118px))', gap: 6, padding: 0, minWidth: 0 },
  stat: { display: 'flex', flexDirection: 'column' as const, gap: 1, border: '1px solid rgba(128,128,128,0.20)', borderRadius: 8, padding: '5px 9px', minWidth: 0, overflow: 'hidden' },
  statLabel: { fontSize: 10.5, opacity: 0.55, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  statValue: { fontSize: 15, fontWeight: 600 as const, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const },
  emptyBox: { border: '1px dashed rgba(128,128,128,0.35)', borderRadius: 10, padding: '20px 14px', textAlign: 'center' as const, fontSize: 12, minWidth: 0 },
  emptyTitle: { fontSize: 12.5, fontWeight: 500 as const, opacity: 0.95, marginBottom: 3 },
  emptyHint: { opacity: 0.65 },
};

const VISION_MODELS: Record<string, string[]> = {
  'claude-code': ['haiku', 'sonnet', 'opus'],
  codex: ['default', 'gpt-5.4-mini', 'gpt-5.6'],
  grok: ['default'],
  agy: ['default'],
};

function CustomSelect({ value, options, onChange, minWidth }: {
  value: string; options: Array<{ value: string; label?: string }>;
  onChange: (v: string) => void; minWidth?: number;
}) {
  const [open, setOpen] = useState<{ left: number; top: number; bottom: number; width: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (<>
    <button type="button"
      style={{ ...S.input, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: minWidth ?? 92, width: '100%', boxSizing: 'border-box' as const, justifyContent: 'space-between' }}
      onClick={(e: any) => {
        const r = e.currentTarget.getBoundingClientRect();
        const up = window.innerHeight - r.bottom < 240;
        setOpen({ left: r.left, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4, width: Math.max(r.width, 130), up });
      }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.label ?? value}</span>
      <span style={{ opacity: 0.5, fontSize: 10 }}>▾</span>
    </button>
    {open && createPortal(
      <div
        style={{
          position: 'fixed', left: open.left, ...(open.up ? { bottom: open.bottom } : { top: open.top }),
          minWidth: open.width, zIndex: 9999, background: 'Canvas', color: 'CanvasText',
          border: '1px solid rgba(128,128,128,0.3)', borderRadius: 8,
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 4, maxHeight: 240, overflowY: 'auto',
        }}
        onMouseDown={(e: any) => e.stopPropagation()}>
        {options.map((o) => (
          <div key={o.value}
            onClick={() => { onChange(o.value); setOpen(null); }}
            style={{
              padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap',
              background: o.value === value ? 'rgba(128,128,128,0.16)' : 'transparent',
              display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center',
            }}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = 'rgba(128,128,128,0.24)'; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = o.value === value ? 'rgba(128,128,128,0.16)' : 'transparent'; }}>
            <span>{o.label ?? o.value}</span>{o.value === value && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
          </div>
        ))}
      </div>, document.body)}
  </>);
}

function sourceLabel(source?: string) {
  if (source === 'claude-code') return 'CC';
  if (source === 'codex') return 'Codex';
  if (source === 'api' || source === undefined) return 'API';
  return source;
}

function elapsed(startedAt: string, endedAt?: string | null) {
  const s = Math.max(0, Math.round(((endedAt ? +new Date(endedAt) : Date.now()) - +new Date(startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function ktok(n: number) { return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`; }

function WorkersPanel({ ctx }: { ctx: any }) {
  const locale = useSyncExternalStore(
    (notify: () => void) => ctx.on('locale/change', notify),
    () => ctx.locale.getLocale().active,
    () => ctx.locale.getLocale().active,
  );
  const copy = COPY[locale === 'zh' ? 'zh' : 'en'];

  const [jobs, setJobs] = useState<any[]>([]); // live snapshot from /jobs
  const [ghosts, setGhosts] = useState<Record<string, any>>(() => readGhosts());

  // WPC14: proc-alive probe results for pid-carrying ghost tombstones, keyed
  // by job id. alive: null = probe failed / hub unreachable - it must never
  // render as a dead process, so only an affirmative probe shows the badge.
  const [procProbe, setProcProbe] = useState<Record<string, { at: number; alive: boolean | null }>>({});
  const procProbeAt = useRef<Record<string, number>>({}); // throttle: last attempt per ghost id
  const [killing, setKilling] = useState<Record<string, boolean>>({});

  const [jobsLoaded, setJobsLoaded] = useState(false); // first OK snapshot arrived
  const [hoverTask, setHoverTask] = useState<{ id: string; text: string; right: number; top: number; bottom: number; flip: boolean } | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [dynModels, setDynModels] = useState<Record<string, Array<{ value: string; label?: string }>>>({});
  const [presetRoster, setPresetRoster] = useState<{ defaultId?: string; presets: Array<{ id: string; name?: string; trust?: string }> }>({ presets: [] });
  // Labels are built at render, not at fetch, so they follow a locale switch.
  // A shipped preset's file carries its Chinese name only; the host localizes
  // it by id, and only for trust "system" so a user preset that happens to
  // reuse an id keeps its own name. Same rule here (#11).
  const presetOptions = useMemo(() => [
    { value: 'default', label: copy.presetDefault(presetRoster.defaultId) },
    ...presetRoster.presets.map((x) => ({
      value: x.id,
      label: (x.trust === 'system' && copy.builtInPresetNames[x.id]) || x.name || x.id,
    })),
  ], [presetRoster, copy]);
  const [notice, setNotice] = useState('');
  const configSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-integration feedback, rendered next to the button that was pressed.
  const [rowNote, setRowNote] = useState<Record<string, { kind: 'working' | 'ok' | 'error'; text: string }>>({});
  const [busy, setBusy] = useState(false);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobEvents, setJobEvents] = useState<Record<string, { items: any[]; status?: string; stale?: number | null }>>({});
  const jobCursor = useRef<Record<string, number>>({});
  const [historyAgg, setHistoryAgg] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historySeq = useRef(0);
  const [provForm, setProvForm] = useState<{
    originalId?: string; name: string; type: 'api' | 'cli'; models: string;
    base_url: string; api_key: string; imagegen_model: string;
    vision_command: string; imagegen_command: string;
  } | null>(null);
  const [modelAdd, setModelAdd] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ key: string; ok?: boolean; steps?: any[]; error?: string; busy: boolean } | null>(null);
  const TABS = ['workers', 'history', 'integrations', 'config'] as const;
  type TabKey = (typeof TABS)[number];
  // v2 key: the old tab order defaulted to Global config, which made both the
  // live board and history invisible on first open. A new key deliberately
  // discards that saved choice so "Workers" is the default view; history is
  // one click away and no longer shares the live board's screen.
  const [tab, setTab] = useState<TabKey>(() => {
    try {
      const saved = localStorage.getItem('dsh-adapter-tab-v2');
      return (TABS as readonly string[]).includes(saved ?? '') ? (saved as TabKey) : 'workers';
    } catch { return 'workers'; }
  });
  useEffect(() => { try { localStorage.setItem('dsh-adapter-tab-v2', tab); } catch { /* private mode */ } }, [tab]);
  // Deliberately no default dispatch-target select here: CLI backends stay
  // opt-in per call via the worker argument (see the read-only workerOptIn
  // card below). Re-adding a default would silently re-route every
  // unqualified dispatch to a CLI backend.

  /**
   * The panel is served from disk on every load, but the hub's routes are
   * registered at instance boot — after an upgrade the new UI can call a route
   * the running instance does not have yet, which answers 404/405 with an empty
   * body. Report that as "restart DSH" instead of a JSON parse error.
   */
  const readJson = useCallback(async (res: Response, path: string) => {
    const text = await res.text();
    if (text === '') {
      throw new Error(res.status === 404 || res.status === 405
        ? `${copy.staleHub}（${path} → HTTP ${res.status}）`
        : copy.emptyResponse(path, res.status));
    }
    try { return JSON.parse(text); } catch { throw new Error(copy.badJson(path, text.slice(0, 160))); }
  }, [copy]);
  /** Every request carries the active locale: the panel is the authority on it
   * (DSH's setting may be unset), and the hub localizes its own strings from it. */
  const withLang = useCallback((path: string) => `${API}${path}${path.includes('?') ? '&' : '?'}lang=${locale === 'zh' ? 'zh' : 'en'}`, [locale]);
  const get = useCallback(async (path: string) => readJson(await fetch(withLang(path), { cache: 'no-store' }), path), [readJson, withLang]);
  const post = useCallback(async (path: string, body: any) => readJson(await fetch(withLang(path), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, lang: locale === 'zh' ? 'zh' : 'en' }),
  }), path), [readJson, withLang, locale]);

  // Orphan-ghost lifecycle (WPC10): every OK /jobs snapshot reconciles with
  // the persistent ghost registry, so a running job that disappears without
  // reaching a terminal state is rendered as orphaned instead of vanishing.
  useEffect(() => { writeGhosts(ghosts); }, [ghosts]);
  const mergeJobs = useCallback((fresh: any[]) => {
    setJobs(fresh);
    setJobsLoaded(true);
    setGhosts((g) => reconcileGhosts(fresh, g, Date.now()));
  }, []);
  const dismissGhost = useCallback((id: string) => {
    setGhosts((g) => { const n = { ...g }; delete n[id]; return n; });
  }, []);
  const probeOne = useCallback(async (id: string, pid: number) => {
    let alive: boolean | null = null;
    try {
      const res = await fetch(withLang(`/proc-alive?pid=${pid}`), { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      alive = res.ok && body?.ok !== false && typeof body?.alive === 'boolean' ? body.alive : null;
    } catch { alive = null; } // hub unreachable / restarting: hide the badge
    setProcProbe((s) => ({ ...s, [id]: { at: Date.now(), alive } }));
  }, [withLang]);

  // Batch probe of pid-carrying ghost tombstones, throttled per ghost id
  // (dueProcProbes) so the 3s refresh loop never turns into a probe storm.
  useEffect(() => {
    const run = () => {
      const targets = dueProcProbes(ghosts, procProbeAt.current, Date.now());
      for (const t of targets) procProbeAt.current[t.id] = Date.now();
      if (targets.length > 0) void Promise.all(targets.map((t) => probeOne(t.id, t.pid)));
    };
    run();
    const timer = setInterval(run, 5000);
    return () => clearInterval(timer);
  }, [ghosts, probeOne]);

  const killGhostProc = useCallback(async (id: string) => {
    const g = ghosts[id];
    const p = g?.job ? ghostPidOf(g.job) : null;
    if (!p) return;
    setKilling((s) => ({ ...s, [id]: true }));
    try {
      const res = await fetch(withLang('/proc-kill'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: p.pid, ...(p.pgid === null ? {} : { pgid: p.pgid }), lang: locale === 'zh' ? 'zh' : 'en' }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok !== false && typeof body?.signal === 'string') {
        setNotice(body.alreadyGone ? copy.procKillAlreadyGone : copy.procKillDone);
        // Server confirmed the kill: drop the badge immediately, then re-probe
        // so the row shows the real state (refusal paths keep the badge).
        setProcProbe((s) => ({ ...s, [id]: { at: Date.now(), alive: false } }));
        void probeOne(id, p.pid);
      } else {
        setNotice(String(body?.error ?? `HTTP ${res.status}`));
        setProcProbe((s) => ({ ...s, [id]: { at: Date.now(), alive: true } }));
      }
    } catch (e: any) {
      setNotice(String(e?.message ?? e));
    } finally {
      setKilling((s) => ({ ...s, [id]: false }));
    }
  }, [ghosts, withLang, probeOne, copy, locale]);


  const refreshAll = useCallback(async () => {
    try {
      const [j, s, c, pr] = await Promise.all([get('/jobs'), get('/install/status'), get('/config'), get('/presets')]);
      if (j.ok) mergeJobs(j.jobs ?? []);
      if (s.ok) setStatus(s.status);
      if (c.ok) {
        setConfig((prev: any) => prev ?? c.config);
        // The desktop host binds an OS-assigned port on every launch, so the
        // stored hub_url goes stale and host-side MCP shims fall back to
        // standalone mode. Opening this page is the natural moment to repoint
        // it at the address the page itself was served from. A hub_url naming
        // another machine is left alone.
        const origin = window.location.origin;
        const hubUrl = String(c.config?.hub_url ?? '');
        const isLocalOrEmpty = hubUrl === '' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(hubUrl);
        if (/^https?:\/\//.test(origin) && isLocalOrEmpty && hubUrl !== origin) {
          void post('/config', { hub_url: origin }).then((r) => { if (r.ok) setConfig(r.config); }).catch(() => {});
        }
      }
      if (pr.ok) setPresetRoster({ defaultId: pr.defaultId, presets: pr.presets ?? [] });
    } catch { /* instance restarting */ }
  }, [get, post, mergeJobs]);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => { void get('/jobs').then((j) => { if (j.ok) mergeJobs(j.jobs ?? []); }).catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [refreshAll, get, mergeJobs]);

  const act = useCallback(async (target: string, confirmName?: string) => {
    if (confirmName && !window.confirm(copy.confirmRestore(confirmName))) return;
    setBusy(true); setNotice(copy.working);
    setRowNote((m) => ({ ...m, [target]: { kind: 'working', text: copy.working } }));
    try {
      const r = await post('/install', { target });
      if (r.ok === false) throw new Error(r.error);
      setNotice((r.actions ?? []).join('；'));
      setRowNote((m) => ({ ...m, [target]: { kind: 'ok', text: copy.doneAt(new Date().toLocaleTimeString()) } }));
      const s = await get('/install/status'); if (s.ok) setStatus(s.status);
    } catch (e: any) {
      setNotice(String(e?.message ?? e));
      setRowNote((m) => ({ ...m, [target]: { kind: 'error', text: String(e?.message ?? e) } }));
    } finally { setBusy(false); }
  }, [post, get, copy]);

  const applyPatch = useCallback((patch: Record<string, any>): Promise<boolean> => {
    // Serialize writes so rapid edits cannot be persisted out of order. The
    // optimistic UI is reconciled with the server after every failed write.
    const save = configSaveQueue.current.then(() => persistConfigPatch(patch, {
      post, get, onConfig: setConfig,
      onNotice: (message: string) => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        setNotice(message);
        if (message === copy.saved) noticeTimer.current = setTimeout(() => setNotice(''), 1500);
      },
      copy,
    }));
    configSaveQueue.current = save;
    return save;
  }, [post, get, copy]);
  const loadHistory = useCallback(() => {
    const seq = ++historySeq.current;
    setHistoryLoading(true);
    void get('/history?limit=100').then((r) => {
      // A slower earlier request must not overwrite a newer one or clear its
      // loading flag; only the newest sequence owns the state.
      if (r.ok && historySeq.current === seq) { setHistoryRows(r.records ?? []); setHistoryAgg(r.stats ?? null); }
    }).catch(() => {}).finally(() => {
      if (historySeq.current === seq) setHistoryLoading(false);
    });
  }, [get]);
  // History is a separate, collapsed view: fetch it only when that tab is
  // opened instead of loading a 100-row table on every panel mount.
  useEffect(() => { if (tab === 'history') loadHistory(); }, [loadHistory, tab]);

  const loadJobEvents = useCallback(async (id: string) => {
    try {
      const r = await get(`/jobs/${encodeURIComponent(id)}/events?after=${jobCursor.current[id] ?? 0}&wait=0`);
      if (!r.ok) return;
      jobCursor.current[id] = r.cursor ?? jobCursor.current[id] ?? 0;
      setJobEvents((m) => ({
        ...m,
        [id]: { items: [...(m[id]?.items ?? []), ...(r.events ?? [])].slice(-200), status: r.status, stale: r.staleSeconds },
      }));
    } catch { /* hub restarting */ }
  }, [get]);

  const toggleJob = useCallback((id: string) => {
    setExpandedJob((current) => {
      if (current === id) return null;
      jobCursor.current[id] = 0;
      setJobEvents((m) => ({ ...m, [id]: { items: [] } }));
      void loadJobEvents(id);
      return id;
    });
  }, [loadJobEvents]);

  useEffect(() => {
    if (!expandedJob) return;
    const job = jobs.find((j: any) => j?.id === expandedJob);
    if (!job || job.status !== 'running') return;
    const timer = setInterval(() => { void loadJobEvents(expandedJob); }, 2000);
    return () => clearInterval(timer);
  }, [expandedJob, jobs, loadJobEvents]);

  /** Selects & checkboxes: apply immediately. */
  const field = (key: string, value: any) => {
    setConfig((c: any) => ({ ...c, [key]: value }));
    applyPatch({ [key]: value });
  };
  /** Text/number inputs: track locally, apply on blur. */
  const fieldLocal = (key: string, value: any) => setConfig((c: any) => ({ ...c, [key]: value }));

  // --- custom providers & user-added models -------------------------------
  const customProviders: any[] = config?.custom_providers ?? [];
  const extraModels: Record<string, string[]> = config?.extra_models ?? {};
  const RESERVED_IDS = ['claude-code', 'codex', 'grok', 'agy', 'off', 'custom', 'default'];
  const provType = (p: any): 'api' | 'cli' => p.type ?? ((p.vision_command || p.imagegen_command) ? 'cli' : 'api');
  const canSee = (p: any) => (provType(p) === 'cli' ? !!p.vision_command : !!p.base_url && (p.models?.length ?? 0) > 0);
  const canDraw = (p: any) => (provType(p) === 'cli' ? !!p.imagegen_command : !!p.base_url && !!String(p.imagegen_model ?? '').trim());
  const visionProviderOptions = [
    { value: 'claude-code' }, { value: 'codex' }, { value: 'grok' }, { value: 'agy' },
    ...customProviders.filter(canSee).map((p) => ({ value: p.id, label: p.name || p.id })),
    { value: 'off' },
  ];
  const imagegenProviderOptions = [
    { value: 'codex' }, { value: 'agy', label: 'agy (nano banana)' }, { value: 'grok', label: 'grok (imagine)' },
    ...customProviders.filter(canDraw).map((p) => ({ value: p.id, label: p.name || p.id })),
    { value: 'off' },
  ];
  const visionModelOptions = (() => {
    if (!config) return [];
    const p = config.vision_provider;
    const custom = customProviders.find((c) => c.id === p);
    const base: Array<{ value: string; label?: string }> = custom
      ? [{ value: 'default' }, ...(custom.models ?? []).map((m: string) => ({ value: m }))]
      : dynModels[p] ?? (VISION_MODELS[p] ?? ['default']).map((m) => ({ value: m }));
    const extras = (extraModels[p] ?? []).filter((m) => !base.some((o) => o.value === m)).map((m) => ({ value: m }));
    return [...base, ...extras];
  })();
  const commitModelAdd = () => {
    const m = (modelAdd ?? '').trim();
    setModelAdd(null);
    if (m === '' || !config) return;
    const p = config.vision_provider;
    const cur = extraModels[p] ?? [];
    const nextExtra = { ...extraModels, [p]: cur.includes(m) ? cur : [...cur, m] };
    setConfig((c: any) => ({ ...c, extra_models: nextExtra, vision_model: m }));
    applyPatch({ extra_models: nextExtra, vision_model: m });
  };
  const removeCurrentModel = () => {
    if (!config) return;
    const p = config.vision_provider;
    const m = config.vision_model;
    const nextExtra = { ...extraModels, [p]: (extraModels[p] ?? []).filter((x) => x !== m) };
    const fallback = visionModelOptions.find((o) => o.value !== m)?.value ?? 'default';
    setConfig((c: any) => ({ ...c, extra_models: nextExtra, vision_model: fallback }));
    applyPatch({ extra_models: nextExtra, vision_model: fallback });
  };
  const saveProviderForm = () => {
    if (!provForm || !config) return;
    const name = provForm.name.trim();
    if (name === '') { setNotice(copy.needName); return; }
    const models = provForm.models.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    const vision_command = provForm.vision_command.trim();
    const imagegen_command = provForm.imagegen_command.trim();
    if (provForm.type === 'cli') {
      if (vision_command === '' && imagegen_command === '') { setNotice(copy.needCmd); return; }
    } else {
      if (provForm.base_url.trim() === '') { setNotice(copy.needBaseUrl); return; }
      if (models.length === 0) { setNotice(copy.needModels); return; }
    }
    let id = provForm.originalId;
    if (!id) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
      id = base;
      let n = 2;
      while (RESERVED_IDS.includes(id) || customProviders.some((p) => p.id === id)) id = `${base}-${n++}`;
    }
    const entry = provForm.type === 'api'
      ? {
        id, name, type: 'api', models,
        base_url: provForm.base_url.trim(),
        api_key: provForm.api_key,
        imagegen_model: provForm.imagegen_model.trim(),
      }
      : { id, name, type: 'cli', models, vision_command, imagegen_command };
    const next = provForm.originalId
      ? customProviders.map((p) => (p.id === provForm.originalId ? entry : p))
      : [...customProviders, entry];
    field('custom_providers', next);
    setProvForm(null);
  };
  const runProviderTest = (key: string, entry: any) => {
    setTestResult({ key, busy: true });
    void post('/provider-test', entry)
      .then((r) => setTestResult(r.ok
        ? { key, busy: false, ok: r.result.ok, steps: r.result.steps }
        : { key, busy: false, ok: false, error: r.error }))
      .catch((e) => setTestResult({ key, busy: false, ok: false, error: String(e?.message ?? e) }));
  };
  /** Shared renderer for a test outcome under the button that triggered it. */
  const testReport = (key: string) => {
    if (!testResult || testResult.key !== key) return null;
    if (testResult.busy) return <div style={{ fontSize: 11.5, opacity: 0.6 }}>{copy.testing}</div>;
    return (
      <div style={{ fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: testResult.ok ? '#3fb950' : '#f85149' }}>
          {testResult.ok ? `✓ ${copy.testPass}` : `✗ ${copy.testFail}`}
        </span>
        {testResult.error && <span style={{ opacity: 0.7, wordBreak: 'break-all' as const }}>{testResult.error}</span>}
        {(testResult.steps ?? []).map((st: any, i: number) => (
          <span key={i} style={{ opacity: 0.7, wordBreak: 'break-all' as const }}>
            <span style={{ color: st.ok ? '#3fb950' : '#f85149' }}>{st.ok ? '✓' : '✗'}</span> {st.name}: {st.detail}
          </span>
        ))}
      </div>
    );
  };
  const deleteProvider = (id: string) => {
    if (!config) return;
    const patch: any = { custom_providers: customProviders.filter((p) => p.id !== id) };
    if (config.vision_provider === id) { patch.vision_provider = 'claude-code'; patch.vision_model = 'haiku'; }
    if (config.imagegen_provider === id) patch.imagegen_provider = 'codex';
    setConfig((c: any) => ({ ...c, ...patch }));
    applyPatch(patch);
  };

  /** Card: title + one-line description header, then its fields. */
  const block = (text: { t: string; d: string }, fields: any, gridded = true) => (
    <div style={S.block}>
      <div>
        <div style={S.settingTitle}>{text.t}</div>
        <div style={S.settingDesc}>{text.d}</div>
      </div>
      {gridded ? <div style={S.blockGrid}>{fields}</div> : fields}
    </div>
  );

  const integrationRow = (name: string, installed: boolean, detected: boolean, extra: any, installTarget: string, uninstallTarget: string, tips: any) => {
    // `installed` means our integration files are present; `detected` means
    // the host software itself is installed. They are independent: a fresh
    // Codex install has no ds-flash.toml yet and must still read "detected".
    const dotColor = installed ? '#3fb950' : detected ? '#d29922' : 'rgba(128,128,128,0.45)';
    const chipStyle = installed
      ? S.chip(true)
      : detected
        ? { ...S.chip(false), color: '#d29922', borderColor: 'rgba(210,153,34,0.5)', opacity: 1 }
        : S.chip(false);
    return (
    <div style={{ ...S.card, transition: 'background 120ms ease', borderRadius: 8 }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = 'rgba(128,128,128,0.06)'; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13, minWidth: 92 }}>
        <span aria-hidden="true" title={installed ? copy.installed : detected ? copy.hostDetected : copy.hostMissing} style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: dotColor,
          boxShadow: installed ? '0 0 0 2px rgba(63,185,80,0.18)' : 'none',
        }} />
        {name}
      </span>
      <span style={chipStyle} title={installed ? copy.installed : detected ? copy.hostDetected : copy.hostMissing}>
        {installed ? `● ${copy.installed}` : detected ? `● ${copy.hostDetected}` : `○ ${copy.hostMissing}`}
      </span>
      {!installed && detected && <span style={S.chip(false)}>{copy.notIntegrated}</span>}
      {extra}
      <span style={{ flex: 1 }} />
      {!installed && <button style={S.btn} title={tips.install} disabled={busy} onClick={() => { void act(installTarget); }}>{copy.install}</button>}
      {installed && <button style={S.btn} title={tips.update} disabled={busy} onClick={() => { void act(installTarget); }}>{rowNote[installTarget]?.kind === 'working' ? copy.working : copy.update}</button>}
      {installed && <button style={{ ...S.btn, opacity: 0.75 }} title={tips.restore} disabled={busy} onClick={() => { void act(uninstallTarget, name); }}>{copy.restore}</button>}
      {rowNote[installTarget] && (
        <span style={{
          fontSize: 11.5, maxWidth: 260, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', overflowWrap: 'anywhere',
          opacity: rowNote[installTarget].kind === 'working' ? 0.6 : 0.85,
          color: rowNote[installTarget].kind === 'error' ? '#e5484d' : undefined,
        }} title={rowNote[installTarget].text}>{rowNote[installTarget].text}</span>
      )}
    </div>
    );
  };

  /** Clickable section header that toggles its section's collapsed state. */

  // --- jobs board (WPC10; workspace groups + lock badges: WPC13) ------------
  const rows = jobsLoaded ? displayJobs(jobs, ghosts) : [];
  const groups = groupJobs(rows);
  const locks = workspaceLocks(rows);
  /** One job row: status (with orphan/stall labeling), progress, tokens and a
   * single-line task cell (WPC13). */
  const renderJobRow = (job: any) => {
    const ghostRow = !!ghosts[job.id] && !jobs.some((l) => l?.id === job.id);
    const info = statusInfoOf(job, copy);
    const pb = procBadgeOf(job, procProbe[job.id]);
    const expanded = expandedJob === job.id;
    const ev = jobEvents[job.id];
    return (
      <Fragment key={job.id}>
      <tr onClick={() => toggleJob(job.id)} title={copy.eventsHint}
        style={{ cursor: 'pointer', ...(job.status === 'orphaned' ? { background: 'rgba(240,136,62,0.05)' } : {}) }}>
        <td style={{ ...S.tight, ...S.mono }} title={job.origin ? `${job.id} · ${job.origin}` : job.id}>{String(job.id).replace(/-[a-z0-9]+$/, '')}</td>
        <td style={S.tight}><span style={S.chip(job.source === 'claude-code' || job.source === 'codex')}>{sourceLabel(job.source)}</span></td>
        <td style={S.tight} title={job.profile ? `profile: ${job.profile} · backend: ${job.backend}` : undefined}>{job.tier}/{job.effort}</td>
        <td style={{ ...S.tight, minWidth: 82 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            title={job.currentTool ? `${info.title} · ${job.currentTool}` : info.title}>
            <span style={{ color: info.color, cursor: 'default' }}>●</span>
            <span style={{ fontSize: 11, color: info.color, whiteSpace: 'nowrap' }}>{info.label}</span>
            {job.status === 'running' && (job.staleSeconds ?? 0) >= 120 && (
              <span title={copy.quietTip(job.currentTool ?? '')} style={{ fontSize: 10.5, color: '#f0883e', whiteSpace: 'nowrap' }}>
                {copy.quiet(job.staleSeconds >= 60 ? `${Math.round(job.staleSeconds / 60)}m` : `${job.staleSeconds}s`)}
              </span>
            )}
            {ghostRow && (
              <button type="button" title={copy.orphanDismiss} aria-label={copy.orphanDismiss}
                style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: 0, opacity: 0.55, lineHeight: 1 }}
                onClick={(e: any) => { e.stopPropagation(); dismissGhost(job.id); }}>×</button>
            )}
          </div>
        </td>
        <td style={{ ...S.tight, ...S.mono }} title={copy.progressTip(elapsed(job.startedAt, job.endedAt), job.turn, job.step, job.toolCalls ?? '-')}>{elapsed(job.startedAt, job.endedAt)} {job.turn}.{job.step} {job.toolCalls ?? '-'}t</td>
        <td style={{ ...S.tight, ...S.mono }}>{job.tokens ? `${ktok(job.tokens.input)}/${ktok(job.tokens.output)}` : '-'}</td>
        <td
          style={{ ...S.cell, position: 'relative' }}
          onMouseEnter={(e: any) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHoverTask({
              id: job.id, text: job.task,
              right: Math.max(8, window.innerWidth - rect.right),
              top: rect.bottom + 4,
              bottom: window.innerHeight - rect.top + 4,
              flip: rect.top < 240,
            });
          }}
          onMouseLeave={() => setHoverTask(null)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.45, fontSize: 12.5 }}>
              {job.task}
              {job.status === 'needs_input' && <div style={{ whiteSpace: 'normal', color: '#d29922', marginTop: 4 }}>{(job.questions ?? []).map((q: any) => q.question).join(' · ')}</div>}
            </div>
            {pb && (
              <>
                <span title={copy.procAliveBadgeTip(pb.pid)}
                  style={{ flexShrink: 0, fontSize: 11, color: '#f0883e', whiteSpace: 'nowrap', padding: '0 7px', borderRadius: 99, border: '1px solid rgba(240,136,62,0.55)' }}>
                  {copy.procAliveBadge}
                </span>
                <button type="button" disabled={!!killing[job.id]} title={copy.procKillTip(pb.pid)}
                  style={{ flexShrink: 0, fontSize: 11, padding: '0 8px', borderRadius: 99, border: '1px solid rgba(240,136,62,0.65)', background: 'transparent', color: '#f0883e', cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={(e: any) => { e.stopPropagation(); void killGhostProc(job.id); }}>
                  {killing[job.id] ? copy.procKilling : copy.procKill}
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ ...S.tight, background: 'rgba(128,128,128,0.045)', padding: '8px 10px' }}>
            <div style={{ fontSize: 11.5, opacity: 0.75, marginBottom: 6 }}>
              {copy.eventsTitle} · {copy.eventsMeta(job)}
            </div>
            {!String(job.id).startsWith('hub-') ? (
              <div style={{ fontSize: 11.5, opacity: 0.6 }}>{copy.eventsOnlyHub}</div>
            ) : (ev?.items?.length ?? 0) === 0 ? (
              <div style={{ fontSize: 11.5, opacity: 0.6 }}>{copy.eventsEmpty}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
                {ev!.items.map((e: any) => {
                  const label = e.kind === 'tool' ? copy.eventTool
                    : e.kind === 'tool-result' ? copy.eventResult
                    : e.kind === 'text' ? copy.eventText
                    : e.kind === 'step' ? copy.eventStep
                    : e.kind === 'turn-end' ? copy.eventEnd
                    : e.kind === 'approval' ? copy.eventApproval
                    : e.kind === 'approval-result' ? copy.eventApproval
                    : e.kind;
                  const color = e.kind === 'tool' ? '#4c8dff'
                    : e.kind === 'tool-result' ? (e.ok === false ? '#e5484d' : '#3fb950')
                    : (e.kind === 'approval' || e.kind === 'approval-result') ? '#f0883e'
                    : undefined;
                  const body = e.kind === 'step' ? `${e.turn ?? '?'}.${e.step ?? '?'}`
                    : e.kind === 'tool' ? `${e.tool}${e.detail ? ' ' + e.detail : ''}`
                    : e.kind === 'tool-result' ? `${e.tool ?? ''}${e.detail ? ' ' + e.detail : ''}`
                    : e.kind === 'text' ? e.text
                    : e.kind === 'turn-end' ? (e.reason ?? '')
                    : '';
                  return (
                    <div key={e.seq} style={{ display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.55 }}>
                      <span style={{ opacity: 0.5, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                        {e.at ? new Date(e.at).toLocaleTimeString() : ''}
                      </span>
                      <span style={{ minWidth: 42, flexShrink: 0, color }}>{label}</span>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9 }}>{body}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
      </Fragment>
    );
  };

  const runningJobs = jobsLoaded ? jobs.filter((j: any) => j.status === 'running' && j.originWriterAlive !== false).length : 0;
  const historyStatusMeta = (status: string) => {
    if (status === 'done') return { label: copy.statusDone, color: '#3fb950' };
    if (status === 'failed') return { label: copy.statusFailed, color: '#e5484d' };
    if (status === 'cancelled') return { label: copy.statusCancelled, color: '#d29922' };
    return { label: status || '—', color: 'inherit' };
  };
  const historyTime = (iso: string | null | undefined) => {
    const d = new Date(iso ?? '');
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55, width: '100%', minWidth: 0, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ fontSize: 21, fontWeight: 600, marginBottom: -2 }}>{copy.title}</div>
      <div style={{ opacity: 0.75 }}>{copy.intro}</div>

      <div role="tablist" aria-label={copy.title}
        onKeyDown={(e: any) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const index = TABS.indexOf(tab);
          const step = e.key === 'ArrowRight' ? 1 : TABS.length - 1;
          setTab(TABS[(index + step) % TABS.length]);
        }}
        style={{
          position: 'sticky', top: 0, zIndex: 6, display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, marginBottom: 2,
          padding: 4, background: 'Canvas',
          border: '1px solid rgba(128,128,128,0.18)', borderRadius: 10,
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}>
        {([['workers', copy.workerStatus], ['history', copy.history], ['integrations', copy.integrations], ['config', copy.globalConfig]] as const).map(([key, label]) => {
          const active = tab === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              onClick={() => setTab(key)}
              onMouseEnter={(e: any) => { if (!active) e.currentTarget.style.background = 'rgba(128,128,128,0.10)'; }}
              onMouseLeave={(e: any) => { e.currentTarget.style.background = active ? 'rgba(76,141,255,0.14)' : 'transparent'; }}
              style={{
                display: 'inline-flex', alignItems: 'center', minWidth: 0,
                padding: '5px 12px', fontSize: 12.5, border: 'none',
                background: active ? 'rgba(76,141,255,0.14)' : 'transparent',
                cursor: 'pointer', borderRadius: 8,
                color: active ? '#4c8dff' : 'inherit',
                fontWeight: active ? 600 : 500,
                opacity: active ? 1 : 0.7,
                boxShadow: active ? 'inset 0 0 0 1px rgba(76,141,255,0.30)' : 'none',
                transition: 'color 120ms ease, background 120ms ease, opacity 120ms ease',
              }}>
              {label}
              {key === 'workers' && runningJobs > 0 && (
                <span aria-label={String(runningJobs)} style={{
                  marginLeft: 6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99,
                  background: '#4c8dff', color: '#fff', fontSize: 10.5, lineHeight: '16px',
                  textAlign: 'center', fontWeight: 600,
                }}>{runningJobs}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'integrations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {integrationRow('Claude Code', !!status?.claude?.installed, !!status?.claude?.detected,
            status?.claude?.installed ? <span style={S.chip(!!status?.claude?.hud)}>{copy.hud}</span> : null,
            'claude', 'claude-uninstall', (copy as any).tips.claude)}
          {integrationRow('Codex', !!status?.codex?.installed, !!status?.codex?.detected, null, 'codex', 'codex-uninstall', (copy as any).tips.codex)}
          {integrationRow('Antigravity', !!status?.agy?.installed, !!status?.agy?.detected, null, 'agy', 'agy-uninstall', (copy as any).tips.agy)}
          {integrationRow('Grok', !!status?.grok?.installed, !!status?.grok?.detected, null, 'grok', 'grok-uninstall', (copy as any).tips.grok)}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, paddingLeft: 2, opacity: config ? 1 : 0.5 }}
            title={copy.globalMcpHint}>
            <input type="checkbox" checked={config?.codex_global_mcp !== false} disabled={busy || !config}
              onChange={(e) => {
                const on = e.target.checked;
                setConfig((c: any) => ({ ...c, codex_global_mcp: on }));
                void applyPatch({ codex_global_mcp: on }).then((saved) => {
                  if (saved && status?.codex?.installed) void act('codex');
                });
              }} />
            <span>{copy.globalMcp}</span>
          </label>
        </div>
      )}

      {tab === 'config' && (<>
      {config && (<>
        <div style={S.group}>{copy.groupDispatch}</div>
        {block(copy.cardDispatch, (<>
          <label style={S.field}><span style={S.fieldLabel}>{copy.tier}</span>
            <CustomSelect value={config.default_tier} onChange={(v) => field('default_tier', v)}
              options={[{ value: 'flash', label: copy.tierFlash }, { value: 'pro', label: copy.tierPro }]} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.effort}</span>
            <CustomSelect value={config.default_effort} onChange={(v) => field('default_effort', v)}
              options={[{ value: 'off' }, { value: 'high' }, { value: 'max' }]} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.tierPolicy}</span>
            <CustomSelect value={config.tier_policy} onChange={(v) => field('tier_policy', v)}
              options={(['auto', 'flash-only', 'pro-only'] as const).map((p) => ({ value: p, label: copy.tierPolicyDesc[p] }))} /></label>
          <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, paddingBottom: 5 }} title={copy.escalateHint}>
            <input type="checkbox" checked={!!config.escalate_on_failure} onChange={(e) => field('escalate_on_failure', e.target.checked)} />
            <span style={{ fontSize: 12 }}>{copy.escalate}</span></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.presetFlash}</span>
            <CustomSelect value={config.preset_flash ?? 'default'} onChange={(v) => field('preset_flash', v)} options={presetOptions} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.presetPro}</span>
            <CustomSelect value={config.preset_pro ?? 'default'} onChange={(v) => field('preset_pro', v)} options={presetOptions} /></label>
        </>))}


        <div style={S.group}>{copy.groupRuntime}</div>
        {block(copy.cardRuntime, (<>
          <label style={S.field}><span style={S.fieldLabel}>{copy.mode}</span>
            <CustomSelect value={config.mode} onChange={(v) => field('mode', v)}
              options={(['hub', 'auto', 'standalone'] as const).map((m) => ({ value: m, label: copy.modeDesc[m] }))} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.timeout}</span>
            <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }} type="number" min={60} max={7200} value={config.default_timeout_seconds}
              onChange={(e) => fieldLocal('default_timeout_seconds', Number(e.target.value))}
              onBlur={() => applyPatch({ default_timeout_seconds: config.default_timeout_seconds })} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.hubUrl}</span>
            <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }} value={config.hub_url}
              onChange={(e) => fieldLocal('hub_url', e.target.value)}
              onBlur={() => applyPatch({ hub_url: config.hub_url })}
              onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
        </>))}

        <div style={S.group}>{copy.groupMultimodal}</div>
        {block(copy.cardMM, (<>
          <label style={S.field}><span style={S.fieldLabel}>{copy.visionProvider}</span>
            <CustomSelect value={config.vision_provider}
              onChange={(p) => {
                const custom = customProviders.find((c) => c.id === p);
                const m = custom ? (custom.models?.[0] ?? 'default') : (VISION_MODELS[p] ?? ['default'])[0];
                setModelAdd(null);
                setConfig((c: any) => ({ ...c, vision_provider: p, vision_model: m }));
                applyPatch({ vision_provider: p, vision_model: m });
                if ((p === 'grok' || p === 'agy') && !dynModels[p]) {
                  void get(`/vision-models?provider=${p}`).then((r) => {
                    if (r.ok) setDynModels((d) => ({ ...d, [p]: r.models }));
                  }).catch(() => {});
                }
              }}
              options={visionProviderOptions} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.visionModel}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {modelAdd === null ? (
                <CustomSelect value={config.vision_model} onChange={(v) => field('vision_model', v)}
                  options={visionModelOptions} />
              ) : (
                <input autoFocus style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                  value={modelAdd} placeholder={copy.modelPlaceholder}
                  onChange={(e) => setModelAdd(e.target.value)}
                  onBlur={commitModelAdd}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setModelAdd(null);
                  }} />
              )}
              {modelAdd === null && (config.vision_provider === 'grok' || config.vision_provider === 'agy') && (
                <button type="button" title={copy.refreshModels} disabled={busy}
                  style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={() => {
                    const p = config.vision_provider;
                    setBusy(true);
                    void get(`/vision-models?provider=${p}&refresh=1`)
                      .then((r) => { if (r.ok) setDynModels((d) => ({ ...d, [p]: r.models })); })
                      .catch(() => {})
                      .finally(() => setBusy(false));
                  }}>↻</button>
              )}
              {modelAdd === null && config.vision_provider !== 'off' && (
                <button type="button" title={copy.addModelTip} style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={() => setModelAdd('')}>＋</button>
              )}
              {modelAdd === null && (extraModels[config.vision_provider] ?? []).includes(config.vision_model) && (
                <button type="button" title={copy.removeModelTip} style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={removeCurrentModel}>−</button>
              )}
            </div></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenProvider}</span>
            <CustomSelect value={config.imagegen_provider} onChange={(v) => field('imagegen_provider', v)}
              options={imagegenProviderOptions} /></label>
        </>))}

        {block(copy.cardCustomProv, (<>
          {customProviders.length === 0 && provForm === null && (
            <div style={{ fontSize: 12, opacity: 0.5 }}>{copy.noCustomProviders}</div>
          )}
          {customProviders.map((p) => (
            <div key={p.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0 }}>
              <span style={{ fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{p.name || p.id}</span>
              <span style={{ ...S.chip(false), opacity: 0.7 }}>{provType(p) === 'api' ? 'API' : 'CLI'}</span>
              {canSee(p) && <span style={S.chip(true)}>{copy.capVision}</span>}
              {canDraw(p) && <span style={S.chip(true)}>{copy.capImagegen}</span>}
              {provType(p) === 'api' && !!p.api_key && <span style={{ fontSize: 11.5, opacity: 0.5 }}>key {copy.keySet}</span>}
              <span style={{ flex: 1 }} />
              <button style={{ ...S.btn, padding: '2px 8px' }} title={copy.testTip}
                disabled={!!testResult?.busy}
                onClick={() => runProviderTest(`row:${p.id}`, p)}>
                {testResult?.key === `row:${p.id}` && testResult.busy ? copy.testing : copy.testProvider}</button>
              <button style={{ ...S.btn, padding: '2px 8px' }}
                onClick={() => setProvForm({
                  originalId: p.id, name: p.name ?? p.id, type: provType(p),
                  models: (p.models ?? []).join(', '),
                  base_url: p.base_url ?? '', api_key: p.api_key ?? '', imagegen_model: p.imagegen_model ?? '',
                  vision_command: p.vision_command ?? '', imagegen_command: p.imagegen_command ?? '',
                })}>{copy.edit}</button>
              <button style={{ ...S.btn, padding: '2px 8px', opacity: 0.75 }}
                onClick={() => { if (confirm(copy.confirmDeleteProvider(p.name || p.id))) deleteProvider(p.id); }}>{copy.del}</button>
            </div>
          ))}
          {customProviders.some((p) => testResult?.key === `row:${p.id}`) && testReport(testResult!.key)}
          {provForm === null ? (
            <div><button style={S.btn} onClick={() => setProvForm({
              name: '', type: 'api', models: '', base_url: '', api_key: '', imagegen_model: '',
              vision_command: '', imagegen_command: '',
            })}>{copy.addProvider}</button></div>
          ) : (
            <div style={{ borderTop: '1px solid rgba(128,128,128,0.16)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={S.blockGrid}>
                <label style={S.field}><span style={S.fieldLabel}>{copy.providerName}</span>
                  <input autoFocus style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }}
                    value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.providerType}</span>
                  <CustomSelect value={provForm.type} onChange={(v) => setProvForm({ ...provForm, type: v as 'api' | 'cli' })}
                    options={[{ value: 'api', label: copy.typeApi }, { value: 'cli', label: copy.typeCli }]} /></label>
              </div>
              {provForm.type === 'api' ? (<>
                <div style={S.blockGrid}>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.baseUrl}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.base_url} placeholder="https://api.example.com/v1"
                      onChange={(e) => setProvForm({ ...provForm, base_url: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.apiKey}</span>
                    <input type="password" autoComplete="off" style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.api_key} placeholder={copy.keyPlaceholder}
                      onChange={(e) => setProvForm({ ...provForm, api_key: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.modelsField}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.models} placeholder="gpt-4o-mini, qwen-vl-max"
                      onChange={(e) => setProvForm({ ...provForm, models: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenModel}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.imagegen_model} placeholder="dall-e-3"
                      onChange={(e) => setProvForm({ ...provForm, imagegen_model: e.target.value })} /></label>
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.55 }}>{copy.apiFormHint}</div>
              </>) : (<>
                <label style={S.field}><span style={S.fieldLabel}>{copy.visionCmd}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.vision_command} placeholder="mycli see {image} --ask {question} --model {model}"
                    onChange={(e) => setProvForm({ ...provForm, vision_command: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenCmd}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.imagegen_command} placeholder="mycli gen {prompt} -o {output}"
                    onChange={(e) => setProvForm({ ...provForm, imagegen_command: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.modelsField}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.models} placeholder="model-a, model-b"
                    onChange={(e) => setProvForm({ ...provForm, models: e.target.value })} /></label>
                <div style={{ fontSize: 11.5, opacity: 0.55 }}>{copy.cliFormHint}</div>
              </>)}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button style={S.btn} onClick={saveProviderForm}>{copy.saveProvider}</button>
                <button style={S.btn} title={copy.testTip} disabled={!!testResult?.busy}
                  onClick={() => runProviderTest('form', {
                    id: provForm.originalId ?? 'draft', name: provForm.name || 'draft', type: provForm.type,
                    models: provForm.models.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean),
                    base_url: provForm.base_url.trim(), api_key: provForm.api_key,
                    imagegen_model: provForm.imagegen_model.trim(),
                    vision_command: provForm.vision_command.trim(), imagegen_command: provForm.imagegen_command.trim(),
                  })}>
                  {testResult?.key === 'form' && testResult.busy ? copy.testing : copy.testProvider}</button>
                <button style={{ ...S.btn, opacity: 0.75 }} onClick={() => setProvForm(null)}>{copy.cancel}</button>
              </div>
              {testReport('form')}
            </div>
          )}
        </>), false)}
      </>)}
      <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 2 }}>{copy.globalHint}</div>
      </>)}

      {notice !== '' && <div style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap' }}>{notice}</div>}

      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ ...S.statGrid }} role="status" aria-live="polite">
              {historyStatItems(historyAgg, copy).map(({ key, label, value }) => (
                <div key={key} style={S.stat}>
                  <span style={S.statLabel}>{label}</span>
                  <strong style={S.statValue}>{value}</strong>
                </div>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <button type="button" style={{ ...S.btn, padding: '4px 10px', alignSelf: 'center', flexShrink: 0 }}
              disabled={historyLoading} onClick={loadHistory}>
              {historyLoading ? copy.loading : copy.historyRefresh}
            </button>
          </div>
          {historyLoading && historyRows.length === 0 ? (
            <div style={{ opacity: 0.55, fontSize: 12 }}>{copy.loading}</div>
          ) : historyRows.length === 0 ? (
            <div style={S.emptyBox}>
              <div style={S.emptyTitle}>{copy.historyEmpty}</div>
              <div style={S.emptyHint}>{copy.historyEmptyHint}</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid rgba(128,128,128,0.16)', borderRadius: 10, padding: '0 10px' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760, tableLayout: 'fixed', fontSize: 12 }}>
                <colgroup>
                  <col style={{ width: 138 }} />
                  <col style={{ width: 86 }} />
                  <col />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 64 }} />
                  <col style={{ width: 72 }} />
                </colgroup>
                <thead>
                  <tr style={{ textAlign: 'left', background: 'rgba(128,128,128,0.06)', opacity: 0.72 }}>
                    {[copy.historyTime, copy.historyStatus, copy.historyTask, copy.historyModel, copy.historyTier, copy.historyCost].map((h) => (
                      <th key={h} style={{ padding: '6px 8px', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((r) => {
                    const start = Date.parse(r.startedAt ?? '');
                    const end = Date.parse(r.endedAt ?? '');
                    const secs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? ((end - start) / 1000).toFixed(1) + 's' : '—';
                    const status = historyStatusMeta(r.status);
                    const model = `${r.model ?? '—'}${r.effort ? ` @${r.effort}` : ''}`;
                    const task = r.task ?? '';
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid rgba(128,128,128,0.14)', transition: 'background 120ms ease' }}
                        onMouseEnter={(e: any) => { e.currentTarget.style.background = 'rgba(128,128,128,0.05)'; }}
                        onMouseLeave={(e: any) => { e.currentTarget.style.background = 'transparent'; }}>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}
                          title={r.endedAt ? new Date(r.endedAt).toLocaleString() : undefined}>{historyTime(r.endedAt)}</td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: status.color }}>
                            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
                            {status.label}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', minWidth: 0, overflow: 'hidden' }} title={task || undefined}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task || '—'}</div>
                        </td>
                        <td style={{ padding: '6px 8px', minWidth: 0, overflow: 'hidden' }} title={model}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.model ?? '—'}</span>
                            {r.effort && <span style={{ flexShrink: 0, fontSize: 10.5, opacity: 0.55 }}>@{r.effort}</span>}
                          </div>
                        </td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{r.tier ?? '—'}</td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{secs}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'workers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
            <div style={{ ...S.section, margin: 0 }}>{copy.jobs}</div>
            {runningJobs > 0 && <span style={S.chip(true)}>{copy.runningCount(runningJobs)}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, opacity: 0.5 }}>{copy.liveHint}</span>
          </div>
      {!jobsLoaded ? (
        <div style={{ opacity: 0.55 }}>{copy.loading}</div>
      ) : groups.length === 0 ? (
        <div style={S.emptyBox}>
          <div style={S.emptyTitle}>{copy.empty}</div>
          <div style={S.emptyHint}>{copy.emptyHint}</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid rgba(128,128,128,0.16)', borderRadius: 10, padding: '0 10px' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', minWidth: 800 }}>
            <colgroup>
              <col style={{ width: 64 }} /><col style={{ width: 58 }} /><col style={{ width: 72 }} />
              <col style={{ width: 84 }} /><col style={{ width: 100 }} /><col style={{ width: 84 }} />
              <col style={{ width: 338 }} />
            </colgroup>
            <thead><tr>
              {[copy.col.id, copy.col.source, copy.col.tier, copy.col.status, copy.col.progress, copy.col.tokens, copy.col.task].map((h) => (
                <th key={h} style={{ ...S.tight, fontSize: 11, opacity: 0.55, fontWeight: 500 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {groups.map((group) => (
                <WorkspaceGroup key={workspaceKey(group.cwd)} group={group} locks={locks} copy={copy} renderRow={renderJobRow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
        </div>
      )}
      {hoverTask && createPortal(
        <div style={{
          position: 'fixed', right: hoverTask.right, zIndex: 9999,
          ...(hoverTask.flip ? { top: hoverTask.top } : { bottom: hoverTask.bottom }),
          minWidth: 260, maxWidth: 420, maxHeight: 180, overflowY: 'auto',
          padding: '8px 12px', borderRadius: 8,
          border: '1px solid rgba(128,128,128,0.35)',
          background: 'Canvas', color: 'CanvasText',
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
          whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5,
        }}>{hoverTask.text}</div>,
        document.body,
      )}
    </div>
  );
}

/**
 * One workspace group on the jobs board (WPC13): a header row — directory
 * basename (bold), abbreviated full path, job count and an optional lock
 * badge (🔒 backend · 7m42s) whose tooltip carries the old held-workspaces
 * explanation — followed by that workspace's rows, with settled jobs tucked
 * behind a per-group "Finished (n)" fold. Group and fold collapse states are
 * remembered per workspace in localStorage.
 */
function WorkspaceGroup({ group, locks, copy, renderRow }: {
  group: { cwd: string | null; jobs: any[] };
  locks: Array<{ cwd: string; holder: any }>;
  copy: any;
  renderRow: (job: any) => any;
}) {
  const wsKey = workspaceKey(group.cwd);
  const [collapsed, toggle] = useWorkspaceCollapse(wsKey);
  // Settled rows start folded away; the choice is remembered per workspace.
  const [finishedCollapsed, toggleFinished] = useCollapseSection(`finished-jobs.${wsKey}`, true);
  const active = group.jobs.filter((j) => j.status === 'running' || j.status === 'orphaned' || j.status === 'needs_input');
  const finished = group.jobs.filter((j) => j.status !== 'running' && j.status !== 'orphaned' && j.status !== 'needs_input');
  const badge = lockBadgeOf(locks, group.cwd, copy);
  return (<>
    <tr>
      <td colSpan={7} role="button" tabIndex={0} aria-expanded={!collapsed}
        title={collapsed ? copy.expand : copy.collapse}
        onClick={toggle}
        onKeyDown={(e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
        style={{ ...S.tight, cursor: 'pointer', userSelect: 'none' as const, padding: '7px 10px 7px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span aria-hidden="true" style={{ fontSize: 11, width: 12, flexShrink: 0, textAlign: 'center' as const, opacity: 0.85 }}>{collapsed ? '▸' : '▾'}</span>
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{group.cwd === null ? copy.noCwdGroup : basenameOf(group.cwd)}</span>
          {group.cwd !== null && (
            <span title={group.cwd} style={{ ...S.mono, fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>{abbrevPath(group.cwd)}</span>
          )}
          <span style={{ fontSize: 11, opacity: 0.65 }}>（{group.jobs.length}）</span>
          {group.jobs.some((j) => j.status === 'needs_input') && <span style={{ color: '#d29922', fontSize: 11 }}>{copy.statusNeedsInput}</span>}
          <span style={{ flex: 1 }} />
          {badge && (
            <span title={badge.title}
              onClick={(e: any) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, padding: '1px 8px', borderRadius: 99, border: '1px solid rgba(210,153,34,0.5)', color: '#d29922', whiteSpace: 'nowrap', cursor: 'default' }}>
              {badge.text}
            </span>
          )}
        </div>
      </td>
    </tr>
    {!collapsed && (<>
      {active.map(renderRow)}
      {finished.length > 0 && (
        <tr>
          <td colSpan={7} role="button" tabIndex={0} aria-expanded={!finishedCollapsed}
            title={finishedCollapsed ? copy.expand : copy.collapse}
            onClick={toggleFinished}
            onKeyDown={(e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFinished(); } }}
            style={{ ...S.tight, fontSize: 11.5, opacity: 0.75, cursor: 'pointer', padding: '7px 10px 7px 0', userSelect: 'none' as const }}>
            <span aria-hidden="true" style={{ fontSize: 11, width: 12, display: 'inline-block', textAlign: 'center' as const }}>{finishedCollapsed ? '▸' : '▾'}</span>
            {copy.finishedJobs}（{finished.length}）
          </td>
        </tr>
      )}
      {finished.length > 0 && !finishedCollapsed && finished.map(renderRow)}
    </>)}
  </>);
}

export function apply(ctx: any): void {
  let runningCount = 0;
  ctx.slots.inject('settings.section', () => {
    let dispose = register();
    function register() {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-adapter',
          order: 65,
          label: () => {
            const base = COPY[ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en'].label;
            if (runningCount <= 0) return base;
            // String-only slot labels: filled circled digits are the closest
            // thing to a badge the contract allows.
            const CIRCLED = ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿'];
            return `${base} ${CIRCLED[runningCount - 1] ?? `(${runningCount})`}`;
          },
        },
        () => <WorkersPanel ctx={ctx} />,
      );
    }
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await (await fetch(`${API}/jobs`, { cache: 'no-store' })).json();
        // WPC10: jobs whose writer process is already gone are orphans, not
        // live work — do not let them inflate the badge.
        const n = r.ok ? (r.jobs ?? []).filter((j: any) => j.status === 'running' && j.originWriterAlive !== false).length : 0;
        if (n !== runningCount) {
          runningCount = n;
          dispose(); dispose = register(); // slots/changed → nav re-renders the label
        }
      } catch { /* hub restarting */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 10_000);
    return () => { clearInterval(timer); dispose(); };
  });
}
