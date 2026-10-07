'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * SD-1 / ADR 0013, end to end through Scriptorium's own build command.
 * Retired (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md,
 * SD-3): the patch module and its unit file (formerly
 * test/section-filter-patch.test.js) are gone at this pin -- upstream's own
 * lib/processor.js now guards the exclude-level assignment with
 * `if (!excluding && ...)`, confirmed by hand against 78696167. This file
 * stays as the real-build regression proof that the *pin itself*, unpatched,
 * now gets the nested-exclusion case right: the page HTML, search-index.json,
 * and the "Mentioned In" backlink sidebar, all fed from
 * `page.publishedMarkdown` (lib/build.js:345 -> publishedSource,
 * lib/processor.js:498-501).
 *
 * Idiom copied from test/redaction-gurps-build.test.js: temp dir, the fixture
 * vault plus its site-config JSON, a generated config.toml, a require.cache
 * bust on src/cli/build, and runBuildCommand({ config, force: true }).
 *
 * SENTINEL SHAPE, deliberately. Both sentinels are single lowercase
 * alphabetic words with the same `...sentinel` ending, because
 * search-index.json is a lunr index: its body field is lowercased, trimmed
 * and Porter-stemmed (lib/search-index.js:36-56). Giving the leak sentinel
 * and the positive-control sentinel identical morphology means the pipeline
 * cannot mangle one without mangling the other, so the positive control fails
 * loudly rather than letting the negative pass vacuously.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'nested-exclude-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'nested-exclude-vault-site-config.json');

// Lives only under `### Rumours In Play`, a sibling of the nested excluded
// `### Needs`, itself inside the excluded `## GM Notes`.
const LEAK_SENTINEL = 'nestedleaksentinel';
// Lives in the page's ordinary published body, above any excluded heading.
const PUBLISHED_SENTINEL = 'publishedbodysentinel';

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-nested-exclude-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function buildFixtureSite(dir) {
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  delete siteConfig.vaultPath;
  delete siteConfig.outputDir;
  const siteConfigPath = path.join(siteDir, 'vault.config.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfig, null, 2));

  const outDir = path.join(dir, 'out');
  const configPath = path.join(dir, 'config.toml');
  const toml = [
    'config_version = 1',
    'default_campaign = "fixture"',
    '',
    '[campaigns.fixture]',
    `vault = '${FIXTURE}'`,
    `site_config = '${siteConfigPath}'`,
    `output = '${outDir}'`,
  ].join('\n');
  fs.writeFileSync(configPath, toml);

  delete require.cache[require.resolve('../src/cli/build')];
  // eslint-disable-next-line global-require
  const { runBuildCommand } = require('../src/cli/build');
  const result = runBuildCommand({ config: configPath, force: true }, 'fixture');
  return { result, outDir };
}

test('a nested excluded heading\'s sibling reaches no built surface: HTML, search index, or backlinks', () => {
  withTmpDir((dir) => {
    const { result, outDir } = buildFixtureSite(dir);
    assert.equal(result.envelope.ok, true, result.human);

    const htmlFiles = walkFiles(outDir).filter((f) => f.endsWith('.html'));
    assert.ok(htmlFiles.length > 0, 'expected at least one built HTML file');

    // -- 1. No .html carries the nested region --
    const htmlHits = [];
    for (const file of htmlFiles) {
      const text = fs.readFileSync(file, 'utf8').toLowerCase();
      if (text.includes(LEAK_SENTINEL)) htmlHits.push(path.relative(outDir, file));
      if (text.includes('rumours in play')) htmlHits.push(`${path.relative(outDir, file)} (heading)`);
    }
    assert.deepEqual(htmlHits, [], `the nested excluded region reached built HTML: ${htmlHits.join(', ')}`);

    // -- 2. Nowhere in search-index.json (lib/build.js:539) --
    const searchIndexPath = path.join(outDir, 'search-index.json');
    assert.ok(fs.existsSync(searchIndexPath), 'expected search-index.json at the output root');
    const searchIndex = fs.readFileSync(searchIndexPath, 'utf8').toLowerCase();
    assert.ok(
      !searchIndex.includes(LEAK_SENTINEL),
      'the nested excluded region reached search-index.json (lib/build.js:345 -> publishedSource -> lib/search-index.js)',
    );

    // -- 3. No "Mentioned In" backlink on the entity linked only from the
    //       nested region. The Grotto is wiki-linked ONLY from inside
    //       `### Rumours In Play`. --
    const grottoPath = path.join(outDir, 'locations', 'grotto.html');
    assert.ok(fs.existsSync(grottoPath), 'expected locations/grotto.html to be built');
    const grottoHtml = fs.readFileSync(grottoPath, 'utf8');
    assert.ok(
      !grottoHtml.includes('Mentioned In'),
      'Grotto gained a "Mentioned In" backlink from a link that lives only inside an excluded section',
    );
    assert.ok(!grottoHtml.includes('warden.html'), 'Grotto links back to the Warden from an excluded-only mention');

    // -- 4. Positive controls, so none of the above can pass vacuously --
    const wardenPath = path.join(outDir, 'characters', 'npcs', 'warden.html');
    assert.ok(fs.existsSync(wardenPath), 'expected characters/npcs/warden.html to be built');
    const wardenHtml = fs.readFileSync(wardenPath, 'utf8').toLowerCase();
    assert.ok(
      wardenHtml.includes(PUBLISHED_SENTINEL),
      'the page\'s ordinary published body is missing from its own HTML — the negatives above prove nothing',
    );
    assert.ok(wardenHtml.includes('public bio'), 'the published section after the excluded region is missing');
    assert.ok(
      searchIndex.includes(PUBLISHED_SENTINEL),
      'the page\'s ordinary published body is missing from search-index.json — the search-index negative proves nothing',
    );

    // The backlink machinery itself works in this fixture: the Shrine is
    // wiki-linked from the Warden's PUBLISHED body and does get its sidebar.
    const shrinePath = path.join(outDir, 'locations', 'shrine.html');
    assert.ok(fs.existsSync(shrinePath), 'expected locations/shrine.html to be built');
    const shrineHtml = fs.readFileSync(shrinePath, 'utf8');
    assert.ok(
      shrineHtml.includes('Mentioned In'),
      'the Shrine lost its backlink sidebar — backlinks are not working in this fixture, so the Grotto negative proves nothing',
    );
    assert.ok(shrineHtml.includes('warden.html'), 'expected the Shrine\'s backlink sidebar to link the Warden');
  });
});
