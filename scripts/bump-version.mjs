#!/usr/bin/env node
// Bump the version in every place the release gates compare.
//
//   node scripts/bump-version.mjs 0.1.1
//   node scripts/bump-version.mjs minor      # 0.1.1 -> 0.2.0
//   node scripts/bump-version.mjs patch      # 0.1.1 -> 0.1.2
//
// smoke-pack asserts that package.json, .claude-plugin/plugin.json,
// src/server.mjs, the built lib/server.mjs and the README's Latest badge all
// report the same version, so a release that edits only package.json fails the
// gate. This script keeps them in sync and rebuilds the bundle; commit the
// result before publishing.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];

if (!arg) {
  console.error('usage: node scripts/bump-version.mjs <version|patch|minor|major>');
  process.exit(1);
}

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version;

function nextVersion(input) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current);
  if (!m) throw new Error('unparseable current version: ' + current);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(input)) return input;
  if (input === 'major') return `${major + 1}.0.0`;
  if (input === 'minor') return `${major}.${minor + 1}.0`;
  if (input === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('expected an exact version or patch|minor|major, got: ' + input);
}

const next = (() => {
  try {
    return nextVersion(arg);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
if (next === current) {
  console.error(`version is already ${current}`);
  process.exit(1);
}

const edits = [
  ['package.json', (s) => s.replace(`"version": "${current}"`, `"version": "${next}"`)],
  ['.claude-plugin/plugin.json', (s) => s.replace(`"version": "${current}"`, `"version": "${next}"`)],
  ['src/server.mjs', (s) => s.replace(`version: '${current}'`, `version: '${next}'`)],
  ['README.md', (s) => s.replace(`Latest: <code>${current}</code>`, `Latest: <code>${next}</code>`)],
];

for (const [file, edit] of edits) {
  const path = join(ROOT, file);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  if (after === before) {
    console.error(`could not find version ${current} in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`updated ${file}`);
}

// Rebuild makes lib/server.mjs carry the new version; the pnpm lockfile keeps
// the bundle byte-identical apart from that string. Run npm's CLI through node
// rather than the pnpm shim, which execFile cannot start on Windows.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });

console.log(`\n${current} -> ${next}`);
console.log('Next: run pnpm run smoke:pack, commit, then npm publish --access public');
