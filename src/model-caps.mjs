// Upstream model-capability lookup.
//
// DSH's own metadata (ctx.llm.resolveModelInfo) is a local declaration: the
// pi-ai adapter builds it from the profile's `reasoningEfforts`, so it can go
// stale the moment a gateway changes what a model actually accepts. This module
// asks the provider itself for its catalog, in whatever shape it returns, and
// caches the answer next to the plugin's config so the local dictionary learns
// what the upstream really offers.
//
// Supported payload shapes (best effort):
//   { data: [ { id, ... } ] }              OpenAI / vLLM / LM Studio / OpenRouter
//   { models: [ ... ] }                    Ollama, llama.cpp server
//   [ { id | model | name, ... } ]         bare arrays
// Capability fields read from an entry:
//   reasoning_efforts / reasoningEfforts / supported_reasoning_efforts /
//   thinking_levels / effort_levels / capabilities.* / parameters
//   supported_parameters: ["reasoning", ...]   -> knows reasoning exists, not the levels
// Anything unrecognised is reported as unknown rather than guessed.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'dsh-adapter');
const CACHE_FILE = join(CONFIG_DIR, 'model-caps.json');
const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml');

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readCapsCache() {
  const data = readJson(CACHE_FILE, { providers: {} });
  if (!data || typeof data !== 'object') return { providers: {} };
  if (!data.providers || typeof data.providers !== 'object') data.providers = {};
  return data;
}

export function writeCapsCache(provider, entry) {
  const data = readCapsCache();
  data.providers[provider] = entry;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2) + '\n');
  } catch { /* read-only home: keep the in-memory copy */ }
  return data;
}

export function capsFor(cache, provider, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const entry = cache?.providers?.[provider];
  if (!entry || typeof entry.fetchedAt !== 'string') return undefined;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age) || age > ttlSeconds * 1000) return undefined;
  return entry;
}

/**
 * Find a provider's endpoint and key reference. Explicit config wins; otherwise
 * the DSH profile patch is scanned, because that is where `llm-pi-ai` keeps
 * `baseURL` / `apiKeyEnv` for each route.
 */
export function resolveProviderEndpoint(providerId, explicit = {}) {
  if (explicit && (explicit.base_url || explicit.baseURL)) {
    return {
      baseUrl: String(explicit.base_url ?? explicit.baseURL).replace(/\/+$/, ''),
      apiKeyEnv: explicit.api_key_env ?? explicit.apiKeyEnv,
      headers: explicit.headers ?? {},
      source: 'config',
    };
  }
  const root = join(homedir(), '.dsh', 'profiles');
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return undefined; }
  for (const name of dirs) {
    const file = join(root, name, 'cordis.patch.yml');
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const block = providerBlock(text, providerId);
    if (!block) continue;
    const baseUrl = matchValue(block, 'baseURL') ?? matchValue(block, 'base_url');
    if (!baseUrl) continue;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKeyEnv: matchValue(block, 'apiKeyEnv') ?? matchValue(block, 'api_key_env'),
      headers: {},
      source: 'profile:' + name,
    };
  }
  return undefined;
}

function providerBlock(text, providerId) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^(\\s{2,})${providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const out = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { out.push(''); continue; }
      const ind = line.length - line.trimStart().length;
      if (ind <= indent) break;
      out.push(line);
    }
    return out.join('\n');
  }
  return '';
}

