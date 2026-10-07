'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { MARKERS } = require('../scripts/content-markers');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'redaction-coc-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'redaction-coc-vault-site-config.json');
const COC_MARKERS = MARKERS.find((m) => m.id === 'coc-skills-data').strings;

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-redaction-coc-'));
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

function buildSiteConfig(dir) {
  const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  siteConfig.vaultPath = FIXTURE;
  siteConfig.outputDir = path.join(dir, 'out');
  return siteConfig;
}

// -- AC-R3 (CoC side): the protected build path renders the fixture's own skill rows and ships
// no CoC marker (the canonical starting skill list). --

test('build --force against the CoC fixture renders the sheet\'s own skills and ships no CoC marker', () => {
  withTmpDir((dir) => {
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
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.envelope.ok, true, result.human);

    const htmlFiles = walkFiles(outDir).filter((f) => f.endsWith('.html'));
    assert.ok(htmlFiles.length > 0, 'expected at least one built HTML file');

    const hits = [];
    for (const file of htmlFiles) {
      const text = fs.readFileSync(file, 'utf8');
      for (const marker of COC_MARKERS) {
        if (text.includes(marker)) hits.push({ file, marker });
      }
    }
    assert.deepEqual(hits, [], `built site must ship no CoC marker: ${JSON.stringify(hits)}`);

    // Degrade, don't refuse: the skill rows present are exactly the fixture's own sheet, no
    // canonical baseline rows the user never wrote.
    const investigatorHtml = fs.readFileSync(path.join(outDir, 'characters', 'pcs', 'investigator.html'), 'utf8');
    assert.match(investigatorHtml, /Bookbinding/, "expected the fixture PC's own skill row to still render");
    assert.match(investigatorHtml, /Ratcatching/, "expected the fixture PC's own skill row to still render");

    // The build reports the degradation.
    assert.match(result.human, /rules-content redaction/);
    const cocEntry = result.envelope.redactions.find((r) => r.id === 'coc-skills-data');
    assert.ok(cocEntry, 'expected a coc-skills-data entry in the redactions envelope');
    assert.ok(cocEntry.calls > 0, 'expected the canonical skill list to have been read at least once');
  });
});

// -- AC-R9 / NFR-03: two builds of an unchanged CoC vault report identical `redactions`. --

test('two builds of the unchanged CoC fixture report identical redactions', () => {
  withTmpDir((dir) => {
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
    const { runBuildCommand } = require('../src/cli/build');
    const a = runBuildCommand({ config: configPath, force: true }, 'fixture');
    const b = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(a.envelope.ok, true, a.human);
    assert.equal(b.envelope.ok, true, b.human);
    assert.deepEqual(a.envelope.redactions, b.envelope.redactions);
  });
});

// -- AC-R3's required negative proof (CoC side). See test/redaction-gurps-build.test.js's control
// test for the full rationale: raw, unprotected generator build in a child process, deliberately
// bypassing applyRedactions()/bootstrap.js. --

test('control: the same fixture built via the raw, unprotected generator DOES leak CoC markers (proves the assertions above have teeth)', () => {
  withTmpDir((dir) => {
    const siteConfig = buildSiteConfig(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(siteConfig, null, 2));

    const script = `
      const { build } = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'gm-apprentice-publish'))});
      build({ configPath: ${JSON.stringify(configPath)} });
    `;
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, stdio: 'pipe' });

    const outDir = siteConfig.outputDir;
    const htmlFiles = walkFiles(outDir).filter((f) => f.endsWith('.html'));
    let found = false;
    for (const file of htmlFiles) {
      const text = fs.readFileSync(file, 'utf8');
      if (COC_MARKERS.some((marker) => text.includes(marker))) {
        found = true;
        break;
      }
    }
    assert.ok(found, 'control build (no applyRedactions()) unexpectedly shipped no CoC marker — the fixture no longer exercises the redaction');
  });
});
