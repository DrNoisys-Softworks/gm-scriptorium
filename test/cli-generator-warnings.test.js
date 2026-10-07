'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Issue #30: the pinned generator reports degraded output through console.warn. A successful
 * build used to drop those lines. These tests build a tiny synthetic vault through the real
 * `build` command and check what reaches the human output and the --json envelope.
 */

const FONT_FAMILY = 'Scriptorium Test Face';

function withScratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-genwarn-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A one-page vault (+ optionally a page in a folder the site config does not map). */
function makeCampaign(dir, { selfHostFont = false, unmapped = false, scaffold = false, extra = {} } = {}) {
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'Locations'), { recursive: true });
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  // All settings live in the vault's own publish: block, so the site config carries none of the
  // legacy campaign settings that make the generator warn on every build.
  const publish = [
    'publish:',
    '  mode: player',
    '  folder_map:',
    '    Locations: locations',
    '  exclude_dirs: ["_meta"]',
  ];
  if (selfHostFont) publish.push('  theme:', '    fonts:', '      source: self-host', `      heading: "${FONT_FAMILY}"`);
  fs.writeFileSync(
    path.join(vault, '_meta', 'vault-config.md'),
    `---\ntype: meta\n${publish.join('\n')}\n---\n\nSynthetic.\n`,
  );
  fs.writeFileSync(path.join(vault, 'Locations', 'Town.md'), '---\ntype: location\ntitle: Town\n---\n\nA town.\n');
  if (unmapped) {
    fs.mkdirSync(path.join(vault, 'Stray'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Stray', 'Page.md'), '---\ntype: location\ntitle: Page\n---\n\nStray.\n');
  }
  const siteConfig = { vaultPath: vault, outputDir: './site-out', folderMap: {}, excludeDirs: [] };
  if (scaffold) {
    // The shape `init` writes into every scaffolded campaign (src/cli/init.js).
    Object.assign(siteConfig, {
      siteTitle: 'T',
      landingTagline: 'x',
      attachmentsDir: '_attachments',
      excludeSections: ['GM Notes'],
      excludeCallouts: false,
      backend: { statusBar: false, inbox: false },
    });
  }
  Object.assign(siteConfig, extra);
  const siteConfigPath = path.join(dir, 'site.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfig));
  const out = path.join(dir, 'out');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      'default_campaign = "t"',
      '',
      '[campaigns.t]',
      `vault = '${vault}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${out}'`,
    ].join('\n'),
  );
  return { configPath, out, vault };
}

function runBuild(configPath) {
  const { runBuildCommand } = require('../src/cli/build');
  return runBuildCommand({ config: configPath, 'no-check': true }, 't');
}

function listFiles(root) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else found.push(full);
    }
  })(root);
  return found;
}

test('a self-host font missing from the cache: the warning shows in human output and in the JSON envelope', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { selfHostFont: true });
    const result = runBuild(configPath);
    assert.equal(result.exitCode, 0);
    const warnings = result.envelope.generatorWarnings;
    assert.ok(Array.isArray(warnings));
    const fontLines = warnings.filter((l) => l.includes(FONT_FAMILY));
    assert.equal(fontLines.length, 1, JSON.stringify(warnings));
    assert.ok(fontLines[0].startsWith('WARNING: font "'), 'leading whitespace is trimmed');
    assert.match(fontLines[0], /not in the vault's font cache/);

    const lines = result.human.split('\n');
    const builtIdx = lines.findIndex((l) => l.startsWith('built '));
    const countIdx = lines.findIndex((l) => l === `${warnings.length} generator warning(s):`);
    assert.ok(builtIdx >= 0 && countIdx === builtIdx + 1, 'count line follows the built line');
    for (let i = 0; i < warnings.length; i++) assert.equal(lines[countIdx + 1 + i], warnings[i]);
  });
});

test('a zero-warning build prints exactly what it printed before, and carries an empty generatorWarnings', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir);
    const result = runBuild(configPath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.envelope.generatorWarnings, []);
    const lines = result.human.split('\n');
    assert.equal(lines[0].startsWith('--no-check'), true);
    assert.match(lines[1], /^built \d+ file\(s\) in [\d.]+ms -> /);
    // every other line is a known Scriptorium line, never a generator one
    for (const l of lines.slice(2)) assert.match(l, /^(wrote NOTICE\.txt |warning: 1 page\(s\) in "Locations")/);
  });
});

test('a freshly scaffolded site config prints no generator warning block, human or JSON', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { scaffold: true });
    const result = runBuild(configPath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.envelope.generatorWarnings, []);
    assert.doesNotMatch(result.human, /generator warning|migrate\.py|old name/);
  });
});

