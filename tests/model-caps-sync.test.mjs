// Regression: scripts/sync-model-caps.mjs used to compute one
// `output.split('\n')` snapshot per provider and pass that same array to every
// item rewrite. `rewriteItem` returns the whole rewritten document, so when a
// provider declared several models the rewrite of an earlier model was built
// from the stale snapshot and silently dropped the rewrite already applied to
// a later model. The transform now lives in src/model-caps-sync.mjs and every
// iteration re-reads the current text while still walking items last-to-first.
//
// These tests are pure text transforms: no profile file, no network, no ACL.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProviderCaps,
  desiredBlock,
  findModelsBlock,
  listProviderIds,
  rewriteItem,
} from '../src/model-caps-sync.mjs';

/** Build a profile-patch-shaped document with two-space levels below config. */
function patchOf(providers) {
  const lines = ['cordis:', '  patch:', '    llm-pi-ai:', '      config:', '        providers:'];
  for (const provider of providers) {
    lines.push(`          ${provider.id}:`, '            models:');
    for (const model of provider.models) {
      lines.push(`              - id: ${model.id}`);
      if (model.name) lines.push(`                name: ${model.name}`);
      for (const effortLine of model.efforts ?? []) lines.push(`                ${effortLine}`);
    }
  }
  return lines.join('\n');
}

/** Model id -> that model's item text, so a change cannot be attributed wrongly. */
function modelSections(text) {
  const sections = new Map();
  for (const part of text.split(/\n\s*-\s+id:\s*/).slice(1)) {
    const newline = part.indexOf('\n');
    const id = (newline === -1 ? part : part.slice(0, newline)).trim();
    sections.set(id, newline === -1 ? '' : part.slice(newline + 1));
  }
  return sections;
}

const EFFORTS = (levels) => [
  'reasoningEfforts:',
  '  off: null',
  ...levels.map((level) => `  ${level}: ${level}`),
];

test('two models in one provider keep both rewritten blocks', () => {
  const text = patchOf([{
    id: 'p1',
    models: [
      { id: 'm-alpha', name: 'Alpha' },
      { id: 'm-beta', name: 'Beta' },
    ],
  }]);
  const result = applyProviderCaps(text, 'p1', {
    'm-alpha': { efforts: ['low'] },
    'm-beta': { efforts: ['high'] },
  });

  assert.equal(result.found, true);
  assert.equal(result.changes.length, 2);
  assert.equal((result.text.match(/reasoningEfforts:/g) ?? []).length, 2);

  const sections = modelSections(result.text);
  assert.match(sections.get('m-alpha'), /reasoningEfforts:\s*\n\s*off: null\s*\n\s*low: low/);
  assert.match(sections.get('m-beta'), /reasoningEfforts:\s*\n\s*off: null\s*\n\s*high: high/);
  // A stale-snapshot rewrite leaves only the last-processed (first) model changed.
  assert.doesNotMatch(sections.get('m-alpha'), /high: high/);
  assert.doesNotMatch(sections.get('m-beta'), /low: low/);
});

test('a provider with three models keeps every rewrite, including an existing block', () => {
  const text = patchOf([{
    id: 'p1',
    models: [
      { id: 'm-one', name: 'One', efforts: EFFORTS(['low']) },
      { id: 'm-two', name: 'Two' },
      { id: 'm-three', name: 'Three', efforts: ['reasoningEfforts: false'] },
    ],
  }]);
  const result = applyProviderCaps(text, 'p1', {
    'm-one': { efforts: ['medium'] },
    'm-two': { efforts: ['xhigh'] },
    'm-three': { efforts: [] },
  });

  assert.equal(result.changes.length, 3);
  const sections = modelSections(result.text);
  assert.match(sections.get('m-one'), /off: null\s*\n\s*medium: medium/);
  assert.match(sections.get('m-two'), /off: null\s*\n\s*xhigh: xhigh/);
  assert.match(sections.get('m-three'), /reasoningEfforts: false/);
  // The old values must be gone, not duplicated.
  assert.doesNotMatch(result.text, /low: low/);
  assert.equal((result.text.match(/reasoningEfforts:/g) ?? []).length, 3);
});

