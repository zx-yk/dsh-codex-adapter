#!/usr/bin/env node
// Local release: build, verify, optionally publish and tag — no GitHub Actions.
//
// Why: a fork pays for every workflow run it starts, and the upstream tag
// pipeline cannot publish from a fork anyway (OIDC trust is bound to
// ZSeven-W/dsh-crew). Doing the same gates on the machine costs nothing and
// takes about two minutes.
//
//   node scripts/release-local.mjs              # build + smoke only
//   node scripts/release-local.mjs --publish    # …then npm publish
//   node scripts/release-local.mjs --tag        # …then git tag/push v<version>
//   node scripts/release-local.mjs --force      # skip the clean-tree check
//
// The script never bumps the version: run `npm version <patch|minor|...>`
// first so the tag, package.json and published artifact agree.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const doPublish = flags.has('--publish');
const doTag = flags.has('--tag');
const force = flags.has('--force');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

function run(cmd, argv, extra = {}) {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`);
  execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', ...extra });
}

function capture(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// pnpm keeps the lockfile authoritative, but a machine without pnpm can use
// npm for the same scripts; force one with CREW_PM=pnpm|npm.
const pm = process.env.CREW_PM || (capture('pnpm', ['--version']) ? 'pnpm' : 'npm');
console.log(`package manager: ${pm} | ${pkg.name}@${version}`);

if (!force) {
  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty) {
    console.error('\nWorking tree is not clean. Commit first, or pass --force:\n' + dirty);
    process.exit(1);
  }
}

if (!existsSync(join(ROOT, 'node_modules'))) {
  run(pm, ['install']);
}

run(pm, ['run', 'build']);
run(pm, ['run', 'smoke:mcp']);
run(pm, ['run', 'smoke:pack']);

if (doPublish) {
  if (!pkg.name.startsWith('@')) {
    console.warn('\nNote: unscoped package names are first-come on npm.');
  }
  console.log(`\nPublishing ${pkg.name}@${version} (requires npm login).`);
  run('npm', ['publish', '--access', 'public', '--tag', 'latest']);
}

if (doTag) {
  const tag = `v${version}`;
  const existing = capture('git', ['tag', '--list', tag]);
  if (existing) {
    console.log(`\nTag ${tag} already exists locally — skipping creation.`);
  } else {
    run('git', ['tag', '-a', tag, '-m', tag]);
  }
  run('git', ['push', 'origin', tag]);
  console.log(`\nPushed ${tag}. No workflow listens to tags, so this costs no Actions minutes.`);
}

console.log(`\nOK — ${pkg.name}@${version} built and verified.`);
if (!doPublish) console.log('Package not published (pass --publish to publish).');
if (!doTag) console.log('Tag not pushed (pass --tag to tag and push).');
