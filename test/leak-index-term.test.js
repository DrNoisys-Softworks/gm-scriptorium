'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const { scanSearchIndex } = require('../src/checks/leak/outputscan');
const { runAtomicBuild } = require('../src/build/run');

const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const INDEX_TERM_VAULT = path.join(__dirname, 'fixtures', 'index-term-vault');
const INDEX_TERM_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'index-term-vault-site-config.json'));
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

function mkRow(relPath, hiddenNames) {
  return { entity: { relPath }, candidateNames: hiddenNames, hiddenNames, collisions: [] };
}

/**
 * Builds a real lunr index (the same shape lib/search-index.js writes) from tiny synthetic docs.
 * FR-18/SD-18 (AC-D2-05 rewrite): this must mirror the pin exactly, not bundled lunr's own
 * default builder pipeline -- lib/search-index.js:53-54 explicitly removes the stemmer from BOTH
 * `pipeline` and `searchPipeline` after construction (#267); lunr's own `lunr(config)` convenience
 * function does not do this itself, so a naive builder here would silently keep the stemmer and
 * every AC-D2-05 assertion below would test the wrong pipeline.
 */
function buildRealIndex(docs) {
  const idx = pinned.lunr(function () {
    this.ref('id');
    this.field('title', { boost: 10 });
    this.field('aliases', { boost: 5 });
    this.field('type', { boost: 2 });
    this.field('body');
    this.pipeline.remove(pinned.lunr.stemmer);
    this.searchPipeline.remove(pinned.lunr.stemmer);
    for (const d of docs) this.add(d);
  });
  return { index: idx.toJSON(), documents: {} };
}

function withScratchIndexFile(json, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-index-term-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>'); // "a real build" marker
    fs.writeFileSync(path.join(dir, 'search-index.json'), JSON.stringify(json));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- AC-D2-05: pipeline order + stem/possessive rule -----------------------

test('AC-D2-05: the pin\'s own pipeline (built with the stemmer removed) is trimmer, stopWordFilter -- no stemmer', () => {
  // Mirrors lib/search-index.js:53-54 exactly (buildRealIndex's own construction), not the
  // Pipeline() convenience constructor's default set.
  const idx = pinned.lunr(function () {
    this.ref('id');
    this.field('body');
    this.pipeline.remove(pinned.lunr.stemmer);
    this.searchPipeline.remove(pinned.lunr.stemmer);
  });
  const json = idx.toJSON();
  assert.deepEqual(json.pipeline, [], 'the serialised pipeline (from searchPipeline) must be empty -- no stemmer');
});

test('AC-D2-05: "Tanmora\'s" (no stemming) hits on the literal index term "tanmora\'s"', () => {
  const json = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: "Tanmora's horde raids the caravans." }]);
  const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data.hiddenName === 'Tanmora' && f.data.term === "tanmora's");
    assert.ok(hit, `expected a finding for term "tanmora's", got: ${JSON.stringify(findings.map((f) => f.data.term))}`);
    assert.equal(hit.id, 'leak/l4-index-term');
    assert.equal(hit.severity, 'error');
    assert.deepEqual(hit.data.documentRefs, ['a.html']);
  });
});

test('AC-D2-05: "Corinne" hits on "corinne"', () => {
  const json = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: 'Corinne runs the tavern.' }]);
  const withheld = [mkRow('Hidden/Corinne.md', ['Corinne'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data.hiddenName === 'Corinne');
    assert.ok(hit);
    assert.equal(hit.data.term, 'corinne');
  });
});

test('the term rule is "exact token, optional possessive/s, trailing punctuation only", never a prefix match; "corinnes" still hits', () => {
  // "Corinne": a document containing the unrelated word "mildrewed" (which shares the "mildr"
  // letters but diverges before "corinne" ends -- not a real prefix case) must never be a hit.
  const negJson = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: 'The old mildrewed tapestry hangs here.' }]);
  const withheld = [mkRow('Hidden/Corinne.md', ['Corinne'])];
  withScratchIndexFile(negJson, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    assert.deepEqual(findings, [], 'an unrelated word must not be a false positive');
  });

  // A GENUINE prefix case (M26 discriminator): "corinne" is a true, literal prefix of
  // "corinneson" (not a possessive/plural form of it), so a check that lost its trailing anchor
  // (matching `^corinne` with nothing after it) would wrongly fire here.
  const prefixJson = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: 'The old Corinneson family crest hangs here.' }]);
  withScratchIndexFile(prefixJson, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    assert.deepEqual(findings, [], '"corinne" must never match as a bare prefix of "corinneson"');
  });

  // The plain "s" plural form must still hit (no apostrophe needed).
  const posJson = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: 'Two Corinnes ran the tavern that week.' }]);
  withScratchIndexFile(posJson, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data.hiddenName === 'Corinne' && f.data.term === 'corinnes');
    assert.ok(hit, `expected a finding for term "corinnes", got: ${JSON.stringify(findings.map((f) => f.data.term))}`);
    assert.deepEqual(hit.data.documentRefs, ['a.html']);
  });
});

