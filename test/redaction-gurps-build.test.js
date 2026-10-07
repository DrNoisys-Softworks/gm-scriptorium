'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { MARKERS } = require('../scripts/content-markers');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'redaction-gurps-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'redaction-gurps-vault-site-config.json');
const GURPS_MARKERS = MARKERS.find((m) => m.id === 'gurps-reference').strings;

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-redaction-gurps-'));
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

// -- AC-R3: the protected build path (Scriptorium's own runBuildCommand, which runs
// applyRedactions() through bootstrap.js) renders the combat tab but ships no GURPS marker. --

test('build --force against the GURPS fixture renders gurps-combat and ships no GURPS marker', () => {
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

    let sawGurpsCombat = false;
    const hits = [];
    for (const file of htmlFiles) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('gurps-combat')) sawGurpsCombat = true;
      for (const marker of GURPS_MARKERS) {
        if (text.includes(marker)) hits.push({ file, marker });
      }
    }
    assert.ok(sawGurpsCombat, 'expected some built HTML to contain "gurps-combat" (proves the GURPS renderer ran)');
    assert.deepEqual(hits, [], `built site must ship no GURPS marker: ${JSON.stringify(hits)}`);

    // Degrade, don't refuse (Structural decision D2): the user's own melee/ranged/defence rows
    // still render even though the upstream reference appendix is gone.
    const heroHtml = fs.readFileSync(path.join(outDir, 'characters', 'pcs', 'hero.html'), 'utf8');
    assert.match(heroHtml, /Broadsword/, 'expected the fixture PC\'s own melee row to still render');
    assert.match(heroHtml, /Crossbow/, 'expected the fixture PC\'s own ranged row to still render');
    assert.doesNotMatch(heroHtml, /rules-ref/, 'the redacted reference appendix wrapper must not render');
    assert.doesNotMatch(heroHtml, /ref-table/, 'the redacted reference appendix tables must not render');

    // The build reports the degradation (Structural decision D3): the CLI's human summary and
    // --json envelope both carry it.
    assert.match(result.human, /rules-content redaction/);
    const gurpsEntry = result.envelope.redactions.find((r) => r.id === 'gurps-reference');
    assert.ok(gurpsEntry, 'expected a gurps-reference entry in the redactions envelope');
    assert.ok(gurpsEntry.calls > 0, 'expected renderReference() to have been called at least once');
  });
});

// -- AC-R9 / NFR-03: two builds of an unchanged GURPS vault report identical `redactions`. --

test('two builds of the unchanged GURPS fixture report identical redactions', () => {
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

// -- AC-R3's required negative proof: without applyRedactions(), the same fixture DOES leak the
// markers. Run in a child process, deliberately bypassing Scriptorium's bootstrap layer (raw
// require('gm-apprentice-publish').build()) rather than the app's own applyRedactions()/bootstrap
// path, so this process's require.cache can never collide with the protected build's own cache
// seeding above. This is the proof the brief requires: "Both must fail if applyRedactions() is
// commented out; prove that and record it." --

test('control: the same fixture built via the raw, unprotected generator DOES leak GURPS markers (proves the assertions above have teeth)', () => {
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
      if (GURPS_MARKERS.some((marker) => text.includes(marker))) {
        found = true;
        break;
      }
    }
    assert.ok(found, 'control build (no applyRedactions()) unexpectedly shipped no GURPS marker — the fixture no longer exercises the redaction');
  });
});
