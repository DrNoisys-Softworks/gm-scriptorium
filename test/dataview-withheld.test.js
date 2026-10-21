'use strict';

/*
 * Issue #202: text inside a dataview block must not reach the player site's search index, "Mentioned
 * in" links, recency or the recaps. At publish-v1.14.0 the generator strips dataview blocks when it
 * renders a page, but its search, backlink and recap text (`page.publishedMarkdown`) keeps them. The
 * build's read shim removes them first, with the pin's own `stripDataview` (src/vault/dataview.js,
 * ADR 0044 addendum on dataview blocks).
 *
 * U1: the shim on a scratch vault, with literal expectations written by hand from lib/processor.js:475-477
 * and src/vault/comments.js:28-117.
 * R: a real CLI build of a copy of the sample campaign with dataview blocks in a published page, a
 * session recap and the campaign page.
 *
 * TRIPWIRE: from publish-v1.16.0 the generator strips dataview itself in that text. If a repin makes
 * this file pass with the shim entry removed (mutation M1), the entry can go. If a repin turns it red,
 * the generator changed under us.
 *
 * THESE PASS ON MAIN TOO AND PROVE NOTHING ALONE: E5 (page unchanged), E6 (frontmatter kept), E7
 * (manifest probe), the U1 manifest and `i.md` rows, and strip-order P1 to P3. They guard against a
 * fix that over-strips. The evidence for the fix is E1 to E4 and strip-order P4b, plus mutations M1
 * to M6 recorded in the change that added this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bootstrap = require('../src/generator/bootstrap');
const { computePublishedSet } = require('../src/vault/publishset');
const { textOf } = require('../src/build/htmltext');

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

// ---- U1: the shim on a scratch vault ----

function withShim(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dv-u1-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), body);
  }
  const restore = bootstrap.installVaultReadShim(vault, bootstrap.READ_TRANSFORMS_FOR_BUILD);
  try {
    return fn((rel, enc) => fs.readFileSync(path.join(vault, rel), enc));
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const A_IN = '---\nage: "x ```dataview y"\n---\nP1\n```dataview\nQ1\n```\nP2\n```dataviewjs\nQ2\n```\nP3\n```\nK1\n```\n';
const A_OUT = '---\nage: "x ```dataview y"\n---\nP1\n\nP2\n\nP3\n```\nK1\n```\n';
const MANIFEST = '## Publishing\n```dataview\n## Excluded\n```\n';
const I_IN = 'ZQXI1 ```dataview %% ZQXI2\nZQXI3 ``` ZQXI4 %% ZQXI5\n';
const I_OUT = 'ZQXI1 ```dataview \n ZQXI5\n';

test('U1 a.md: dataview and dataviewjs blocks go, a plain fence stays, the frontmatter is byte-identical', () => {
  withShim({ 'a.md': A_IN }, (read) => {
    const { stripDataviewBlocks } = require('../src/vault/dataview');
    assert.equal(read('a.md', 'utf8'), A_OUT);
    assert.equal(typeof stripDataviewBlocks, 'function');
  });
});

test('U1 b.md: a note with no frontmatter loses its block and keeps the newline after it', () => {
  withShim({ 'b.md': '```dataview\nQ\n```\nZ\n' }, (read) => {
    require('../src/vault/dataview');
    assert.equal(read('b.md', 'utf8'), '\nZ\n');
  });
});

test('U1 manifest: _meta/publish-manifest.md is read unchanged (a stripped fence would move an Excluded heading)', () => {
  withShim({ '_meta/publish-manifest.md': MANIFEST }, (read) => {
    assert.equal(read('_meta/publish-manifest.md', 'utf8'), MANIFEST);
  });
});

test('U1 i.md: the comment strip runs first, so a %% that opens after an inline dataview opener leaves no closed block', () => {
  withShim({ 'i.md': I_IN }, (read) => {
    assert.equal(read('i.md', 'utf8'), I_OUT);
  });
});

test('U1 a Buffer read (no encoding) is the raw bytes', () => {
  withShim({ 'a.md': A_IN }, (read) => {
    const raw = read('a.md');
    assert.ok(Buffer.isBuffer(raw));
    assert.equal(Buffer.compare(raw, Buffer.from(A_IN, 'utf8')), 0);
  });
});

test('U1 frontmatter edge cases: CRLF, a file that is only frontmatter, an unclosed frontmatter, a non-string', () => {
  withShim(
    {
      'crlf.md': '---\r\nk: v\r\n---\r\n```dataview\r\nQ\r\n```\r\nZ\r\n',
      'only.md': '---\nk: "```dataview"\n---',
      'open.md': '---\n```dataview\nQ\n```\nZ\n',
    },
    (read) => {
      const { stripDataviewBlocks } = require('../src/vault/dataview');
      assert.equal(read('crlf.md', 'utf8'), '---\r\nk: v\r\n---\r\n\r\nZ\r\n');
      assert.equal(read('only.md', 'utf8'), '---\nk: "```dataview"\n---');
      assert.equal(read('open.md', 'utf8'), '---\n\nZ\n');
      assert.equal(stripDataviewBlocks(null), null);
      assert.equal(stripDataviewBlocks(undefined, 'a.md'), undefined);
    },
  );
});

test('U1 the manifest skip is exact: only a file named publish-manifest.md directly inside a folder named _meta', () => {
  const { stripDataviewBlocks } = require('../src/vault/dataview');
  const src = '```dataview\nQ\n```\nZ\n';
  assert.equal(stripDataviewBlocks(src, path.join('vault', '_meta', 'publish-manifest.md')), src);
  assert.equal(stripDataviewBlocks(src, path.join('vault', '_meta', 'other.md')), '\nZ\n');
  assert.equal(stripDataviewBlocks(src, path.join('vault', 'notes', 'publish-manifest.md')), '\nZ\n');
  assert.equal(stripDataviewBlocks(src), '\nZ\n');
  // Known residual (ADR 0044 addendum): a nested _meta/publish-manifest.md is skipped too.
  assert.equal(stripDataviewBlocks(src, path.join('vault', 'sub', '_meta', 'publish-manifest.md')), src);
});

test('U1 the shim hands every transform the file path as a second argument', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dv-u1-'));
  try {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'n.md'), 'x\n');
    const seen = [];
    const restore = bootstrap.installVaultReadShim(vault, [(text, file) => (seen.push(file), text)]);
    try {
      fs.readFileSync(path.join(vault, 'n.md'), 'utf8');
    } finally {
      restore();
    }
    assert.deepEqual(seen, [path.join(vault, 'n.md')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- R: a real build ----

const fm = (title, extra = '') =>
  ['---', 'type: npc', `title: ${title}`, 'campaign: "The Long Lease"', 'source: play', 'source_confidence: AUTHORITATIVE', ...(extra ? [extra] : []), '---'].join('\n');

const FENCE = '```';

/** Builds the vault. `blocks` false: each dataview block in the notes is deleted by hand (build B). */
function makeVault(root, blocks) {
  const vault = path.join(root, 'v');
  fs.cpSync(LEASE, vault, { recursive: true });
  const blk = (s) => (blocks ? s : '');
  const npc = (name, body) => fs.writeFileSync(path.join(vault, 'Characters', 'NPCs', `${name}.md`), `${body.startsWith('---') ? body : `${fm(name)}\n\n${body}`}\n`);

  npc('Zqx Target', 'Zqx Target waits.');
  npc('Zqx Mention', 'Zqx Mention knows [[Zqx Target]].');
  const dBody = [
    'Zqx Dataview Page keeps ZQXKEEPDV1.',
    '',
    FENCE,
    'ZQXKEEPDV2 plain fence',
    FENCE,
    '',
    blk(`${FENCE}dataview\nTABLE ZQXDV1 FROM "ZQXDV2" WHERE file.link = [[Zqx Target]]\n${FENCE}`),
    '',
    blk(`${FENCE}dataviewjs\ndv.paragraph("ZQXDV3")\n${FENCE}`),
  ].join('\n');
  npc('Zqx Dataview Page', `${fm('Zqx Dataview Page', `age: "ZQXFM1 ${FENCE}dataview ZQXFM2"`)}\n\n${dBody}`);
  npc('Zqx Manifest Probe', 'Zqx Manifest Probe holds ZQXMAN1.');

  const edit = (rel, find, replacement) => {
    const file = path.join(vault, rel);
    const src = fs.readFileSync(file, 'utf8');
    const next = src.replace(find, () => replacement);
    assert.notEqual(next, src, `edit did not apply to ${rel}`);
    fs.writeFileSync(file, next);
  };
  edit('Sessions/Session 03 - Under the Sallow Hills.md', '## Narrative Recap\n\n', `## Narrative Recap\n\n${blk(`${FENCE}dataview\nLIST ZQXDV4\n${FENCE}`)}\n\n`);
  edit('_Campaign/The Long Lease.md', '## The premise\n\n', `## The premise\n\n${blk(`${FENCE}dataview\nLIST ZQXDV5\n${FENCE}`)}\n\n`);
  const ticks = ['Characters/NPCs/Zqx Target.md', 'Characters/NPCs/Zqx Mention.md', 'Characters/NPCs/Zqx Dataview Page.md'];
  const man = '_meta/publish-manifest.md';
  edit(man, '## Publishing\n', `## Publishing\n\n${ticks.map((t) => `- [x] ${t}`).join('\n')}\n`);
  // The manifest keeps its fence in every build, including B: it is not a note body.
  edit(man, '## Needs Decision', `${FENCE}dataview\n## Excluded\n${FENCE}\n- [x] Characters/NPCs/Zqx Manifest Probe.md\n\n## Needs Decision`);
  return vault;
}

