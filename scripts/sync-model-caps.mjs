// Sync a DSH profile's declared model capabilities with what the provider's
// own catalog says.
//
// DSH validates a dispatch against the LOCAL declaration (`reasoningEfforts` in
// the llm-pi-ai profile), while the gateway decides what a model really
// accepts. When those drift, a worker fails with "does not support reasoning
// effort" even though the model is healthy. This script rewrites the profile's
// `reasoningEfforts` blocks from the upstream catalog, leaving everything else
// byte-identical.
//
//   node scripts/sync-model-caps.mjs                       # dry run, desktop profile
//   node scripts/sync-model-caps.mjs --write               # apply (creates .bak)
//   node scripts/sync-model-caps.mjs --provider codeman --profile desktop
//
// Models the upstream catalog does not describe (or describes without any
// capability field) are left untouched.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchUpstreamCaps, readCapsCache, resolveProviderEndpoint } from '../src/model-caps.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const profile = value('--profile', 'desktop');
const explicitProvider = value('--provider', undefined);
const write = flag('--write');
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const patchPath = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
if (!existsSync(patchPath)) {
  console.error(`no such profile patch: ${patchPath}`);
  process.exit(1);
}

let text = readFileSync(patchPath, 'utf8');
const lines = text.split('\n');

/** Line indexes of one provider's `models:` list inside the profile patch. */
function findModelsBlock(provider) {
  const head = new RegExp(`^(\\s{2,})${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const providerIndent = m[1].length;
    let modelsLine = -1;
    let modelsIndent = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= providerIndent) break;
      const mm = /^(\s*)models\s*:\s*$/.exec(line);
      if (mm) { modelsLine = j; modelsIndent = mm[1].length; break; }
    }
    if (modelsLine === -1) continue;
    const items = [];
    const itemRe = /^(\s*)-\s+id\s*:\s*['"]?([^'"\s]+)['"]?\s*$/;
    for (let j = modelsLine + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= modelsIndent) break;
      const mm = itemRe.exec(line);
      if (!mm || mm[1].length !== modelsIndent + 2) continue;
      let end = lines.length;
      for (let k = j + 1; k < lines.length; k += 1) {
        const l = lines[k];
        if (l.trim() === '') continue;
        if (l.length - l.trimStart().length <= mm[1].length) { end = k; break; }
      }
      items.push({ id: mm[2], start: j, end });
    }
    return { items };
  }
  return undefined;
}

function desiredBlock(caps) {
  if (caps.efforts === undefined) return undefined;
  if (caps.efforts.length === 0) return ['reasoningEfforts: false'];
  const offered = caps.efforts.filter((level) => LEVELS.includes(level));
  if (offered.length === 0) return undefined;
  const ordered = LEVELS.filter((level) => level === 'off' || offered.includes(level));
  if (!ordered.includes('off')) ordered.unshift('off');
  return ['reasoningEfforts:', ...ordered.map((level) => (level === 'off' ? '  off: null' : `  ${level}: ${level}`))];
}

const providers = explicitProvider ? [explicitProvider] : listProviderIds(text);
if (providers.length === 0) {
  console.error('no providers found in the profile patch');
  process.exit(1);
}

const cache = readCapsCache();
const changes = [];
let output = text;

for (const provider of providers) {
  const endpoint = resolveProviderEndpoint(provider, {});
  if (!endpoint) { console.log(`- ${provider}: no endpoint (skipped)`); continue; }
  const entry = await fetchUpstreamCaps(provider, endpoint, {});
  if (entry.error) { console.log(`- ${provider}: ${entry.error} (skipped)`); continue; }
  cache.providers[provider] = entry;
  const block = findModelsBlock(provider);
  if (!block) { console.log(`- ${provider}: no models: list (skipped)`); continue; }
  // Reverse order: an edit inside a later item cannot shift an earlier item's
  // line indexes, so the captured starts stay valid.
  for (const item of [...block.items].reverse()) {
    const caps = entry.models?.[item.id];
    const wanted = caps ? desiredBlock(caps) : undefined;
    if (!wanted) continue;
    const result = rewriteItem(output.split('\n'), item, wanted);
    if (result) {
      changes.push({ provider, model: item.id, from: result.from, to: wanted.join(' / ') });
      output = result.text;
    }
  }
}

changes.sort((a, b) => a.model.localeCompare(b.model));
for (const change of changes) {
  console.log(`~ ${change.provider}/${change.model}`);
  console.log(`    was: ${change.from || '(none)'}`);
  console.log(`    now: ${change.to}`);
}
console.log(`\n${changes.length} model(s) ${write ? 'updated' : 'would change'} in ${patchPath}`);

if (write && changes.length > 0) {
  copyFileSync(patchPath, patchPath + '.bak-' + Date.now());
  writeFileSync(patchPath, output);
  console.log('written (backup kept next to the profile patch)');
}

function listProviderIds(source) {
  const out = [];
  const lines2 = source.split('\n');
  const providerHead = /^\s{2,}([A-Za-z0-9_-]+)\s*:\s*$/;
  for (let i = 0; i < lines2.length; i += 1) {
    if (!/^\s{2,}providers\s*:\s*$/.test(lines2[i])) continue;
    const base = lines2[i].length - lines2[i].trimStart().length;
    for (let j = i + 1; j < lines2.length; j += 1) {
      const line = lines2[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= base) break;
      const m = providerHead.exec(line);
      if (m && ind === base + 2) out.push(m[1]);
    }
  }
  return out;
}

/** Replace or insert the reasoningEfforts property inside one list item. */
function rewriteItem(all, item, wanted) {
  const indent = all[item.start].length - all[item.start].trimStart().length;
  const propIndent = ' '.repeat(indent + 2);
  const childIndent = ' '.repeat(indent + 4);
  let start = -1;
  let end = -1;
  for (let i = item.start + 1; i < item.end; i += 1) {
    if (/^\s*reasoningEfforts\s*:/.test(all[i])) {
      start = i;
      end = i + 1;
      while (end < item.end && (all[end].trim() === '' || all[end].length - all[end].trimStart().length > indent + 2)) end += 1;
      break;
    }
  }
  const block = wanted.map((line, index) => (index === 0 ? propIndent + line : childIndent + line.slice(2)));
  if (start === -1) {
    // Append at the end of the item.
    let insertAt = item.end;
    while (insertAt > item.start + 1 && all[insertAt - 1].trim() === '') insertAt -= 1;
    all.splice(insertAt, 0, ...block);
    return { text: all.join('\n'), from: '' };
  }
  const from = all.slice(start, end).map((l) => l.trim()).join(' / ');
  all.splice(start, end - start, ...block);
  return { text: all.join('\n'), from };
}
