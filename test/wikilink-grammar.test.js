'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const links = require('../src/vault/links');
const { extractWikiLinks } = links;
const { runUnresolved, runInCode } = require('../src/checks/link');

/*
 * Issue #194: check finds and splits wikilinks with the generator's own pattern and parser
 * (wikilinkRe and parseWikilink, lib/wikilink.js:22-24 and :40-60), so it reads a link the way the
 * build does. Every expected value below is written by hand from lib/wikilink.js and from what a
 * real build of a scratch campaign showed, never taken from the code under test.
 *
 * Tests that pass on the old code and prove nothing alone: the T1 rows for `#Sec`, the table row,
 * `[[ Alpha ]]` and the code masks; T2 pages 5, 6 and 8; T3 rows 7 and 8, and the first and third
 * parts of row 9.
 */

// ---- T1: the unit table (extractWikiLinks, no options unless stated) ----

const T1 = [
  ['[[Alpha^b1]]', { target: 'Alpha', alias: null, heading: 'b1', isEmbed: false, line: 1 }],
  ['[[Alpha.md]]', { target: 'Alpha', alias: null, heading: null }],
  ['[[Alpha.MD|x]]', { target: 'Alpha', alias: 'x' }],
  ['Prose [[Alpha\\|Shown]] here', { target: 'Alpha', alias: 'Shown', raw: '[[Alpha\\|Shown]]' }],
  ['| [[Alpha\\|Shown]] |', { target: 'Alpha', alias: 'Shown' }],
  ['[[Alpha#Sec|Shown]]', { target: 'Alpha', heading: 'Sec', alias: 'Shown' }],
  ['[[Alpha#Sec\\|Shown]]', { target: 'Alpha', heading: 'Sec', alias: 'Shown' }],
  ['![[map.png|300]]', { target: 'map.png', alias: '300', isEmbed: true, raw: '![[map.png|300]]' }],
  ['one\ntwo\nsee [[Alpha|two\nlines]] end', { target: 'Alpha', alias: 'two\nlines', line: 3 }],
  ['[[Alpha.md ]]', { target: 'Alpha.md' }],
  ['[[ Alpha ]]', { target: 'Alpha' }],
];

for (const [input, want] of T1) {
  test(`T1 extractWikiLinks(${JSON.stringify(input)}) reads one link the way the generator does`, () => {
    const got = extractWikiLinks(input);
    assert.equal(got.length, 1);
    for (const [k, v] of Object.entries(want)) assert.equal(got[0][k], v, `${k} of ${JSON.stringify(input)}`);
  });
}

test('T1 extractWikiLinks: [[|x]] is not a link to the generator, so it is not one here', () => {
  assert.equal(extractWikiLinks('[[|x]]').length, 0);
});

test('T1 extractWikiLinks: a code span hides ^block links from ignoreCode and shows them to onlyCode', () => {
  assert.equal(extractWikiLinks('`[[Alpha^b1]]`', { ignoreCode: true }).length, 0);
  const only = extractWikiLinks('`[[Alpha^b1]]`', { onlyCode: true });
  assert.equal(only.length, 1);
  assert.equal(only[0].target, 'Alpha');
});

test('T1 extractWikiLinks: every link has exactly the six keys', () => {
  for (const [input] of T1) {
    for (const l of extractWikiLinks(input)) {
      assert.deepEqual(Object.keys(l).sort(), ['alias', 'heading', 'isEmbed', 'line', 'raw', 'target']);
    }
  }
});

// ---- T3: how a finding shows a link (hand-built ctx, the shape src/checks/link.js reads) ----

function ctxWith(raw, resolvedTargets = []) {
  const resolvedSet = new Set(resolvedTargets.map((t) => t.toLowerCase()));
  return {
    campaign: 'fixture',
    index: {
      files: [{ ok: true, relPath: 'Notes/Example.md', raw }],
      resolves: (target) => resolvedSet.has(String(target).trim().toLowerCase()),
    },
  };
}