function allOutput(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p)]);
    }
  })(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** One scratch root, one CLI build. `preload` is a script path loaded into the build process. */
function buildOnce({ blocks = true, preload = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dv-'));
  const vault = makeVault(root, blocks);
  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  delete env.NODE_OPTIONS;
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  const add = run(['config', 'add', 'v', '--vault', vault, '--out', path.join(root, 'out-v')]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  const build = run(['build', 'v', '--no-check'], preload ? { NODE_OPTIONS: `--require ${preload}` } : {});
  const outDir = path.join(root, 'out-v');
  return { root, vault, build, files: fs.existsSync(outDir) ? allOutput(outDir) : [] };
}

const re = (s) => new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`);
const get = (b, rel) => {
  const f = b.files.find(([r]) => r === rel);
  assert.ok(f, `${rel} was not written`);
  return f[1].toString('utf8');
};
const DV = ['ZQXDV1', 'ZQXDV2', 'ZQXDV3', 'ZQXDV4', 'ZQXDV5'];
const D_PAGE = 'characters/npcs/zqx-dataview-page.html';
const T_PAGE = 'characters/npcs/zqx-target.html';

let A;
let A2;
let B;
let A0;
const roots = [];
function track(b) {
  roots.push(b.root);
  return b;
}

/** The build without the dataview transform: a preload that removes exactly that list entry, and throws if it is absent. */
function a0() {
  if (!A0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dv-pre-'));
    roots.push(dir);
    const breaker = path.join(dir, 'break.js');
    fs.writeFileSync(
      breaker,
      [
        `const list = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'generator', 'bootstrap.js'))}).READ_TRANSFORMS_FOR_BUILD;`,
        `const target = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'vault', 'dataview.js'))}).stripDataviewBlocks;`,
        'const i = list.findIndex((fn) => fn === target);',
        "if (i < 0) throw new Error('the dataview transform is not in READ_TRANSFORMS_FOR_BUILD');",
        'list.splice(i, 1);',
        '',
      ].join('\n'),
    );
    A0 = track(buildOnce({ preload: breaker }));
  }
  return A0;
}

test.before(() => {
  A = track(buildOnce());
  A2 = track(buildOnce());
  B = track(buildOnce({ blocks: false }));
});
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

test('E0 every build exits 0, and building A twice gives the same files (the noise floor)', () => {
  for (const [name, b] of [['A', A], ['A2', A2], ['B', B]]) assert.equal(b.build.status, 0, `${name}: ${b.build.stderr}${b.build.stdout}`);
  assert.deepEqual(A.files.map(([r]) => r), A2.files.map(([r]) => r));
  for (let i = 0; i < A.files.length; i++) assert.equal(A.files[i][1].toString('utf8'), A2.files[i][1].toString('utf8'), `${A.files[i][0]} differs between two identical builds`);
});

test('E1 search-index.json carries none of the dataview query words', () => {
  const idx = get(A, 'search-index.json').toLowerCase();
  for (const w of DV) assert.ok(!re(w.toLowerCase()).test(idx), `${w} is in the search index`);
});

test('E2 a page the query links to does not list the query page under "Mentioned in"; a real mention still does', () => {
  const t = get(A, T_PAGE);
  assert.ok(!/href="[^"]*zqx-dataview-page\.html"/.test(t), 'the dataview page is listed on the linked page');
  assert.ok(/href="[^"]*zqx-mention\.html"/.test(t), 'positive control: a real [[link]] must still be listed');
});

test('E3 no output file carries any query word, as written or lowercased', () => {
  assert.ok(A.files.length > 0, 'the build wrote no output');
  for (const [rel, bytes] of A.files) {
    const text = bytes.toString('utf8');
    for (const w of DV) {
      assert.ok(!text.includes(w), `${rel} carries ${w}`);
      assert.ok(!text.includes(w.toLowerCase()), `${rel} carries ${w.toLowerCase()}`);
    }
  }
});

test('E4 the build equals a build of the same vault with each dataview block deleted by hand', () => {
  assert.deepEqual(A.files.map(([r]) => r), B.files.map(([r]) => r));
  for (let i = 0; i < A.files.length; i++) assert.equal(A.files[i][1].toString('utf8'), B.files[i][1].toString('utf8'), `${A.files[i][0]} differs from the hand-edited build`);
});

test('E5 the dataview page itself is byte-identical with and without the transform, and keeps its plain fence text', () => {
  const without = a0();
  assert.equal(without.build.status, 0, without.build.stderr + without.build.stdout);
  assert.equal(get(A, D_PAGE), get(without, D_PAGE));
  const d = get(A, D_PAGE);
  assert.ok(d.includes('ZQXKEEPDV1') && d.includes('ZQXKEEPDV2'));
});

test('E5b the build without the transform differs from A only in html pages and the search index', () => {
  const without = a0();
  assert.equal(without.build.status, 0, without.build.stderr + without.build.stdout);
  const byRel = new Map(without.files);
  const differing = [];
  for (const [rel, bytes] of A.files) if (!byRel.has(rel) || !bytes.equals(byRel.get(rel))) differing.push(rel);
  for (const rel of byRel.keys()) if (!A.files.some(([r]) => r === rel)) differing.push(rel);
  for (const rel of differing) assert.ok(rel === 'search-index.json' || rel.endsWith('.html'), `${rel} differs and is neither a page nor the search index`);
  console.log(`A0 vs A differing files: ${JSON.stringify(differing)}`);
});

test('E6 a dataview opener inside a frontmatter value is kept', () => {
  assert.ok(get(A, D_PAGE).includes(`<span class="label">Age</span> ZQXFM1 ${FENCE}dataview ZQXFM2</span>`));
});

test('E7 a fence in the manifest does not move its Excluded heading: the probe stays unpublished on both sides', () => {
  const cfgFile = path.join(A.vault, '_meta', 'scriptorium', 'vault.config.json');
  const jsonConfig = { ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), vaultPath: A.vault };
  const set = computePublishedSet(A.vault, jsonConfig);
  const rels = set.publishedPages.map((p) => p.rel);
  assert.ok(rels.includes('Characters/NPCs/Zqx Dataview Page.md'), 'precondition: the check side publishes the dataview page');
  assert.ok(!rels.includes('Characters/NPCs/Zqx Manifest Probe.md'), 'check publishes the probe');
  for (const [rel, bytes] of A.files) {
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('ZQXMAN1') && !text.includes('zqxman1'), `${rel} carries the probe`);
  }
});

test('E9 the recaps and the campaign page show no code block for the query (visible text)', () => {
  for (const [rel, bytes] of A.files) {
    if (!rel.endsWith('.html')) continue;
    const t = textOf(bytes.toString('utf8'));
    assert.ok(!/LIST ZQX|TABLE ZQX/.test(t), `${rel} shows a query`);
  }
});