test('the second provider still resolves after the first changes the line count', () => {
  const text = patchOf([
    {
      id: 'p1',
      models: [
        { id: 'a1', name: 'A one' },
        { id: 'a2', name: 'A two' },
        { id: 'a3', name: 'A three' },
      ],
    },
    {
      id: 'p2',
      models: [
        { id: 'b1', name: 'B one' },
        { id: 'b2', name: 'B two' },
        { id: 'b3', name: 'B three' },
      ],
    },
  ]);

  const first = applyProviderCaps(text, 'p1', {
    a1: { efforts: ['low'] },
    a2: { efforts: ['medium'] },
    a3: { efforts: ['high'] },
  });
  assert.equal(first.text.split('\n').length, text.split('\n').length + 9);

  const second = applyProviderCaps(first.text, 'p2', {
    b1: { efforts: ['xhigh'] },
    b2: { efforts: ['low'] },
    b3: { efforts: ['medium'] },
  });

  const sections = modelSections(second.text);
  // Provider 1's three models survived provider 2's rewrite...
  assert.match(sections.get('a1'), /low: low/);
  assert.match(sections.get('a2'), /medium: medium/);
  assert.match(sections.get('a3'), /high: high/);
  // ...and provider 2's models were rewritten at their shifted positions.
  assert.match(sections.get('b1'), /xhigh: xhigh/);
  assert.match(sections.get('b2'), /low: low/);
  assert.match(sections.get('b3'), /medium: medium/);
  assert.equal((second.text.match(/reasoningEfforts:/g) ?? []).length, 6);

  // Indexes captured before provider 1's rewrite no longer describe provider 2:
  // every model sits nine inserted lines lower now.
  const staleItems = findModelsBlock('p2', text.split('\n')).items;
  const currentItems = findModelsBlock('p2', first.text.split('\n')).items;
  assert.deepEqual(staleItems.map((item) => item.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(currentItems.map((item) => item.id), ['b1', 'b2', 'b3']);
  assert.ok(currentItems.every((item, index) => item.start === staleItems[index].start + 9));
});

test('models missing from the catalog are left untouched', () => {
  const text = patchOf([
    { id: 'p1', models: [{ id: 'known' }, { id: 'unknown', efforts: EFFORTS(['low']) }] },
  ]);
  const result = applyProviderCaps(text, 'p1', { known: { efforts: ['medium'] } });

  assert.equal(result.found, true);
  assert.deepEqual(result.changes.map((change) => change.model), ['known']);
  const sections = modelSections(result.text);
  assert.match(sections.get('known'), /medium: medium/);
  assert.match(sections.get('unknown'), /reasoningEfforts:\s*\n\s*off: null\s*\n\s*low: low/);
});

test('a provider without a models list is reported, not rewritten', () => {
  const text = patchOf([{ id: 'p1', models: [{ id: 'm1' }] }]);
  const result = applyProviderCaps(text, 'absent', { m1: { efforts: ['low'] } });
  assert.equal(result.found, false);
  assert.equal(result.text, text);
  assert.deepEqual(result.changes, []);
});

test('rewriteItem does not mutate the line snapshot it is given', () => {
  const text = patchOf([{ id: 'p1', models: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }] }]);
  const lines = text.split('\n');
  const before = [...lines];
  const block = findModelsBlock('p1', lines);
  const [first, second] = block.items;

  rewriteItem(lines, second, desiredBlock({ efforts: ['high'] }));
  // The trap: if the snapshot itself were spliced, this second call would
  // silently build on it. The input must stay pristine.
  assert.deepEqual(lines, before);
  const earlier = rewriteItem(lines, first, desiredBlock({ efforts: ['low'] }));
  assert.match(earlier.text, /low: low/);
  assert.doesNotMatch(earlier.text, /high: high/);
});

test('applying the same catalog twice is a no-op', () => {
  const text = patchOf([{ id: 'p1', models: [{ id: 'm1' }, { id: 'm2' }] }]);
  const models = { m1: { efforts: ['low'] }, m2: { efforts: [] } };
  const once = applyProviderCaps(text, 'p1', models);
  const twice = applyProviderCaps(once.text, 'p1', models);
  assert.equal(twice.text, once.text);
  assert.equal((twice.text.match(/reasoningEfforts/g) ?? []).length, 2);
});

test('listProviderIds sees every provider under providers:', () => {
  const text = patchOf([
    { id: 'p1', models: [{ id: 'm1' }] },
    { id: 'p2', models: [{ id: 'm2' }] },
  ]);
  assert.deepEqual(listProviderIds(text), ['p1', 'p2']);
});
