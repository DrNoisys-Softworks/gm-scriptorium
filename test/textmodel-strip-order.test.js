'use strict';

/*
 * #193 part 1: `check`'s text model (renderChain in src/checks/leak/textmodel.js) and a real
 * 1.14.0 build keep exactly the same text when `%%` comments overlap other markers.
 *
 * At 1.14.0 the generator has no `%%` handling. The build strips `%%` in its read shim
 * (READ_TRANSFORMS_FOR_BUILD in src/generator/bootstrap.js, ADR 0044), before the generator reads a
 * note, and renderChain strips `%%` first for the same reason. So check == build today.
 *
 * EVERY TEST HERE PASSES TODAY AND PROVES NOTHING ALONE. The evidence is the mutations, recorded
 * in the change that added this file: moving the `%%` strip after stripHtmlComments in renderChain
 * (M1) and deleting it (M2) both turn this file red.
 *
 * P4b below also passes today and proves only the current generator's behaviour (a known leak, issue #202).
 *
 * TRIPWIRE: this file is expected to go red when the build's read shim is removed along with the
 * 1.16+ generator (#192), which strips `%%` after gm-only, spoiler and HTML comments. Do NOT
 * update the literals until the check-side order decision lands with that change.
 *
 * Visibility is judged over the whole site, not per path:
 *   build-visible(S) = some built .html file has htmltext.textOf(html) containing S
 *   check-visible(S) = some published page's bodyText or storyText contains S
 * ZQXKEEP-B (a PC story) is one-way: renderChain is a documented superset for PC pages, so only
 * build-visible implies check-visible is required there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { computePublishedSet } = require('../src/vault/publishset');
const { deriveRenderedText } = require('../src/checks/leak/textmodel');
const { textOf } = require('../src/build/htmltext');

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

// Copied from test/obsidian-comments.test.js (not exported there); tokens unchanged.
const EDITS = [
  ['Events/The Cut Page.md', /^(---\n[\s\S]*?\n---\n)/, () => '$1%%ZQXCMT-EVENT first line%% '],
  ['Sessions/Session 02 - The Wax Vaults.md', '*The Wardens traced', () => '*The Wardens %%ZQXCMT-RECAP inline%% traced'],
  ['Characters/NPCs/Orpiment.md', /^(---\n[\s\S]*?\n---\n)/, () => `$1\nOrpiment keeps ZQXKEEP-A. %%ZQXCMT-INLINE see [[Emlyn Crewe]]%%\n\n%%\nZQXCMT-MULTI one\nZQXCMT-MULTI two [[Kit Farrow]]\n%%\n\n\`\`\`\n%%ZQXKEEP-FENCE%%\n\`\`\`\n\nInline \`%%ZQXKEEP-CODE%%\` stays.\n\n`],
  ['Characters/PCs/Kit Farrow_Story.md', /\s*$/, () => '\n\nKit says ZQXKEEP-B. %%ZQXCMT-STORY private%%\n'],
];

// Each case: lines of the body, the 1.14.0 visible sentinels (check = build), the hidden ones.
const FENCE = '```';
const CASES = {
  A: { lines: ['ZQXA0 lead.', '', '<!-- ZQXA1 %% ZQXA2 -->', 'ZQXA3', '%% ZQXA4', 'ZQXA5'], visible: ['ZQXA0'], hidden: ['ZQXA1', 'ZQXA2', 'ZQXA3', 'ZQXA4', 'ZQXA5'] },
  B: { lines: ['ZQXB0 lead.', '', '%% ZQXB1 <!-- ZQXB2 %%', 'ZQXB3', '--> ZQXB4', 'ZQXB5'], visible: ['ZQXB0', 'ZQXB3', 'ZQXB4', 'ZQXB5'], hidden: ['ZQXB1', 'ZQXB2'] },
  C: { lines: ['ZQXC0 lead.', '', '<!-- gm-only -->', 'ZQXC1 %% ZQXC2', 'ZQXC3', '<!-- /gm-only -->', 'ZQXC4', 'ZQXC5 %% ZQXC6', 'ZQXC7'], visible: ['ZQXC0'], hidden: ['ZQXC1', 'ZQXC2', 'ZQXC3', 'ZQXC4', 'ZQXC5', 'ZQXC6', 'ZQXC7'] },
  D: { lines: ['ZQXD0 lead.', '', '%% <!-- gm-only --> ZQXD1 %%', 'ZQXD2', '<!-- /gm-only -->', 'ZQXD3'], visible: ['ZQXD0', 'ZQXD2', 'ZQXD3'], hidden: ['ZQXD1'] },
  E: { lines: ['ZQXE0 lead.', '', '%% <!-- spoiler --> ZQXE1 %%', 'ZQXE2', '<!-- /spoiler -->', 'ZQXE3'], visible: ['ZQXE0', 'ZQXE2', 'ZQXE3'], hidden: ['ZQXE1'] },
  F: { lines: ['ZQXF0 lead.', '', '> [!note]', '> ZQXF1 %% ZQXF2', '> ZQXF3', '%% ZQXF4', '', 'ZQXF5'], visible: ['ZQXF0', 'ZQXF4', 'ZQXF5'], hidden: ['ZQXF1', 'ZQXF2', 'ZQXF3'] },
  G: { lines: ['ZQXG0 lead. %% ZQXG1', '', '> [!note]', '> ZQXG2 %% ZQXG3', '> ZQXG4'], visible: ['ZQXG0', 'ZQXG3', 'ZQXG4'], hidden: ['ZQXG1', 'ZQXG2'] },
  H: { lines: ['ZQXH0 lead.', '', `${FENCE}dataview`, 'TABLE ZQXH1 %% ZQXH2 %%', FENCE, '', 'ZQXH3 %% ZQXH4 %% ZQXH5'], visible: ['ZQXH0', 'ZQXH3', 'ZQXH5'], hidden: ['ZQXH1', 'ZQXH2', 'ZQXH4'] },
  U: { lines: ['ZQXU0 lead.', '', '<!-- gm-only -->', 'ZQXU1 %% ZQXU2', '<!-- /gm-only -->', 'ZQXU3'], visible: ['ZQXU0'], hidden: ['ZQXU1', 'ZQXU2', 'ZQXU3'] },
  V: { lines: ['ZQXV0 lead.', '', '%% ZQXV1 <!-- ZQXV2 %% ZQXV3', 'ZQXV4'], visible: ['ZQXV0', 'ZQXV3', 'ZQXV4'], hidden: ['ZQXV1', 'ZQXV2'] },
  W: { lines: ['ZQXW0 lead.', '', 'ZQXW1 %% ZQXW2', 'ZQXW3'], visible: ['ZQXW0', 'ZQXW1'], hidden: ['ZQXW2', 'ZQXW3'] },
};

// Sentinels from the copied EDITS. ZQXKEEP-B is one-way (see header).
const EDIT_VISIBLE = ['ZQXKEEP-A', 'ZQXKEEP-FENCE', 'ZQXKEEP-CODE', 'ZQXKEEP-C', 'ZQXKEEP-B'];
const EDIT_HIDDEN = ['ZQXCMT-EVENT', 'ZQXCMT-RECAP', 'ZQXCMT-INLINE', 'ZQXCMT-MULTI', 'ZQXCMT-STORY', 'ZQXCMT-UNTERM', 'ZQXCMT-AFTER'];
const ONE_WAY = new Set(['ZQXKEEP-B', 'ZQXCMT-STORY']);

const LITERALS = {};
for (const c of Object.values(CASES)) {
  for (const s of c.visible) LITERALS[s] = true;
  for (const s of c.hidden) LITERALS[s] = false;
}
for (const s of EDIT_VISIBLE) LITERALS[s] = true;
for (const s of EDIT_HIDDEN) LITERALS[s] = false;
const SENTINELS = Object.keys(LITERALS);

function allOutput(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p)]);
    }
  })(dir);
  return out;
}

function buildScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-strip-order-'));
  const vault = path.join(root, 'v');
  fs.cpSync(LEASE, vault, { recursive: true });

  for (const [rel, find, make] of EDITS) {
    const file = path.join(vault, rel);
    const src = fs.readFileSync(file, 'utf8');
    const replacement = make();
    const next = typeof find === 'string' ? src.replace(find, () => replacement.replace('$1', '')) : src.replace(find, replacement);
    assert.notEqual(next, src, `edit did not apply to ${rel}`);
    fs.writeFileSync(file, next);
  }
  const npcs = path.join(vault, 'Characters', 'NPCs');
  const fm = fs.readFileSync(path.join(npcs, 'Oswy Hebden.md'), 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0].replace(/title: .*/, 'title: Zed Tail');
  fs.writeFileSync(path.join(npcs, 'Zed Tail.md'), `${fm}\nZed says ZQXKEEP-C.\n\n%% ZQXCMT-UNTERM never closed\n\nZQXCMT-AFTER text lost\n`);

  const ticks = ['Characters/NPCs/Zed Tail.md'];
  for (const [letter, c] of Object.entries(CASES)) {
    const head = ['---', 'type: npc', `title: Zqx Case ${letter}`, 'campaign: "The Long Lease"', 'source: play', 'source_confidence: AUTHORITATIVE', '---'].join('\n');
    fs.writeFileSync(path.join(npcs, `Zqx Case ${letter}.md`), `${head}\n\n${c.lines.join('\n')}\n`);
    ticks.push(`Characters/NPCs/Zqx Case ${letter}.md`);
  }
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  const manSrc = fs.readFileSync(man, 'utf8');
  const manNext = manSrc.replace('## Publishing\n', `## Publishing\n\n${ticks.map((t) => `- [x] ${t}`).join('\n')}\n`);
  assert.notEqual(manNext, manSrc, 'manifest tick did not apply');
  fs.writeFileSync(man, manNext);

  const cfgFile = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
  const cfgSrc = fs.readFileSync(cfgFile, 'utf8');
  const cfgNext = cfgSrc.replace('"excludeCallouts": false', '"excludeCallouts": true');
  assert.notEqual(cfgNext, cfgSrc, 'excludeCallouts edit did not apply');
  fs.writeFileSync(cfgFile, cfgNext);

  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
  const add = run(['config', 'add', 'v', '--vault', vault, '--out', path.join(root, 'out-v')]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  const build = run(['build', 'v', '--no-check']);

  const jsonConfig = { ...JSON.parse(cfgNext), vaultPath: vault };
  const set = computePublishedSet(vault, jsonConfig);
  const rendered = set.publishedPages.map((page) => ({ page, text: deriveRenderedText(page, set.publishConfig) }));
  const checkTexts = rendered.flatMap((r) => [r.text.bodyText, r.text.storyText]).filter(Boolean);

  const outDir = path.join(root, 'out-v');
  const files = fs.existsSync(outDir) ? allOutput(outDir) : [];
  const htmlTexts = files.filter(([rel]) => rel.endsWith('.html')).map(([, bytes]) => textOf(bytes.toString('utf8')));

  const re = (s) => new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`);
  const checkVisible = (s) => checkTexts.some((t) => re(s).test(t));
  const buildVisible = (s) => htmlTexts.some((t) => re(s).test(t));
  return { root, build, set, rendered, files, checkVisible, buildVisible, re };
}

let ctx;
test.before(() => {
  ctx = buildScratch();
});
test.after(() => {
  if (ctx) fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('P1 precondition: the build exits 0, exclude_callouts is on, all case notes are published, every lead sentinel is visible on both sides', () => {
  assert.equal(ctx.build.status, 0, ctx.build.stderr + ctx.build.stdout);
  assert.equal(ctx.set.publishConfig.exclude_callouts, true);
  const rels = new Set(ctx.set.publishedPages.map((p) => p.rel));
  assert.equal(Object.keys(CASES).length, 11);
  for (const letter of Object.keys(CASES)) {
    assert.ok(rels.has(`Characters/NPCs/Zqx Case ${letter}.md`), `case ${letter} is not published`);
  }
  for (const letter of Object.keys(CASES)) {
    const lead = `ZQX${letter}0`;
    assert.ok(ctx.checkVisible(lead), `check side: ${lead}`);
    assert.ok(ctx.buildVisible(lead), `build side: ${lead}`);
  }
});

test('P2 literal table: each sentinel has its 1.14.0 result on the check side and, separately, on the build side', () => {
  for (const s of SENTINELS) {
    assert.equal(ctx.checkVisible(s), LITERALS[s], `check side: ${s} should be ${LITERALS[s] ? 'visible' : 'hidden'}`);
  }
  for (const s of SENTINELS) {
    assert.equal(ctx.buildVisible(s), LITERALS[s], `build side: ${s} should be ${LITERALS[s] ? 'visible' : 'hidden'}`);
  }
});

test('P3 equivalence: check-visible equals build-visible for every sentinel (the PC story tokens are one-way)', () => {
  for (const s of SENTINELS) {
    if (ONE_WAY.has(s)) {
      if (ctx.buildVisible(s)) assert.ok(ctx.checkVisible(s), `${s}: build shows it but check hides it`);
      continue;
    }
    assert.equal(ctx.checkVisible(s), ctx.buildVisible(s), `${s}: check=${ctx.checkVisible(s)} build=${ctx.buildVisible(s)}`);
  }
});

// P4a, safety. The one exception is ZQXH1 and ZQXH2 in search-index.json (see P4b).
const INDEX_EXCEPTION = new Set(['ZQXH1', 'ZQXH2']);
test('P4a safety: a sentinel that check hides appears in no output file, as written or lowercased (except the known search-index leak)', () => {
  assert.ok(ctx.files.length > 0, 'the build wrote no output');
  for (const s of SENTINELS) {
    if (ctx.checkVisible(s)) continue;
    for (const [rel, bytes] of ctx.files) {
      if (INDEX_EXCEPTION.has(s) && rel === 'search-index.json') continue;
      const text = bytes.toString('utf8');
      assert.ok(!ctx.re(s).test(text), `${rel} carries ${s}`);
      assert.ok(!ctx.re(s.toLowerCase()).test(text), `${rel} carries lowercased ${s}`);
    }
  }
});

// Known leak at the 1.14.0 generator, issue #202: the search index is built from a published view
// that keeps dataview blocks. This literal pins today's behaviour. When a fix or a repin removes the
// leak, P4b goes red: flip it to absent and remove the exception from P4a in that change.
test('P4b known 1.14.0 leak: search-index.json carries the dataview fence words, not the %% pair outside the fence', () => {
  const idx = ctx.files.find(([rel]) => rel === 'search-index.json');
  assert.ok(idx, 'search-index.json was not written');
  const text = idx[1].toString('utf8');
  assert.ok(ctx.re('zqxh1').test(text), 'zqxh1 should be in the index at 1.14.0');
  assert.ok(ctx.re('zqxh2').test(text), 'zqxh2 should be in the index at 1.14.0');
  assert.ok(!ctx.re('zqxh4').test(text), 'zqxh4 must not be in the index');
});