// --- AC-D2-06: invertedIndex is a sorted ARRAY of pairs, proven against a REAL build ---

test('AC-D2-06: a real built search-index.json from test/fixtures/pin-vault is read correctly (invertedIndex as an array, not Object.keys)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-index-term-realbuild-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT };
    const finalOut = path.join(scratch, 'out');

    const buildResult = runAtomicBuild({
      vaultPath: PIN_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'index-term-real-build',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));

    const raw = JSON.parse(fs.readFileSync(path.join(finalOut, 'search-index.json'), 'utf8'));
    assert.ok(Array.isArray(raw.index.invertedIndex), 'invertedIndex must really be an array in the file this arm reads');

    const withheld = [mkRow('Characters/NPCs/Gus-Hidden.md', ['Gus Marzone'])];
    const findings = scanSearchIndex({ outDir: finalOut, campaign: 'unit', withheld });
    assert.ok(findings.length > 0, 'must find "Gus Marzone" reachable in the real built index, not silently nothing');
    assert.ok(findings.every((f) => f.id === 'leak/l4-index-term'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a naive Object.keys(invertedIndex) reading would find nothing — regression guard for the risk area', () => {
  const json = buildRealIndex([{ id: 'a.html', title: '', aliases: '', type: '', body: 'Tanmora raids the caravans.' }]);
  withScratchIndexFile(json, (outDir) => {
    const raw = JSON.parse(fs.readFileSync(path.join(outDir, 'search-index.json'), 'utf8'));
    const wrongKeys = Object.keys(raw.index.invertedIndex);
    assert.ok(
      wrongKeys.length > 0 && wrongKeys.every((k, i) => k === String(i)),
      'demonstrates the exact failure mode: Object.keys on an array gives numeric indices ("0","1","2"…), never real terms',
    );
    assert.ok(!wrongKeys.includes('tanmora'), 'the real term must NOT be reachable via Object.keys — only via the array itself');
    // ...and yet the real scanner still finds it, because it reads the array correctly:
    const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    assert.ok(findings.length > 0);
  });
});

// --- AC-D2-07: multi-word intersection, positive and negative --------------

test('AC-D2-07: a multi-word name hits when all its terms share a document ref', () => {
  const json = buildRealIndex([
    { id: 'a.html', title: '', aliases: '', type: '', body: 'Perpetua Vantage runs the smuggling ring.' },
  ]);
  const withheld = [mkRow('Hidden/Perpetua.md', ['Perpetua Vantage'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data.hiddenName === 'Perpetua Vantage');
    assert.ok(hit, 'both words appear together in one document, so the name must be reachable');
    assert.deepEqual(hit.data.documentRefs, ['a.html']);
  });
});

test('AC-D2-07 (negative): a multi-word name does NOT hit when its words only appear in DIFFERENT documents', () => {
  const json = buildRealIndex([
    { id: 'a.html', title: '', aliases: '', type: '', body: 'Perpetua runs the market stall.' },
    { id: 'b.html', title: '', aliases: '', type: '', body: 'The old Vantage bridge collapsed last spring.' },
  ]);
  const withheld = [mkRow('Hidden/Perpetua.md', ['Perpetua Vantage'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data.hiddenName === 'Perpetua Vantage');
    assert.equal(hit, undefined, 'the two words never co-occur in one document, so this must not fire');
  });
});

// --- AC-D2-08: version mismatch WARN, missing-index INFO -------------------

test('AC-D2-08: a lunr version mismatch gives one WARN naming both versions and interprets no terms', () => {
  const json = { index: { version: '2.3.8', fields: [], fieldVectors: [], invertedIndex: [['tanmora', {}]], pipeline: [] }, documents: {} };
  const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn');
    assert.equal(findings[0].id, 'leak/l4-index-term');
    assert.match(findings[0].message, /2\.3\.8/);
    assert.match(findings[0].message, new RegExp(pinned.LUNR_VERSION.replace(/\./g, '\\.')));
    assert.equal(findings[0].data.indexVersion, '2.3.8');
    assert.equal(findings[0].data.expectedVersion, pinned.LUNR_VERSION);
  });
});

