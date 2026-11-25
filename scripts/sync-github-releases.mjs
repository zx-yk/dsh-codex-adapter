#!/usr/bin/env node
// Create GitHub Releases for tags that only exist as git tags.
//
//   GH_TOKEN=github_pat_... node scripts/sync-github-releases.mjs
//
// The repository's normal git push updates refs/tags, not the Releases page;
// this script backfills every tag newer than the last GitHub Release. It uses
// the REST API and needs a token with repo contents:write.
import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || 'zx-yk/dsh-codex-adapter';
if (!TOKEN) {
  console.error('Set GH_TOKEN (or GITHUB_TOKEN) with repo contents:write');
  process.exit(1);
}
const api = (path, init = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
  ...init,
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${TOKEN}`,
    'x-github-api-version': '2022-11-28',
    ...(init.headers ?? {}),
  },
});

const tags = execFileSync('git', ['tag', '--list', 'v0.1.*', '--sort=version:refname'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const notesFor = (tag, prev) => {
  const range = prev ? `${prev}..${tag}` : tag;
  const lines = execFileSync('git', ['log', '--pretty=format:%h%x09%s', range], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter((line) => !/^\w+\trelease: v/.test(line) && !/^\w+\tMerge /.test(line));
  return ['## Changes', ...(lines.length ? lines.map((line) => '- ' + line.replace('\t', ' — ')) : ['- Version marker only.']), '', `**Full Changelog**: https://github.com/${REPO}/compare/${prev ?? tag}...${tag}`].join('\n');
};
const existing = new Set();
for (let page = 1; ; page++) {
  const res = await api(`/releases?per_page=100&page=${page}`);
  if (!res.ok) throw new Error(`list releases: HTTP ${res.status}`);
  const batch = await res.json();
  for (const rel of batch) existing.add(rel.tag_name);
  if (batch.length < 100) break;
}
let created = 0;
for (let i = 0; i < tags.length; i++) {
  const tag = tags[i];
  if (existing.has(tag)) continue;
  const prev = tags[i - 1];
  const res = await api('/releases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body: notesFor(tag, prev), draft: false, prerelease: false }),
  });
  if (!res.ok) throw new Error(`create ${tag}: HTTP ${res.status} ${await res.text()}`);
  created += 1;
  console.log(`created ${tag}`);
}
// Creating older tags after newer ones makes GitHub mark the last-created
// (lowest) release as "Latest". Explicitly restore the highest tag.
const newest = tags[0];
if (newest) {
  const all = await (await api('/releases?per_page=100')).json();
  const rel = Array.isArray(all) ? all.find((r) => r.tag_name === newest) : null;
  if (rel) {
    await api(`/releases/${rel.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ make_latest: 'true' }) });
    console.log(`latest release set to ${newest}`);
  }
}
console.log(`done: ${created} release(s) created, ${existing.size} already present`);
