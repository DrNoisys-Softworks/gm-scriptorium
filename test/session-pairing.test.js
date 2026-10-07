'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md): proves SD-1/SD-2/SD-3 --
 * src/vault/sessionpairs.js's port of the pin's own note walk, and its recomputed pairing, agree
 * with the pin itself and with what a real build actually does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const sessionpairs = require('../src/vault/sessionpairs');
const { computePublishedSet } = require('../src/vault/publishset');
const { runAtomicBuild } = require('../src/build/run');
const { captureWithheldHubs, compareSessionPairs } = require('../src/build/sessionmodel');

const oracleSessionHub = require('gm-apprentice-publish/lib/session-hub');
const oracleScanner = require('gm-apprentice-publish/lib/scanner');

const SRC_DIR = path.join(__dirname, '..', 'src');
const GENERATOR_LIB = path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish', 'lib');

const CHAIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-vault');
const CHAIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-vault-site-config.json'));
const TWIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-twin-vault');

function walkJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function copyChainVariant(label) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-session-pairing-${label}-`));
  const vaultDir = path.join(scratch, 'vault');
  fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
  return { scratch, vaultDir };
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}
function writeFile(p, s) {
  fs.writeFileSync(p, s);
}

// ---------------------------------------------------------------------------
// Facade identity
// ---------------------------------------------------------------------------

test('facade identity: pinned.WRAP_UP_TYPES and isWrapUp are the pin\'s own objects', () => {
  assert.equal(pinned.WRAP_UP_TYPES, oracleSessionHub.WRAP_UP_TYPES);
  assert.equal(pinned.isWrapUp, oracleSessionHub.isWrapUp);
});

// ---------------------------------------------------------------------------
// Structural: no hand-copied Wrap-Up type literal anywhere in src/
// ---------------------------------------------------------------------------

test('structural: no file under src/ contains a Wrap-Up type literal, comments stripped', () => {
  const offenders = [];
  for (const file of walkJsFiles(SRC_DIR)) {
    const stripped = stripComments(readFile(file));
    if (/session_wrap|session-wrap-up|session-wrapup/.test(stripped)) {
      offenders.push(path.relative(path.join(__dirname, '..'), file));
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Change detectors against the installed pin
// ---------------------------------------------------------------------------

test('change detector: lib/scanner.js still carries the exact SESSION_TYPE_LINE literal and gate', () => {
  const src = readFile(path.join(GENERATOR_LIB, 'scanner.js'));
  assert.ok(
    src.includes('const SESSION_TYPE_LINE = /^type:\\s*["\']?(session|session_wrap|session-wrap-up|session-wrapup)["\']?\\s*$/m;'),
  );
  assert.ok(src.includes('if (/^(gm_)?aliases:/m.test(text) || SESSION_TYPE_LINE.test(text)) frontmatter = parseNote(text).data || {};'));
});

test('the pin\'s SESSION_TYPE_LINE alternation equals {session} union WRAP_UP_TYPES', () => {
  const src = readFile(path.join(GENERATOR_LIB, 'scanner.js'));
  const m = src.match(/SESSION_TYPE_LINE = \/\^type:\\s\*\["']\?\(([^)]+)\)/);
  assert.ok(m, 'could not find SESSION_TYPE_LINE in the installed pin');
  const members = new Set(m[1].split('|'));
  assert.deepEqual(members, new Set(['session', ...pinned.WRAP_UP_TYPES]));
});

test('change detector: lib/templates/session.js still emits both markup literals build/sessionmodel.js reads', () => {
  const src = readFile(path.join(GENERATOR_LIB, 'templates', 'session.js'));
  assert.ok(src.includes('class="recap session-recap"'));
  assert.ok(src.includes('<a class="recap-link" href="${href(ctx.wrapUp)}">'));
});

// ---------------------------------------------------------------------------
// Port parity: scanAllNotesForPairing vs the pin's own scanAllNotes
// ---------------------------------------------------------------------------

test('port parity: scanAllNotesForPairing matches the pin\'s own scanAllNotes across a mixed-gate matrix', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-port-parity-'));
  try {
    fs.mkdirSync(path.join(scratch, '.dotdir'));
    writeFile(path.join(scratch, '.dotdir', 'Hidden.md'), '---\ntype: session\n---\n');

    fs.mkdirSync(path.join(scratch, 'sub', 'node_modules', 'pkg'), { recursive: true });
    writeFile(path.join(scratch, 'sub', 'node_modules', 'pkg', 'Note.md'), '---\ntype: session\n---\n');

    fs.mkdirSync(path.join(scratch, '_Templates'));
    writeFile(path.join(scratch, '_Templates', 'Tmpl.md'), '---\ntype: npc\n---\n');
    fs.mkdirSync(path.join(scratch, '_inbox'));
    writeFile(path.join(scratch, '_inbox', 'Draft.md'), '---\ntype: npc\naliases: [Foo]\n---\n');

    writeFile(path.join(scratch, 'UPPER.MD'), '---\ntype: session\n---\n');
    writeFile(path.join(scratch, 'Commented.md'), '---\ntype: session # prep\n---\n');
    writeFile(path.join(scratch, 'AliasLine.md'), 'Some prose.\naliases: not-real-frontmatter\n');
    writeFile(path.join(scratch, 'Malformed.md'), '---\ngm_aliases: [Foo\n---\n');
    writeFile(path.join(scratch, 'JsonFence.md'), '---json\n{"aliases": ["Foo"]}\n---\n');

    const realFile = path.join(scratch, 'Real.md');
    writeFile(realFile, '---\ntype: npc\n---\n');
    let symlinked = true;
    try {
      fs.symlinkSync(realFile, path.join(scratch, 'Link.md'));
    } catch (err) {
      if (err.code !== 'EPERM') throw err;
      symlinked = false;
    }

    writeFile(path.join(scratch, 'PC.md'), '---\ntype: pc\n---\n');
    writeFile(path.join(scratch, 'PC_Story.md'), '---\ntype: character-story\ngm_aliases: [Secret]\n---\n');

    const originalWarn = console.warn;
    console.warn = () => {};
    let oracleNotes;
    try {
      oracleNotes = oracleScanner.scanAllNotes(scratch);
    } finally {
      console.warn = originalWarn;
    }

    const { notes: ourNotes, symlinkedNotes } = sessionpairs.scanAllNotesForPairing(scratch);

    const pick = (n) => ({ title: n.title, displayTitle: n.displayTitle, vaultPath: n.vaultPath, sourcePath: n.sourcePath, frontmatter: n.frontmatter });
    const bySource = (a, b) => (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0);

    assert.deepEqual(
      ourNotes.map(pick).sort(bySource),
      oracleNotes.map(pick).sort(bySource),
    );

    if (symlinked) assert.equal(symlinkedNotes, 1);
    else t.skip('symlink creation refused by the sandbox (EPERM); symlink-count assertion skipped');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pairing parity: the port + pairHubs vs pairHubs({ vaultPath })
// ---------------------------------------------------------------------------

// Both helpers below adapt each page exactly once and reuse the SAME adapted object for the
// `corpus` and `published` arguments (a Map keyed by the original page object) -- calling
// adaptPage a second, independent time for the published subset would reproduce finding 0.1's own
// latent object-identity bug (the one this whole module exists to avoid) in the TEST itself.
function adaptOnce(publishSet) {
  const corpusPages = [...publishSet.publishedPages, ...publishSet.unpublishedPages];
  const adapted = new Map(corpusPages.map((p) => [p, sessionpairs.adaptPage(p)]));
  return {
    corpus: corpusPages.map((p) => adapted.get(p)),
    published: publishSet.publishedPages.map((p) => adapted.get(p)),
  };
}

// `computed` calls the REAL production sessionpairs.computeSessionPairing (so a mutation inside
// it is observable here); `oracle` is an independent reference computation through the pin's own
// vaultPath-based walk, with the correct argument order, built straight from adaptOnce -- it never
// calls anything in src/vault/sessionpairs.js, so it cannot share a bug with the code under test.
function pairingViaPort(vaultDir, siteConfig) {
  const publishSet = computePublishedSet(vaultDir, { ...siteConfig, vaultPath: vaultDir });
  const pairing = sessionpairs.computeSessionPairing({ vaultPath: vaultDir, publishSet });
  return {
    relSet: new Set(pairing.pairs.map((p) => `${p.hub.relPath}=>${p.wrapUp.relPath}`)),
    linked: pairing.linked,
    pairing,
  };
}

function pairingViaVaultPath(vaultDir, siteConfig) {
  const publishSet = computePublishedSet(vaultDir, { ...siteConfig, vaultPath: vaultDir });
  const { corpus, published } = adaptOnce(publishSet);
  const pairs = pinned.pairHubs(corpus, published, { vaultPath: vaultDir, apply: false });
  return {
    relSet: new Set([...pairs.entries()].map(([h, w]) => `${h.relPath}=>${w.relPath}`)),
    linked: new Set([...pairs.linked].map((w) => w.relPath)),
  };
}

function assertPairingParity(vaultDir, siteConfig, label) {
  const a = pairingViaPort(vaultDir, siteConfig);
  const b = pairingViaVaultPath(vaultDir, siteConfig);
  assert.deepEqual(a.relSet, b.relSet, `${label}: pairs differ`);
  assert.deepEqual(a.linked, b.linked, `${label}: linked differs`);
  return a;
}

test('pairing parity (b): computeSessionPairing equals pairHubs({ vaultPath }), and Session 2 pairs through the hub link alone', () => {
  const { scratch, vaultDir } = copyChainVariant('b');
  try {
    const { relSet } = assertPairingParity(vaultDir, CHAIN_SITE_CONFIG, '(b)');
    assert.ok(relSet.has('Sessions/Session 1.md=>WrapUps/Session 1 Wrap-Up.md'));
    assert.ok(relSet.has('Sessions/Session 2.md=>WrapUps/Session 2 Wrap-Up.md'), 'hub-link-only pairing must hold for Session 2');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pairing parity (c): Session 1 replaced by the twin\'s (unpaired), Wrap-Up 1 removed', () => {
  const { scratch, vaultDir } = copyChainVariant('c');
  try {
    fs.copyFileSync(path.join(TWIN_VAULT, 'Sessions', 'Session 1.md'), path.join(vaultDir, 'Sessions', 'Session 1.md'));
    fs.rmSync(path.join(vaultDir, 'WrapUps', 'Session 1 Wrap-Up.md'));
    const { relSet } = assertPairingParity(vaultDir, CHAIN_SITE_CONFIG, '(c)');
    assert.ok(!relSet.has('Sessions/Session 1.md=>WrapUps/Session 1 Wrap-Up.md'));
    assert.ok(relSet.has('Sessions/Session 2.md=>WrapUps/Session 2 Wrap-Up.md'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pairing parity (ambiguous): a link that resolves to more than one candidate pairs with nothing', () => {
  const { scratch, vaultDir } = copyChainVariant('ambiguous');
  try {
    const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
    let hub = readFile(hubPath);
    hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 2 Wrap-Up\]\]"\n {2}prep: "R2SENTINEL-DOCS"\n/, '');
    writeFile(hubPath, hub);

    const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
    let wrap = readFile(wrapPath);
    wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\nsession: "[[Session 2]]"');
    writeFile(wrapPath, wrap);

    fs.mkdirSync(path.join(vaultDir, '_Templates'), { recursive: true });
    writeFile(path.join(vaultDir, '_Templates', 'Session 2.md'), '---\ntype: session\n---\n\nTemplate.\n');

    const { relSet } = assertPairingParity(vaultDir, CHAIN_SITE_CONFIG, '(ambiguous)');
    assert.ok(!relSet.has('Sessions/Session 2.md=>WrapUps/Session 2 Wrap-Up.md'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pairing parity (claim-only): Session 1\'s hub link removed, pairing survives on the Wrap-Up\'s own session: claim', () => {
  const { scratch, vaultDir } = copyChainVariant('claim-only');
  try {
    const hubPath = path.join(vaultDir, 'Sessions', 'Session 1.md');
    let hub = readFile(hubPath);
    hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 1 Wrap-Up\]\]"\n/, '');
    writeFile(hubPath, hub);

    const { relSet } = assertPairingParity(vaultDir, CHAIN_SITE_CONFIG, '(claim-only)');
    assert.ok(relSet.has('Sessions/Session 1.md=>WrapUps/Session 1 Wrap-Up.md'), 'the Wrap-Up\'s own session: claim must still pair');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pairing parity (hub unpublished): computeSessionPairing still carries the pair, hub.published false, matching pairHubs({ vaultPath })', () => {
  const { scratch, vaultDir } = copyChainVariant('hub-unpublished');
  try {
    const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
    let hub = readFile(hubPath);
    hub = hub.replace('---\n\nR2SENTINEL-HUB-BODY', 'publish: false\n---\n\nR2SENTINEL-HUB-BODY');
    writeFile(hubPath, hub);

    const { relSet, pairing } = pairingViaPort(vaultDir, CHAIN_SITE_CONFIG);
    const oracle = pairingViaVaultPath(vaultDir, CHAIN_SITE_CONFIG);
    assert.deepEqual(relSet, oracle.relSet);
    assert.ok(relSet.has('Sessions/Session 2.md=>WrapUps/Session 2 Wrap-Up.md'), 'an unpublished hub must still appear in pairs');
    const pair = pairing.pairs.find((p) => p.hub.relPath === 'Sessions/Session 2.md');
    assert.equal(pair.hub.published, false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('computeSessionPairing: an UNPUBLISHED Wrap-Up never pairs (M1/M32 discriminator)', (t) => {
  const { scratch, vaultDir } = copyChainVariant('unpublished-wrapup');
  try {
    const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
    let wrap = readFile(wrapPath);
    wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\npublish: false');
    writeFile(wrapPath, wrap);

    const publishSet = computePublishedSet(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir });
    const pairing = sessionpairs.computeSessionPairing({ vaultPath: vaultDir, publishSet });
    assert.ok(
      !pairing.pairs.some((p) => p.hub.relPath === 'Sessions/Session 2.md'),
      'an unpublished Wrap-Up must never pair, even though the hub\'s link names it',
    );
    assert.ok(!pairing.withheldHubs.has('Sessions/Session 2.md'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Gate (SD-3): no published Wrap-Up -> EMPTY_PAIRING, 0 walks
// ---------------------------------------------------------------------------

test('gate: on the twin (no published Wrap-Up), the walk is called 0 times and the result is EMPTY_PAIRING', () => {
  const publishSet = computePublishedSet(TWIN_VAULT, { ...require(path.join(__dirname, 'fixtures', 'session-chain-twin-vault-site-config.json')), vaultPath: TWIN_VAULT });
  let calls = 0;
  const original = sessionpairs.scanAllNotesForPairing;
  sessionpairs.scanAllNotesForPairing = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    const result = sessionpairs.computeSessionPairing({ vaultPath: TWIN_VAULT, publishSet });
    assert.equal(calls, 0);
    assert.equal(result, sessionpairs.EMPTY_PAIRING);
  } finally {
    sessionpairs.scanAllNotesForPairing = original;
  }
});

// ---------------------------------------------------------------------------
// Build and check agree (SD-1's proof d): real runAtomicBuild
// ---------------------------------------------------------------------------

function buildAndRead(vaultDir, siteConfig, campaign) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-session-pairing-build-${campaign}-`));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath: vaultDir,
      userJsonConfig: { ...siteConfig, vaultPath: vaultDir },
      finalOut,
      siteDir,
      campaign,
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
    return { result, finalOut };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('build and check agree (b): what the build read equals the check pairing filtered to published hubs', () => {
  const { result } = buildAndRead(CHAIN_VAULT, CHAIN_SITE_CONFIG, 'pairing-agree-b');
  const publishSet = computePublishedSet(CHAIN_VAULT, { ...CHAIN_SITE_CONFIG, vaultPath: CHAIN_VAULT });
  const pairing = sessionpairs.computeSessionPairing({ vaultPath: CHAIN_VAULT, publishSet });

  const checkByOutput = new Map();
  for (const pair of pairing.pairs) {
    if (pair.hub.published) checkByOutput.set(pair.hub.outputPath, pair.wrapUp.outputPath);
  }
  assert.deepEqual(result.sessionPairs.wrapUpByHub, checkByOutput);

  for (const hub of result.sessionPairs.wrapUpByHub.keys()) {
    assert.ok(pairing.withheldHubs.has(
      [...publishSet.publishedPages].find((p) => p.outputPath === hub).relPath,
    ));
  }
  assert.deepEqual(result.sessionPairs.divergence, []);
});