test('an unknown key in the site config keeps the legacy-settings line', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { scaffold: true, extra: { excludeFields: ['secrets'] } });
    const result = runBuild(configPath);
    const legacy = result.envelope.generatorWarnings.filter((l) => l.includes('still holds campaign settings'));
    assert.equal(legacy.length, 1, JSON.stringify(result.envelope.generatorWarnings));
    assert.match(legacy[0], /excludeFields/);
    assert.match(result.human, /1 generator warning\(s\):/);
  });
});

test('a backend flag that is not false keeps its old-name line', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { scaffold: true, extra: { backend: { statusBar: true, inbox: false } } });
    const result = runBuild(configPath);
    const w = result.envelope.generatorWarnings;
    assert.ok(w.some((l) => l.includes('backend.statusBar is an old name')), JSON.stringify(w));
    assert.equal(w.some((l) => l.includes('backend.inbox is an old name')), false);
  });
});

test('the font warning still shows next to a scaffolded config, and only it', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { scaffold: true, selfHostFont: true });
    const result = runBuild(configPath);
    const w = result.envelope.generatorWarnings;
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /^WARNING: font "Scriptorium Test Face" is not in the vault's font cache/);
    assert.match(result.human, /\n1 generator warning\(s\):\nWARNING: font /);
  });
});

test('an unmapped folder is reported once, by Scriptorium, not also by the generator', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { unmapped: true });
    const result = runBuild(configPath);
    assert.equal(result.exitCode, 0);
    const mentions = result.human.split('\n').filter((l) => l.includes('"Stray"'));
    assert.equal(mentions.length, 1, result.human);
    assert.match(mentions[0], /^warning: 1 page\(s\) in "Stray" were not published/);
    assert.equal(result.envelope.generatorWarnings.filter((l) => l.includes('Stray')).length, 0);
    assert.doesNotMatch(result.human, /vault-config\.md/);
  });
});

test('generatorWarnings is deterministic across builds and never carries the staging path', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir, { selfHostFont: true, unmapped: true });
    const first = runBuild(configPath);
    const second = runBuild(configPath);
    assert.ok(first.envelope.generatorWarnings.length > 0);
    assert.deepEqual(first.envelope.generatorWarnings, second.envelope.generatorWarnings);
    for (const l of first.envelope.generatorWarnings) assert.doesNotMatch(l, /scriptorium-build|\.scriptorium-build/);
  });
});

test('warnings never reach the published site', () => {
  withScratch((dir) => {
    const { configPath, out } = makeCampaign(dir, { selfHostFont: true });
    const result = runBuild(configPath);
    const marker = "not in the vault's font cache";
    assert.ok(result.envelope.generatorWarnings.some((l) => l.includes(marker)));
    for (const f of listFiles(out)) {
      assert.equal(fs.readFileSync(f).includes(marker), false, `${f} carries a generator warning`);
    }
  });
});

test('refusal envelopes are unchanged: no generatorWarnings key', () => {
  withScratch((dir) => {
    const { configPath } = makeCampaign(dir);
    // a pre-build check error refuses: a page with a non-YAML frontmatter fence is not forceable
    const { runBuildCommand } = require('../src/cli/build');
    fs.writeFileSync(path.join(dir, 'vault', 'Locations', 'Bad.md'), '---toml\ntype = "location"\n---\n\nx\n');
    const result = runBuildCommand({ config: configPath }, 't');
    assert.equal(result.exitCode, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(result.envelope, 'generatorWarnings'), false);
  });
});

test('generatorWarningLines keeps warn-level lines only, trims indentation, and rewrites the staging path', () => {
  const { generatorWarningLines } = require('../src/build/run');
  const paths = { stagingRoot: '/work/.scriptorium-build-AbC123', stagingOut: '/work/.scriptorium-build-AbC123/site', finalOut: '/work/out' };
  const detail = [
    { level: 'log', text: '  self-hosted font "X": 2 face(s) cached' },
    { level: 'error', text: 'a non-render error stays hidden' },
    { level: 'warn', text: '  WARNING: plain line' },
    { level: 'warn', text: `  WARNING: wrote ${paths.stagingOut}/fonts and ${paths.stagingRoot}/cfg.json` },
  ];
  assert.deepEqual(generatorWarningLines(detail, paths), [
    'WARNING: plain line',
    'WARNING: wrote /work/out/fonts and <staging>/cfg.json',
  ]);
  assert.deepEqual(generatorWarningLines([], paths), []);
  assert.deepEqual(generatorWarningLines(undefined, paths), []);
});
