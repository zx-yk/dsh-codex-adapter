// Pure text transforms used by scripts/sync-model-caps.mjs.
//
// Kept out of the CLI so a rewrite can be tested without a profile file, a
// network call, or a provider catalog. Nothing here mutates its inputs: a
// caller always receives the whole rewritten document back, so it must feed
// the newest text into the next rewrite instead of hanging on to an older
// `split('\n')` snapshot. `applyProviderCaps` owns that loop.

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Line indexes of one provider's `models:` list inside the profile patch.
 * The source lines are passed in because a rewrite changes the line count:
 * indexes captured from older text would point at the wrong model (or past
 * the end) for every later provider.
 */
export function findModelsBlock(provider, sourceLines) {
  const head = new RegExp(`^(\\s{2,})${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`);
  for (let i = 0; i < sourceLines.length; i += 1) {
    const m = head.exec(sourceLines[i]);
    if (!m) continue;
    const providerIndent = m[1].length;
    let modelsLine = -1;
    let modelsIndent = -1;
    for (let j = i + 1; j < sourceLines.length; j += 1) {
      const line = sourceLines[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= providerIndent) break;
      const mm = /^(\s*)models\s*:\s*$/.exec(line);
      if (mm) { modelsLine = j; modelsIndent = mm[1].length; break; }
    }
    if (modelsLine === -1) continue;
    const items = [];
    const itemRe = /^(\s*)-\s+id\s*:\s*['"]?([^'"\s]+)['"]?\s*$/;
    for (let j = modelsLine + 1; j < sourceLines.length; j += 1) {
      const line = sourceLines[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= modelsIndent) break;
      const mm = itemRe.exec(line);
      if (!mm || mm[1].length !== modelsIndent + 2) continue;
      let end = sourceLines.length;
      for (let k = j + 1; k < sourceLines.length; k += 1) {
        const l = sourceLines[k];
        if (l.trim() === '') continue;
        if (l.length - l.trimStart().length <= mm[1].length) { end = k; break; }
      }
      items.push({ id: mm[2], start: j, end });
    }
    return { items };
  }
  return undefined;
}

/** Provider ids declared under every `providers:` map in the patch. */
export function listProviderIds(source) {
  const out = [];
  const lines = source.split('\n');
  const providerHead = /^\s{2,}([A-Za-z0-9_-]+)\s*:\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s{2,}providers\s*:\s*$/.test(lines[i])) continue;
    const base = lines[i].length - lines[i].trimStart().length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= base) break;
      const m = providerHead.exec(line);
      if (m && ind === base + 2) out.push(m[1]);
    }
  }
  return out;
}

/** The `reasoningEfforts` block wanted for one upstream capability entry. */
export function desiredBlock(caps) {
  if (caps.efforts === undefined) return undefined;
  if (caps.efforts.length === 0) return ['reasoningEfforts: false'];
  const offered = caps.efforts.filter((level) => LEVELS.includes(level));
  if (offered.length === 0) return undefined;
  const ordered = LEVELS.filter((level) => level === 'off' || offered.includes(level));
  if (!ordered.includes('off')) ordered.unshift('off');
  return ['reasoningEfforts:', ...ordered.map((level) => (level === 'off' ? '  off: null' : `  ${level}: ${level}`))];
}

/**
 * Replace or insert the reasoningEfforts property inside one list item.
 * The input array is copied, not spliced in place: the caller gets the whole
 * rewritten document and must not keep using its previous line snapshot.
 */
export function rewriteItem(lines, item, wanted) {
  const all = [...lines];
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

/**
 * Rewrite every catalog-described model inside one provider.
 *
 * Items are handled last-to-first so replacing a block cannot shift the line
 * indexes of the items still to come. Each iteration re-splits the CURRENT
 * text: `rewriteItem` returns the whole document, so reusing the snapshot from
 * the start of the provider would discard the changes already made to items
 * later in the file.
 *
 * @returns {{text: string, found: boolean, changes: Array<{model: string, from: string, to: string}>}}
 */
export function applyProviderCaps(output, provider, models = {}) {
  const block = findModelsBlock(provider, output.split('\n'));
  if (!block) return { text: output, found: false, changes: [] };
  const catalog = models ?? {};
  const changes = [];
  let text = output;
  for (const item of [...block.items].reverse()) {
    const caps = catalog[item.id];
    const wanted = caps ? desiredBlock(caps) : undefined;
    if (!wanted) continue;
    const result = rewriteItem(text.split('\n'), item, wanted);
    if (!result) continue;
    changes.push({ model: item.id, from: result.from, to: wanted.join(' / ') });
    text = result.text;
  }
  return { text, found: true, changes };
}