const T3_FINDINGS = [];

test('T3 row 1: a link whose target runs across a line is one finding at its opener, on one line', () => {
  const fs_ = runUnresolved(ctxWith('one\n[[Zqx\nShown]] end\n'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].line, 2);
  assert.equal(fs_[0].message, 'Notes/Example.md:2: [[Zqx Shown]] does not resolve (the [[ on line 2 is not closed until line 3)');
  assert.equal(fs_[0].detail, '[[Zqx Shown]]');
});

test('T3 row 2: a stray [[ that swallows a real link is reported once, at the stray opener', () => {
  const fs_ = runUnresolved(
    ctxWith('stray [[ opener here\n\nlater [[Zqx Shown]] and [[Zqx Kept]] end\n', ['Zqx Shown', 'Zqx Kept']),
  );
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].line, 1);
  assert.equal(
    fs_[0].message,
    'Notes/Example.md:1: [[opener here later [[Zqx Shown]] does not resolve (the [[ on line 1 is not closed until line 3)',
  );
  assert.equal(fs_[0].detail, '[[ opener here later [[Zqx Shown]]');
});

test('T3 row 3: a long span keeps its first 28 and last 28 characters with " ... " between', () => {
  const fs_ = runUnresolved(ctxWith('[[' + 'a'.repeat(40) + '\n' + 'b'.repeat(40) + ']]'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(
    fs_[0].message,
    `Notes/Example.md:1: [[${'a'.repeat(28)} ... ${'b'.repeat(28)}]] does not resolve (the [[ on line 1 is not closed until line 2)`,
  );
  assert.equal(fs_[0].detail, `[[${'a'.repeat(26)} ... ${'b'.repeat(26)}]]`);
});

test('T3 row 4: the cap counts characters (code points), not UTF-16 units', () => {
  const big = '\u{1D504}'.repeat(40);
  const fs_ = runUnresolved(ctxWith('[[' + big + '\nx]]'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.ok(fs_[0].message.includes(`[[${big} x]]`), fs_[0].message);
  assert.ok(!fs_[0].message.includes(' ... '));
});

test('T3 row 5: a line break in the alias only shows in the detail, with no cause clause', () => {
  const fs_ = runUnresolved(ctxWith('[[Nobody|two\nlines]]'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].message, 'Notes/Example.md:1: [[Nobody]] does not resolve');
  assert.equal(fs_[0].detail, '[[Nobody|two lines]]');
});

test('T3 row 6: link/in-code shows a multi-line span the same way; link/unresolved ignores it', () => {
  const raw = '```\n[[Ghost\nName]]\n```\n';
  const fs_ = runInCode(ctxWith(raw));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].line, 2);
  assert.equal(
    fs_[0].message,
    'Notes/Example.md:2: [[Ghost Name]] does not resolve (the [[ on line 2 is not closed until line 3), and inside code it would not render as a link either way',
  );
  assert.equal(fs_[0].detail, '[[Ghost Name]]');
  assert.deepEqual(runUnresolved(ctxWith(raw)), []);
});

test('T3 row 7: a single-line message and detail are unchanged', () => {
  const fs_ = runUnresolved(ctxWith('See [[Nonexistent]] for detail.\n'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].message, 'Notes/Example.md:1: [[Nonexistent]] does not resolve');
  assert.equal(fs_[0].detail, '[[Nonexistent]]');
});

test('T3 row 8: a single-line in-code message is unchanged', () => {
  const fs_ = runInCode(ctxWith('`[[Ghost]]`'));
  T3_FINDINGS.push(...fs_);
  assert.equal(fs_.length, 1);
  assert.equal(fs_[0].message, 'Notes/Example.md:1: [[Ghost]] does not resolve, and inside code it would not render as a link either way');
});

test('T3 row 9: showLinkSpan leaves a line-free text alone and joins CRLF breaks to one space', () => {
  assert.equal(typeof links.showLinkSpan, 'function');
  assert.equal(links.showLinkSpan('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(links.showLinkSpan('Zqx\r\nShown'), 'Zqx Shown');
  assert.equal(links.showLinkSpan('Zqx Shown'), 'Zqx Shown');
});

test('T3 row 10: no link finding message or detail contains a line break', () => {
  assert.ok(T3_FINDINGS.length >= 8, 'rows 1-8 must have produced findings');
  for (const f of T3_FINDINGS) {
    assert.ok(!f.message.includes('\n'), f.message);
    assert.ok(!f.detail.includes('\n'), f.detail);
  }
});

test('T3 row 11 (owner decision): [[^b1]] has no page name, so it is treated like [[#Heading]] and gives no finding', () => {
  // The real index treats an empty target as resolved (src/vault/index.js, resolves); the hand-built ctx says so too.
  const ctx = ctxWith('See [[^b1]] and [[#Sec]].\n', []);
  const base = ctx.index.resolves;
  ctx.index.resolves = (t) => String(t).trim() === '' || base(t);
  assert.deepEqual(runUnresolved(ctx), []);
});

// ---- T2: real-build parity ----

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

const FM = (title) =>
  `---\ntype: npc\ntitle: ${title}\ncampaign: "The Long Lease"\nsource: play\nsource_confidence: AUTHORITATIVE\nstatus: alive\n---\n\n# ${title}\n\nBody.\n\n`;
// FM is 13 lines, so the first body line of every page is line 14.

const PAGES = {
  1: '[[Zqx Shown^b1]]\n\n[[Zqx Kept^b1]]\n',
  2: '[[Zqx Shown.md]]\n\n[[Zqx Kept.md]]\n',
  3: '[[Zqx Shown.MD|x]]\n\n[[Zqx Kept.MD|y]]\n',
  4: 'prose [[Zqx Shown\\|x]]\n\nprose [[Zqx Kept\\|y]]\n',
  5: '| A | B |\n|---|---|\n| [[Zqx Shown\\|x]] | [[Zqx Kept\\|y]] |\n',
  6: '[[Zqx Shown#Sec|x]]\n\n[[Zqx Kept#Sec|y]]\n',
  7: 'see [[Zqx Shown|two\nlines]] and [[Zqx Kept|two\nlines]]\n',
  8: '[[|x]]\n',
  9: 'multi [[Zqx\nShown]] target\n',
  10: 'stray [[ opener here\n\nlater [[Zqx Shown]] and [[Zqx Kept]] end\n',
};

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-194-'));
  const vault = path.join(root, 'vault');
  fs.cpSync(LEASE, vault, { recursive: true });
  const npc = path.join(vault, 'Characters', 'NPCs');
  fs.writeFileSync(path.join(npc, 'Zqx Shown.md'), FM('Zqx Shown'));
  fs.writeFileSync(path.join(npc, 'Zqx Kept.md'), FM('Zqx Kept'));
  let ticks = '- [x] Characters/NPCs/Zqx Shown.md\n';
  for (const [n, body] of Object.entries(PAGES)) {
    fs.writeFileSync(path.join(npc, `Zqx Link ${n}.md`), FM(`Zqx Link ${n}`) + body);
    ticks += `- [x] Characters/NPCs/Zqx Link ${n}.md\n`;
  }
  const manPath = path.join(vault, '_meta', 'publish-manifest.md');
  const man = fs.readFileSync(manPath, 'utf8');
  assert.ok(man.includes('## Publishing\n'));
  fs.writeFileSync(manPath, man.replace('## Publishing\n', '## Publishing\n' + ticks));
  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
  const add = run(['config', 'add', 'c194', '--vault', vault, '--out', path.join(root, 'out')]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  return { root, run, out: path.join(root, 'out') };
}

test('T2 real build: check and the build agree on every page, and a swallowed link is reported once, on one line', () => {
  const { root, run, out } = scratch();
  try {
    const chk = run(['check', 'c194', '--json']);
    const env = JSON.parse(chk.stdout);
    const forPage = (n, id) => env.findings.filter((f) => f.id === id && f.path === `Characters/NPCs/Zqx Link ${n}.md`);
    const html = (n) => fs.readFileSync(path.join(out, 'characters', 'npcs', `zqx-link-${n}.html`), 'utf8');

    const build = run(['build', 'c194', '--no-check']);
    assert.equal(build.status, 0, build.stderr + build.stdout);

    const shown = (h) => /href="[^"]*zqx-shown\.html"/.test(h);
    const kept = (h) => /href="[^"]*zqx-kept\.html"/.test(h);

    // (a) and (b): pages 1-7
    for (let n = 1; n <= 7; n++) {
      const h = html(n);
      assert.ok(shown(h), `page ${n} must link Zqx Shown`);
      assert.ok(!kept(h), `page ${n} must not link Zqx Kept`);
      assert.equal(forPage(n, 'link/unresolved').length, 0, `page ${n} must have no link/unresolved`);
      const l3 = forPage(n, 'leak/l3-unpublished-link');
      assert.equal(l3.length, 1, `page ${n} must have one l3 finding`);
      assert.equal(l3[0].data.target, 'Zqx Kept');
    }

    // (c): page 8
    assert.ok(!/href="[^"]*zqx-/.test(html(8)), 'page 8 has no link from [[|x]]');
    assert.equal(forPage(8, 'leak/l3-unpublished-link').length, 0);
    assert.equal(forPage(8, 'link/unresolved').length, 0);

    // (d): parity, for every page: check parsed a link to Zqx Shown exactly when the build linked it
    const npc = path.join(root, 'vault', 'Characters', 'NPCs');
    for (let n = 1; n <= 10; n++) {
      const src = fs.readFileSync(path.join(npc, `Zqx Link ${n}.md`), 'utf8');
      const parsed = extractWikiLinks(src).map((l) => l.target.toLowerCase());
      assert.equal(parsed.includes('zqx shown'), shown(html(n)), `page ${n}: check and build disagree about Zqx Shown`);
    }

    // (e): the two pages whose target runs across lines, literal strings, lines worked out by hand
    const p9 = forPage(9, 'link/unresolved');
    assert.equal(p9.length, 1);
    assert.equal(p9[0].line, 14);
    assert.equal(p9[0].message, 'Characters/NPCs/Zqx Link 9.md:14: [[Zqx Shown]] does not resolve (the [[ on line 14 is not closed until line 15)');
    assert.equal(p9[0].detail, '[[Zqx Shown]]');
    const p10 = forPage(10, 'link/unresolved');
    assert.equal(p10.length, 1);
    assert.equal(p10[0].line, 14);
    assert.equal(
      p10[0].message,
      'Characters/NPCs/Zqx Link 10.md:14: [[opener here later [[Zqx Shown]] does not resolve (the [[ on line 14 is not closed until line 16)',
    );
    assert.equal(p10[0].detail, '[[ opener here later [[Zqx Shown]]');

    // (f): in the human output each is exactly two lines, the head plus message, then the detail
    const human = run(['check', 'c194']).stdout.split('\n');
    for (const [n, p] of [[9, p9[0]], [10, p10[0]]]) {
      const i = human.indexOf(`ERROR link/unresolved Characters/NPCs/Zqx Link ${n}.md:14  ${p.message}`);
      assert.ok(i >= 0, `human output must carry page ${n}'s finding on one line`);
      assert.equal(human[i + 1], `    ${p.detail}`);
      assert.match(human[i + 2], /^(ERROR|WARN|INFO) |^$/, 'the detail is the last line of the finding');
    }

    // (g): the finding fires exactly where the build fails to link
    assert.ok(!shown(html(9)), 'page 9: the build links nothing');
    assert.ok(!shown(html(10)), 'page 10: the swallowed link is not a link in the build');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
