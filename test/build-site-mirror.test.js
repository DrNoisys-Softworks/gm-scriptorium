'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SITE_RELATIVE_INPUTS, mirrorSiteInputs } = require('../src/build/stage');

const ROOT = path.join(__dirname, '..');
const GENERATOR_DIR = path.join(ROOT, 'node_modules', 'gm-apprentice-publish');
const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-site-mirror-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- 1. mirrorSiteInputs copies css/overrides.css byte-equal; copies nothing when absent --

test('mirrorSiteInputs copies css/overrides.css byte-equal', () => {
  withTmpDir((dir) => {
    const siteDir = path.join(dir, 'site');
    const stagingRoot = path.join(dir, 'staging');
    fs.mkdirSync(path.join(siteDir, 'css'), { recursive: true });
    const content = '.marker { color: red; }\n';
    fs.writeFileSync(path.join(siteDir, 'css', 'overrides.css'), content);

    const copied = mirrorSiteInputs(siteDir, stagingRoot);

    assert.deepEqual(copied, ['css/overrides.css']);
    const stagedContent = fs.readFileSync(path.join(stagingRoot, 'css', 'overrides.css'), 'utf8');
    assert.equal(stagedContent, content);
  });
});

test('mirrorSiteInputs copies nothing when none of SITE_RELATIVE_INPUTS exist', () => {
  withTmpDir((dir) => {
    const siteDir = path.join(dir, 'site');
    const stagingRoot = path.join(dir, 'staging');
    fs.mkdirSync(siteDir, { recursive: true });

    const copied = mirrorSiteInputs(siteDir, stagingRoot);

    assert.deepEqual(copied, []);
    assert.equal(fs.existsSync(stagingRoot), false);
  });
});

// -- 2. backend-flag parity: mirrored staging root vs the real site dir, for three scenarios --