test('build and check agree (ambiguous): Session 2 pairs with nothing on either side; Session 1 is unaffected', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-pairing-build-ambiguous-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
    let hub = readFile(hubPath);
    hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 2 Wrap-Up\]\]"\n {2}prep: "R2SENTINEL-DOCS"\n/, '');
    writeFile(hubPath, hub);
    const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
    let wrap = readFile(wrapPath);
    wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\nsession: "[[Session 2]]"');
    writeFile(wrapPath, wrap);
    fs.mkdirSync(path.join(vaultDir, '_Templates'), { recursive: true });
    writeFile(path.join(vaultDir, '_Templates', 'Session 2.md'), '---\ntype: session\n---\n\nTemplate.\n');

    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const result = runAtomicBuild({
      vaultPath: vaultDir,
      userJsonConfig: { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir },
      finalOut,
      siteDir,
      campaign: 'pairing-agree-ambiguous',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
    assert.deepEqual([...result.sessionPairs.wrapUpByHub.keys()], ['sessions/session-1.html']);

    const publishSet = computePublishedSet(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir });
    const pairing = sessionpairs.computeSessionPairing({ vaultPath: vaultDir, publishSet });
    assert.deepEqual([...pairing.withheldHubs], ['Sessions/Session 1.md']);
    assert.deepEqual(result.sessionPairs.divergence, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Symlink variant: fail-safe -- withheldHubs empty, pairs unchanged
// ---------------------------------------------------------------------------

test('symlink variant: withheldHubs is empty (uncertain), but pairs is unaffected', (t) => {
  const { scratch, vaultDir } = copyChainVariant('symlink');
  try {
    fs.mkdirSync(path.join(vaultDir, 'Notes'));
    const outsideFile = path.join(scratch, 'Outside.md');
    writeFile(outsideFile, '---\ntype: npc\n---\n');
    try {
      fs.symlinkSync(outsideFile, path.join(vaultDir, 'Notes', 'Link.md'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlink creation refused by the sandbox (EPERM)');
        return;
      }
      throw err;
    }

    const publishSet = computePublishedSet(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir });
    const pairing = sessionpairs.computeSessionPairing({ vaultPath: vaultDir, publishSet });
    assert.equal(pairing.uncertain, true);
    assert.equal(pairing.withheldHubs.size, 0);
    assert.ok(pairing.pairs.length > 0, 'the pairs themselves are unaffected by the fail-safe');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reading the built pages (unit)
// ---------------------------------------------------------------------------

test('captureWithheldHubs: marker with no link, and a link to a missing file, both go to unreadable', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-capture-'));
  try {
    fs.mkdirSync(path.join(scratch, 'sessions'));
    writeFile(
      path.join(scratch, 'sessions', 'no-link.html'),
      '<div class="recap session-recap"><p>Recap text.</p></div>',
    );
    writeFile(
      path.join(scratch, 'sessions', 'missing-target.html'),
      '<div class="recap session-recap"><p>Recap.</p><a class="recap-link" href="ghost.html">Read the full session &rarr;</a></div>',
    );
    const { wrapUpByHub, unreadable } = captureWithheldHubs(scratch);
    assert.deepEqual([...wrapUpByHub.entries()], []);
    assert.deepEqual(unreadable, ['sessions/missing-target.html', 'sessions/no-link.html']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('captureWithheldHubs: resolution works from a nested hub path', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-capture-nested-'));
  try {
    fs.mkdirSync(path.join(scratch, 'sessions', 'chapter-1'), { recursive: true });
    writeFile(path.join(scratch, 'sessions', 'chapter-1', 'wrap.html'), '<p>Wrap-Up.</p>');
    writeFile(
      path.join(scratch, 'sessions', 'chapter-1', 'hub.html'),
      '<div class="recap session-recap"><a class="recap-link" href="wrap.html">Read the full session &rarr;</a></div>',
    );
    const { wrapUpByHub, unreadable } = captureWithheldHubs(scratch);
    assert.deepEqual(unreadable, []);
    assert.deepEqual([...wrapUpByHub.entries()], [['sessions/chapter-1/hub.html', 'sessions/chapter-1/wrap.html']]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('compareSessionPairs: covers all four cases (site-only, check-only, disagreement, agreement)', () => {
  const pairingFactory = (entries) => ({
    pairs: entries.map(([hub, wrapUp]) => ({ hub: { relPath: hub, outputPath: hub, published: true }, wrapUp: { relPath: wrapUp, outputPath: wrapUp } })),
  });

  // agreement: no entry produced
  const agree = compareSessionPairs(new Map([['a.html', 'wa.html']]), pairingFactory([['a.html', 'wa.html']]));
  assert.deepEqual(agree, []);

  // site-only
  const siteOnly = compareSessionPairs(new Map([['b.html', 'wb.html']]), pairingFactory([]));
  assert.deepEqual(siteOnly, [{ hub: 'b.html', site: 'wb.html', check: null }]);

  // check-only
  const checkOnly = compareSessionPairs(new Map(), pairingFactory([['c.html', 'wc.html']]));
  assert.deepEqual(checkOnly, [{ hub: 'c.html', site: null, check: 'wc.html' }]);

  // disagreement
  const disagree = compareSessionPairs(new Map([['d.html', 'wd1.html']]), pairingFactory([['d.html', 'wd2.html']]));
  assert.deepEqual(disagree, [{ hub: 'd.html', site: 'wd1.html', check: 'wd2.html' }]);
});