function matchValue(block, key) {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*['"]?([^'"\\n#]+)`, 'm').exec(block);
  return m ? m[1].trim() : undefined;
}

/** The credentials file keeps `refs:` as plain name -> secret pairs. */
export function readCredentialRef(name) {
  try {
    const text = readFileSync(CREDENTIALS_FILE, 'utf8');
    const start = text.indexOf('\nrefs:');
    const slice = start === -1 ? text : text.slice(start);
    const m = new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(\\S+)\\s*$`, 'm').exec(slice);
    return m ? m[1] : undefined;
  } catch { return undefined; }
}

function normalizeEffort(raw) {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (!v) return undefined;
    if (v === 'none' || v === 'disabled') return 'off';
    if (v === 'minimal') return 'low';
    return v;
  }
  if (raw && typeof raw === 'object') {
    const id = raw.id ?? raw.level ?? raw.name ?? raw.effort;
    return normalizeEffort(id);
  }
  return undefined;
}

function effortList(value) {
  if (Array.isArray(value)) return value.map(normalizeEffort).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\s|]+/).map(normalizeEffort).filter(Boolean);
  if (value && typeof value === 'object') {
    // { off: ..., high: ... } maps a declared level to its wire value.
    return Object.keys(value).map(normalizeEffort).filter(Boolean);
  }
  return [];
}

const EFFORT_FIELDS = [
  'reasoning_efforts', 'reasoningEfforts', 'supported_reasoning_efforts', 'supportedReasoningEfforts',
  'thinking_levels', 'thinkingLevels', 'effort_levels', 'effortLevels', 'reasoning_levels',
];

function extractEfforts(entry) {
  for (const field of EFFORT_FIELDS) {
    if (entry[field] !== undefined) {
      const list = effortList(entry[field]);
      if (list.length) return { efforts: list };
    }
  }
  for (const container of ['capabilities', 'capability', 'features']) {
    const value = entry[container];
    if (!value || typeof value !== 'object') continue;
    for (const field of EFFORT_FIELDS) {
      if (value[field] !== undefined) {
        const list = effortList(value[field]);
        if (list.length) return { efforts: list };
      }
    }
    if (value.reasoning === false) return { efforts: [] };
  }
  if (entry.reasoning === false) return { efforts: [] };
  const params = entry.supported_parameters ?? entry.supportedParameters;
  if (Array.isArray(params)) {
    const names = params.map((p) => String(p).toLowerCase());
    if (names.some((n) => n.includes('reasoning'))) return { efforts: undefined };
  }
  return undefined;
}

function entriesOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'models', 'result', 'items']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/** Parse one /models payload into { models: { id: { efforts } }, unknown } */
export function parseCapsPayload(payload) {
  const models = {};
  for (const entry of entriesOf(payload)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id ?? entry.model ?? entry.name;
    if (typeof id !== 'string' || id === '') continue;
    const found = extractEfforts(entry);
    if (!found) continue;
    models[id] = found.efforts === undefined ? { unknown: true } : { efforts: found.efforts };
  }
  return models;
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    return { json: await res.json() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) };
  } finally { clearTimeout(timer); }
}

/**
 * Fetch a provider's catalog. Tries `{base}/v1/models` and `{base}/models`
 * because gateways disagree about whether `baseURL` already ends in /v1.
 */
export async function fetchUpstreamCaps(providerId, endpoint, { timeoutMs = 8000, ttlSeconds } = {}) {
  if (!endpoint?.baseUrl) return { provider: providerId, error: 'no base_url', tried: [] };
  const headers = { accept: 'application/json', ...(endpoint.headers ?? {}) };
  if (endpoint.apiKeyEnv) {
    const key = process.env[endpoint.apiKeyEnv] ?? readCredentialRef(endpoint.apiKeyEnv);
    if (key) headers.authorization = 'Bearer ' + key;
  }
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const urls = [];
  if (/\/v1$/.test(base)) urls.push(base + '/models');
  else urls.push(base + '/v1/models', base + '/models');
  const tried = [];
  let lastError = 'unreachable';
  for (const url of urls) {
    const result = await getJson(url, headers, timeoutMs);
    tried.push(url);
    if (result.json === undefined) { lastError = result.error ?? lastError; continue; }
    const models = parseCapsPayload(result.json);
    if (Object.keys(models).length === 0) {
      return { provider: providerId, baseUrl: base, fetchedAt: new Date().toISOString(), ttlSeconds, models, tried, note: 'catalog has no capability fields' };
    }
    return { provider: providerId, baseUrl: base, fetchedAt: new Date().toISOString(), ttlSeconds, models, tried };
  }
  return { provider: providerId, baseUrl: base, fetchedAt: new Date().toISOString(), ttlSeconds, models: {}, error: lastError, tried };
}
