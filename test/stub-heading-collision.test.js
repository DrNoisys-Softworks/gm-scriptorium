'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Issue #100. On a `publish: stub` page, the pinned generator's keepOnlySections
 * (lib/processor.js, called at lib/build.js:520 and :526) keeps any heading whose TEXT matches an
 * include entry, wherever it sits in the tree, so `### Appearance` under the withheld
 * `## GM Notes` was published (the parent heading is gone by the time filterSections runs). The fix
 * is Scriptorium's guarded wrapper in src/generator/pinned.js; this is the real-build proof across
 * every surface fed from the page: HTML, search-index.json, backlinks.
 *
 * Sentinels are single lowercase words with a shared "sentinel" ending because search-index.json is
 * a lunr index (lowercased, stemmed); identical morphology keeps the positive controls honest.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'stub-heading-collision-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'stub-heading-collision-vault-site-config.json');

const LEAKS = ['stubleaksentinel', 'stubhushsentinel', 'stubplansentinel', 'keepernestedsentinel'];
const DROPPED = ['stubpreamblesentinel', 'stubdroppedsentinel'];
const PUBLISHED = ['publishedappearancesentinel', 'keeperappearancesentinel'];

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function buildFixture(dir) {
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  delete siteConfig.vaultPath;
  delete siteConfig.outputDir;
  const siteConfigPath = path.join(siteDir, 'vault.config.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfig, null, 2));
  const outDir = path.join(dir, 'out');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]', `vault = '${FIXTURE}'`, `site_config = '${siteConfigPath}'`, `output = '${outDir}'`].join('\n'),
  );
  delete require.cache[require.resolve('../src/cli/build')];
  // eslint-disable-next-line global-require
  const { runBuildCommand } = require('../src/cli/build');
  return { result: runBuildCommand({ config: configPath, force: true }, 'fixture'), outDir };
}

test('#100: a GM Notes sub-heading that matches a stub include entry reaches no built surface', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-stub-collision-'));
  try {
    const { result, outDir } = buildFixture(dir);
    assert.equal(result.envelope.ok, true, result.human);

    const htmlFiles = walkFiles(outDir).filter((f) => f.endsWith('.html'));
    assert.ok(htmlFiles.length > 0);
    const hits = [];
    for (const f of htmlFiles) {
      const text = fs.readFileSync(f, 'utf8').toLowerCase();
      for (const s of [...LEAKS, ...DROPPED]) if (text.includes(s)) hits.push(`${path.relative(outDir, f)}: ${s}`);
    }
    assert.deepEqual(hits, [], 'withheld or dropped stub text reached built HTML');

    const index = fs.readFileSync(path.join(outDir, 'search-index.json'), 'utf8').toLowerCase();
    for (const s of [...LEAKS, ...DROPPED]) assert.ok(!index.includes(s), `${s} reached search-index.json`);

    // Backlinks: the Cellar is linked ONLY from the withheld sub-heading.
    const cellar = fs.readFileSync(path.join(outDir, 'locations', 'cellar.html'), 'utf8');
    assert.ok(!cellar.includes('Mentioned In'), 'Cellar gained a backlink from withheld stub text');
    assert.ok(!cellar.includes('sentry.html'), 'Cellar links back to the Sentry from withheld text');

    // Positive controls: the stub body that IS included is still published, in HTML and search.
    const sentry = fs.readFileSync(path.join(outDir, 'characters', 'npcs', 'sentry.html'), 'utf8').toLowerCase();
    const keeper = fs.readFileSync(path.join(outDir, 'characters', 'npcs', 'keeper.html'), 'utf8').toLowerCase();
    assert.ok(sentry.includes(PUBLISHED[0]), 'included stub section missing from its HTML: the negatives prove nothing');
    assert.ok(keeper.includes(PUBLISHED[1]), 'included stub section missing from its HTML: the negatives prove nothing');
    for (const s of PUBLISHED) assert.ok(index.includes(s), `${s} missing from search-index.json`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