test('AC-D2-08: no search-index.json on a real build gives one INFO, not silence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-index-term-missing-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
    const findings = scanSearchIndex({ outDir: dir, campaign: 'unit', withheld });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.equal(findings[0].id, 'leak/l4-index-term');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- FR-18: red-first, on a REAL v1.11.40 build. test/fixtures/index-term-vault has a withheld
// (withheld: true, publish: false) NPC, "Thornwicke", whose lunr stem differs from the raw word
// (a real stemmer would have mangled the search term; the pin's own pipeline no longer stems, so
// the raw word is what actually lands in the index) -- named in a PUBLISHED page's body
// (Locations/Old-Watch.md). A check that still assumed stemming would derive a search term that
// never appears in this pin's unstemmed index and silently miss the leak.

test('FR-18 precondition: "thornwicke" really is stemmable (its stem differs from the raw word)', () => {
  const stemmed = pinned.lunr.stemmer(new pinned.lunr.Token('thornwicke')).toString();
  assert.notEqual(stemmed, 'thornwicke', 'the fixture name must be one a real stemmer would actually change');
});

test('FR-18 red-first: a real build finds the withheld name via the unstemmed index, with an href documentRef (not a base-36 id)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-idxterm-realbuild-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const userJsonConfig = { ...INDEX_TERM_SITE_CONFIG, vaultPath: INDEX_TERM_VAULT };

    const buildResult = runAtomicBuild({
      vaultPath: INDEX_TERM_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'idxterm-realbuild',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));
    assert.equal(fs.existsSync(path.join(finalOut, 'characters', 'npcs', 'thornwicke.html')), false, 'the withheld NPC page must not publish');
    assert.equal(fs.existsSync(path.join(finalOut, 'locations', 'old-watch.html')), true, 'the mentioning page must publish');

    const rawIndex = JSON.parse(fs.readFileSync(path.join(finalOut, 'search-index.json'), 'utf8'));
    assert.deepEqual(rawIndex.index.pipeline, [], 'precondition: the real build\'s own serialised pipeline must be empty (no stemmer)');
    const rawTermRow = rawIndex.index.invertedIndex.find(([term]) => term === 'thornwicke');
    assert.ok(rawTermRow, 'precondition: the real index must contain the raw, unstemmed term "thornwicke"');

    const withheld = [mkRow('Characters/NPCs/Thornwicke.md', ['Thornwicke'])];
    const findings = scanSearchIndex({ outDir: finalOut, campaign: 'unit', withheld });
    const hit = findings.find((f) => f.data && f.data.hiddenName === 'Thornwicke');
    assert.ok(hit, `expected a finding for "Thornwicke", got: ${JSON.stringify(findings)}`);
    assert.equal(hit.severity, 'error');
    assert.equal(hit.id, 'leak/l4-index-term');
    assert.deepEqual(hit.data.documentRefs, ['locations/old-watch.html'], 'documentRefs must be the published page\'s href, not a base-36 ref');
    assert.equal(hit.data.unmappedRefs, 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-18: an unrecognised serialised pipeline gives exactly one WARN and interprets no terms', () => {
  const json = {
    index: { version: pinned.LUNR_VERSION, fields: [], fieldVectors: [], invertedIndex: [['tanmora', {}]], pipeline: ['stemmer'] },
    documents: {},
  };
  const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
  withScratchIndexFile(json, (outDir) => {
    const findings = scanSearchIndex({ outDir, campaign: 'unit', withheld });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn');
    assert.equal(findings[0].id, 'leak/l4-index-term');
    assert.deepEqual(findings[0].data.serialisedPipeline, ['stemmer']);
  });
});

// --- AC-D2-09: lunr identity -------------------------------------------------

test('AC-D2-09: pinned.lunr is the exact bundled copy the generator itself resolves (generator identity)', () => {
  // FR-17/SD-17: v1.11.40 bundles its own lunr inside gm-apprentice-publish/node_modules -- it is
  // no longer hoisted to a top-level node_modules/lunr. The facade's `lunr` must be the same
  // resolved module the generator's own lib/search-index.js would get.
  const fromGenerator = require.resolve('lunr', {
    paths: [path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish', 'lib')],
  });
  // eslint-disable-next-line global-require
  const { lunr } = require('../src/generator/pinned');
  assert.equal(lunr, require(fromGenerator));
});

test('AC-D2-09: lunr is not a direct dependency in package.json; pkg.assets embeds the nested bundled path', () => {
  const pkg = require('../package.json');
  assert.ok(!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'lunr'));
  assert.ok(
    pkg.pkg.assets.includes('node_modules/gm-apprentice-publish/node_modules/lunr/lunr.js'),
    'the bundled lunr.js must be packaged as an asset via its nested path',
  );
});
