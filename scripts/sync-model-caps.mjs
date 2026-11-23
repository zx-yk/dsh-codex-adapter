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
import { applyProviderCaps, listProviderIds } from '../src/model-caps-sync.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const profile = value('--profile', 'desktop');
const explicitProvider = value('--provider', undefined);
const write = flag('--write');

const patchPath = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
if (!existsSync(patchPath)) {
  console.error(`no such profile patch: ${patchPath}`);
  process.exit(1);
}

let text = readFileSync(patchPath, 'utf8');

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
  // The transform re-reads the CURRENT output on every item and for this
  // provider's own block: earlier rewrites (same or previous provider) change
  // the line count, so older indexes would point at the wrong model.
  const result = applyProviderCaps(output, provider, entry.models);
  if (!result.found) { console.log(`- ${provider}: no models: list (skipped)`); continue; }
  for (const change of result.changes) changes.push({ provider, ...change });
  output = result.text;
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