test('the pin\'s backend detection sees the same result against a mirrored staging root as against the real site dir', () => {
  // test-only require of the pinned generator's own module, per the brief's interface spec.
  // publish-v1.12.0 deleted resolveBackendFlags: detection no longer turns a live feature on (the
  // publish.live_stats / publish.inbox switches do), but lib/build.js still calls these three
  // against configDir, to decide whether a switched-on feature has a KV store wired and to warn
  // when a deployed backend has no switch set.
  const { hasRealKvId, detectInbox, detectStatusBar } = require('gm-apprentice-publish/lib/backend-flags');
  const detect = (dir) => ({ kv: hasRealKvId(dir), inbox: detectInbox(dir), statusBar: detectStatusBar(dir) });

  const scenarios = [
    { name: 'no wrangler.toml, no functions', build: () => {} },
    {
      name: 'real KV id',
      build: (siteDir) => {
        fs.mkdirSync(path.join(siteDir, 'functions', 'api'), { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'functions', 'api', 'request.js'), '// request\n');
        fs.writeFileSync(path.join(siteDir, 'functions', 'api', 'loadout.js'), '// loadout\n');
        fs.writeFileSync(
          path.join(siteDir, 'wrangler.toml'),
          '[[kv_namespaces]]\nbinding = "INBOX"\nid = "abc123realid"\n',
        );
      },
    },
    {
      name: 'placeholder KV id',
      build: (siteDir) => {
        fs.mkdirSync(path.join(siteDir, 'functions', 'api'), { recursive: true });
        fs.writeFileSync(path.join(siteDir, 'functions', 'api', 'request.js'), '// request\n');
        fs.writeFileSync(path.join(siteDir, 'functions', 'api', 'loadout.js'), '// loadout\n');
        fs.writeFileSync(
          path.join(siteDir, 'wrangler.toml'),
          '[[kv_namespaces]]\nbinding = "INBOX"\nid = "PUT-YOUR-KV-NAMESPACE-ID-HERE"\n',
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    withTmpDir((dir) => {
      const siteDir = path.join(dir, 'site');
      const stagingRoot = path.join(dir, 'staging');
      fs.mkdirSync(siteDir, { recursive: true });
      scenario.build(siteDir);

      mirrorSiteInputs(siteDir, stagingRoot);
      fs.mkdirSync(stagingRoot, { recursive: true });

      const viaSiteDir = detect(siteDir);
      const viaStagingRoot = detect(stagingRoot);
      assert.deepEqual(viaStagingRoot, viaSiteDir, `scenario "${scenario.name}" diverged`);
    });
  }
});

// -- 3. change detector: SITE_RELATIVE_INPUTS still matches the pin's own configDir/siteDir joins --

function extractLiteralJoins(source, varName) {
  const re = new RegExp(`path\\.join\\(\\s*${varName}\\s*,\\s*([^)]+)\\)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    const argsText = m[1];
    // Only literal string arguments (comma-separated 'a', 'b', 'c'); skip anything with an
    // identifier/expression argument, since those are not a fixed literal input path.
    const parts = argsText.split(',').map((s) => s.trim());
    const literals = [];
    let allLiteral = true;
    for (const part of parts) {
      const lm = part.match(/^(['"])((?:(?!\1).)*)\1$/);
      if (!lm) {
        allLiteral = false;
        break;
      }
      literals.push(lm[2]);
    }
    if (allLiteral && literals.length > 0) {
      out.push(literals.join('/').split('/').filter(Boolean).join('/'));
    }
  }
  return out;
}

test('SITE_RELATIVE_INPUTS matches the literal configDir/siteDir joins in the pin\'s lib/build.js and lib/backend-flags.js', () => {
  const buildSource = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'build.js'), 'utf8');
  const backendFlagsSource = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'backend-flags.js'), 'utf8');

  const fromBuild = extractLiteralJoins(buildSource, 'configDir');
  const fromBackendFlags = extractLiteralJoins(backendFlagsSource, 'siteDir');

  const discovered = [...new Set([...fromBuild, ...fromBackendFlags])].sort();
  const expected = [...SITE_RELATIVE_INPUTS].sort();

  assert.deepEqual(
    discovered,
    expected,
    'a future pin changed its configDir/siteDir-relative inputs; update SITE_RELATIVE_INPUTS in src/build/stage.js',
  );

  // 8 at publish-v1.12.0 (was 6): build.js:86 `hasRealKvId(configDir)` and build.js:1339-1340
  // `detectStatusBar(configDir)` / `detectInbox(configDir)` replace the one `resolveBackendFlags`
  // call. All three read the same wrangler.toml and functions/api files already in
  // SITE_RELATIVE_INPUTS (the deepEqual above confirms the discovered join set is unchanged). The
  // other five are the config-relative path resolution, css/overrides.css and the default_mode
  // storage key.
  const configDirCount = (buildSource.match(/\bconfigDir\b/g) || []).length;
  assert.equal(configDirCount, 8, `expected configDir to appear exactly 8 times in lib/build.js, found ${configDirCount}`);
});

// -- 4. end to end: runBuildCommand --force with a tmp site config whose dir holds css/overrides.css --

test('build --force mirrors css/overrides.css into the built site, linked from index.html, alongside lunr.js', () => {
  withTmpDir((dir) => {
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(path.join(siteDir, 'css'), { recursive: true });
    const overridesContent = '.marker-e2e { color: blue; }\n';
    fs.writeFileSync(path.join(siteDir, 'css', 'overrides.css'), overridesContent);

    const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
    delete siteConfig.vaultPath; // vault comes from the campaign's own `vault` field, not this
    delete siteConfig.outputDir; // overwritten by staging regardless
    const siteConfigPath = path.join(siteDir, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfig, null, 2));

    const outDir = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    const toml = [
      'config_version = 1',
      'default_campaign = "fixture"',
      '',
      '[campaigns.fixture]',
      `vault = '${MINI_VAULT}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${outDir}'`,
    ].join('\n');
    fs.writeFileSync(configPath, toml);

    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.envelope.ok, true, result.human);

    const builtOverrides = fs.readFileSync(path.join(outDir, 'css', 'overrides.css'), 'utf8');
    assert.equal(builtOverrides, overridesContent);

    const indexHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('css/overrides.css'), 'index.html must link css/overrides.css');

    assert.equal(fs.existsSync(path.join(outDir, 'js', 'lunr.js')), true);
  });
});
