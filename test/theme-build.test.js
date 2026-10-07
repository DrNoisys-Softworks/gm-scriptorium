'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { execFileSync } = require('child_process');

const { runAtomicBuild } = require('../src/build/run');
const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand, resolveVaultContext } = require('../src/cli/check');
const { runStatusCommand } = require('../src/cli/status');
const { planThemeAssets } = require('../src/build/themeassets');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

/*
 * ADR 0019: integration tests, exercising planThemeAssets/writeThemeAssets through the real
 * CLI commands (check/build/status) and through runAtomicBuild directly. Convention-pack mode
 * (<vault>/_meta/scriptorium/) unless noted; B3 is the legacy site_config exception. Synthetic
 * names only (NFR-08).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-build-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

// Copied from test/build-output-gate.test.js:81-99.
function sha256Manifest(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else entries.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir, '');
  return entries.sort().join('\n');
}

function siblingDirs(finalOut) {
  const parent = path.dirname(finalOut);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((e) => /^\.scriptorium-(build|old)-/.test(e));
}

/** A small, real vault + convention pack (or legacy site dir) that builds successfully. */
function buildThemeVault(root, opts = {}) {
  const { excludeDirs = ['_meta'], folderMap = { NPCs: 'npcs' }, publishExcludeDirs = [], convention = true, campaign = 'alpha' } = opts;

  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, 'NPCs'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });

  const publishBlock = publishExcludeDirs.length
    ? `  exclude_dirs:\n${publishExcludeDirs.map((d) => `    - ${d}`).join('\n')}\n`
    : '';
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    `---\ntype: meta\npublish:\n  mode: player\n${publishBlock}---\n\n# Vault config\n`,
  );
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n',
  );
  fs.writeFileSync(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public Page\n---\nAn ordinary published page.\n');
  fs.writeFileSync(path.join(vaultPath, '_attachments', 'ground.webp'), Buffer.from('ground-image-bytes'));

  const siteDir = convention ? path.join(vaultPath, '_meta', 'scriptorium') : path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const jsonConfig = { siteTitle: 'Theme Vault', siteUrl: 'https://example.invalid', attachmentsDir: '_attachments', excludeDirs, folderMap };
  fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(jsonConfig, null, 2));

  const finalOut = path.join(root, 'out');
  return { vaultPath, siteDir, jsonConfig, finalOut, campaign };
}

function writeConfigToml(root, { vaultPath, finalOut, campaign = 'alpha', siteConfig }) {
  const configPath = path.join(root, 'config.toml');
  const lines = ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vaultPath}'`];
  if (siteConfig) lines.push(`site_config = '${siteConfig}'`);
  lines.push(`output = '${finalOut}'`, '');
  fs.writeFileSync(configPath, lines.join('\n'));
  return configPath;
}

function writePackToml(siteDir, text) {
  fs.writeFileSync(path.join(siteDir, 'pack.toml'), text);
}

function directBuild({ vaultPath, jsonConfig, siteDir, finalOut, campaign = 'alpha', themePlan }) {
  const opts = { vaultPath, userJsonConfig: { ...jsonConfig, vaultPath }, finalOut, siteDir, campaign, force: true };
  if (themePlan !== undefined) opts.themePlan = themePlan;
  return runAtomicBuild(opts);
}

function findHtmlFiles(dir) {
  const found = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) found.push(full);
    }
  })(dir);
  return found.sort();
}

// --- B1: byte-identical builds --------------------------------------------

test('B1: no-pack, plain, plain+empty-images, no-pack-with-images, and no-themePlan all give equal sha256Manifests', () => {
  withScratchDir((root) => {
    const manifests = {};

    // (a) no pack.toml
    {
      const sub = path.join(root, 'a');
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(sub);
      const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut });
      assert.equal(result.ok, true);
      manifests.a = sha256Manifest(finalOut);
    }

    // (b) theme = "plain"
    {
      const sub = path.join(root, 'b');
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(sub);
      writePackToml(siteDir, 'theme = "plain"\n');
      const packToml = { path: path.join(siteDir, 'pack.toml'), present: true, theme: 'plain', images: [], warnings: [] };
      const themePlan = planThemeAssets({ vaultPath, jsonConfig: { ...jsonConfig, vaultPath }, siteDir, packToml, campaign: 'alpha' });
      const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut, themePlan });
      assert.equal(result.ok, true);
      manifests.b = sha256Manifest(finalOut);
    }

    // (c) plain with an empty [images]
    {
      const sub = path.join(root, 'c');
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(sub);
      writePackToml(siteDir, 'theme = "plain"\n\n[images]\n');
      const packToml = { path: path.join(siteDir, 'pack.toml'), present: true, theme: 'plain', images: [], warnings: [] };
      const themePlan = planThemeAssets({ vaultPath, jsonConfig: { ...jsonConfig, vaultPath }, siteDir, packToml, campaign: 'alpha' });
      const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut, themePlan });
      assert.equal(result.ok, true);
      manifests.c = sha256Manifest(finalOut);
    }

    // (d) no pack.toml, but an images/a.png sitting in the site dir
    {
      const sub = path.join(root, 'd');
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(sub);
      fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
      fs.writeFileSync(path.join(siteDir, 'images', 'a.png'), 'x');
      const packToml = { path: path.join(siteDir, 'pack.toml'), present: false, theme: 'plain', images: [], warnings: [] };
      const themePlan = planThemeAssets({ vaultPath, jsonConfig: { ...jsonConfig, vaultPath }, siteDir, packToml, campaign: 'alpha' });
      assert.deepEqual(themePlan.files, []);
      const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut, themePlan });
      assert.equal(result.ok, true);
      manifests.d = sha256Manifest(finalOut);
    }

    // (e) runAtomicBuild called with no themePlan at all
    {
      const sub = path.join(root, 'e');
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(sub);
      const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut, themePlan: undefined });
      assert.equal(result.ok, true);
      manifests.e = sha256Manifest(finalOut);
    }

    assert.ok(manifests.a, 'sanity: (a) produced a non-empty manifest');
    for (const key of ['b', 'c', 'd', 'e']) {
      assert.equal(manifests[key], manifests.a, `(${key}) must be byte-identical to (a)`);
    }
  });
});

// --- B2: a ground slot ------------------------------------------------------

test('B2: a ground slot writes the exact bytes and CSS, links every housestyle page once, and prints no warning', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, '[images]\nground = "vault:_attachments/ground.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.doesNotMatch(result.human, /warning:/);

    const slotPath = path.join(finalOut, 'scriptorium', 'slots', 'ground.webp');
    assert.deepEqual(fs.readFileSync(slotPath), fs.readFileSync(path.join(vaultPath, '_attachments', 'ground.webp')));

    const cssPath = path.join(finalOut, 'css', 'scriptorium-theme.css');
    assert.equal(fs.readFileSync(cssPath, 'utf8'), ':root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n');

    const htmlFiles = findHtmlFiles(finalOut);
    assert.ok(htmlFiles.length > 0);
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes('data-scriptorium-housestyle')) continue;
      const themeMatches = html.match(/data-scriptorium-theme/g) || [];
      assert.equal(themeMatches.length, 1, `${file}: exactly one theme link`);
      const houseIdx = html.indexOf('data-scriptorium-housestyle');
      const themeIdx = html.indexOf('data-scriptorium-theme');
      const between = html.slice(houseIdx, themeIdx);
      assert.equal((between.match(/<link/g) || []).length, 1, `${file}: the theme link is the very next link after housestyle's`);
    }

    // (a)'s baseline envelope keys, from a no-pack build of an equivalent vault.
    const baseRoot = path.join(root, 'baseline');
    const baseVault = buildThemeVault(baseRoot);
    const baseConfig = writeConfigToml(baseRoot, { vaultPath: baseVault.vaultPath, finalOut: baseVault.finalOut, campaign: 'alpha' });
    const baseResult = runBuildCommand({ config: baseConfig, 'no-check': true }, 'alpha');
    assert.deepEqual(Object.keys(result.envelope).sort(), Object.keys(baseResult.envelope).sort());
  });
});

// --- B3: legacy site_config campaign ----------------------------------------

test('B3: a legacy site_config campaign with pack.toml in its site dir gets the slot', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root, { convention: false });
    writePackToml(siteDir, '[images]\nground = "vault:_attachments/ground.webp"\n');
    const siteConfigPath = path.join(siteDir, 'vault.config.json');
    const configPath = writeConfigToml(root, { vaultPath, finalOut, siteConfig: siteConfigPath });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
    const slotPath = path.join(finalOut, 'scriptorium', 'slots', 'ground.webp');
    assert.deepEqual(fs.readFileSync(slotPath), fs.readFileSync(path.join(vaultPath, '_attachments', 'ground.webp')));
  });
});

// --- B4: every refusal in the gate list -------------------------------------

function expectedConfigError(fn, expectedMessageOrPredicate, label, ErrorClass = VaultUnreachableError) {
  const check =
    typeof expectedMessageOrPredicate === 'function' ? expectedMessageOrPredicate : (msg) => msg === expectedMessageOrPredicate;
  assert.throws(
    fn,
    (err) => {
      assert.ok(err instanceof ErrorClass, `${label}: expected a ${ErrorClass.name} (pack problems are VaultUnreachableError, exit 3, #108), got ${err}`);
      assert.ok(check(err.message), `${label}: message mismatch: ${err.message}`);
      return true;
    },
    label,
  );
}

function runRefusalRow(t, label, { buildOpts = {}, pack, setup, expectMessage, platform }) {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root, buildOpts);
    if (pack !== undefined) writePackToml(siteDir, pack);
    if (setup) {
      const outcome = setup({ vaultPath, siteDir, root, t });
      if (outcome === 'SKIP') return;
    }

    fs.mkdirSync(finalOut, { recursive: true });
    fs.writeFileSync(path.join(finalOut, 'sentinel.txt'), 'sentinel');
    const beforeManifest = sha256Manifest(finalOut);

    const siblingDir = path.join(root, '.scriptorium-build-sentinel');
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'marker.txt'), 'x');

    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const run = () => runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha');
    if (platform) {
      withPlatform(platform, () => expectedConfigError(run, expectMessage({ vaultPath, siteDir }), label));
    } else {
      expectedConfigError(run, expectMessage({ vaultPath, siteDir }), label);
    }

    assert.equal(sha256Manifest(finalOut), beforeManifest, `${label}: finalOut must be byte-unchanged`);
    assert.ok(fs.existsSync(siblingDir), `${label}: the planted sibling sentinel must still exist (the build never started)`);
  });
}

test('B4: every refusal in the gate list', (t) => {
  const c = 'alpha';

  // -- wrong extension -> A-EXT
  runRefusalRow(t, 'wrong extension', {
    pack: '[images]\nground = "vault:_attachments/notimage.txt"\n',
    setup: ({ vaultPath }) => fs.writeFileSync(path.join(vaultPath, '_attachments', 'notimage.txt'), 'x'),
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/notimage.txt" is not an allowed image type (jpg, jpeg, png, webp, gif, svg, avif)`;
    },
  });

  // -- 10485761 bytes -> A-SIZE; 10485760 accepted --
  runRefusalRow(t, 'oversized (10485761 bytes)', {
    pack: '[images]\nground = "vault:_attachments/big.webp"\n',
    setup: ({ vaultPath }) => fs.writeFileSync(path.join(vaultPath, '_attachments', 'big.webp'), Buffer.alloc(10485761)),
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/big.webp" is 10485761 bytes, over the 10 MiB (10485760-byte) limit`;
    },
  });

  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'ok.webp'), Buffer.alloc(10485760));
    writePackToml(siteDir, '[images]\nground = "vault:_attachments/ok.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });
    const result = runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK, '10485760 bytes must be accepted');
  });

  // -- missing target -> A-MISSING
  runRefusalRow(t, 'missing target', {
    pack: '[images]\nground = "vault:_attachments/missing.webp"\n',
    expectMessage: ({ siteDir, vaultPath }) => {
      const T = path.join(siteDir, 'pack.toml');
      const abs = path.join(vaultPath, '_attachments', 'missing.webp');
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/missing.webp" does not exist: ${abs}`;
    },
  });

  // -- directory target -> A-NOTFILE
  runRefusalRow(t, 'directory target', {
    pack: '[images]\nground = "vault:_attachments/dir.webp"\n',
    setup: ({ vaultPath }) => fs.mkdirSync(path.join(vaultPath, '_attachments', 'dir.webp')),
    expectMessage: ({ siteDir, vaultPath }) => {
      const T = path.join(siteDir, 'pack.toml');
      const abs = path.join(vaultPath, '_attachments', 'dir.webp');
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/dir.webp" is not a regular file: ${abs}`;
    },
  });

  // -- ".." -> P-DOTDOT (syntax stage)
  runRefusalRow(t, 'dotdot', {
    pack: '[images]\nground = "vault:_attachments/../a.webp"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const D = path.dirname(T);
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/../a.webp" contains ".."; write "vault:<path inside the vault>" or a path relative to ${D}`;
    },
  });

  // -- absolute path -> P-ABSOLUTE (syntax stage)
  runRefusalRow(t, 'absolute path', {
    pack: '[images]\nground = "/abs/a.webp"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const D = path.dirname(T);
      return `campaign "${c}": ${T}: [images] ground = "/abs/a.webp" is an absolute path; write "vault:<path inside the vault>" or a path relative to ${D}`;
    },
  });

  // -- scheme -> P-SCHEME (syntax stage)
  runRefusalRow(t, 'scheme', {
    pack: '[images]\nground = "https://example.invalid/a.webp"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const D = path.dirname(T);
      return `campaign "${c}": ${T}: [images] ground = "https://example.invalid/a.webp" is a URL; only files inside the vault ("vault:<path>") or relative to ${D} are allowed`;
    },
  });

  // -- backslash -> P-BACKSLASH (syntax stage)
  runRefusalRow(t, 'backslash', {
    pack: '[images]\nground = "images\\\\a.webp"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "images\\a.webp" uses a backslash; write paths with forward slashes, even on Windows`;
    },
  });

  // -- excluded dir: json name -> A-EXCLUDED
  runRefusalRow(t, 'excluded dir (json name)', {
    buildOpts: { excludeDirs: ['Secret'] },
    pack: '[images]\nground = "vault:Secret/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'Secret'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'Secret', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:Secret/x.webp" is under excluded directory "Secret"; images from excluded or hidden folders are never published`;
    },
  });

  // -- excluded dir: vault-only name -> A-EXCLUDED
  runRefusalRow(t, 'excluded dir (vault-only name)', {
    buildOpts: { publishExcludeDirs: ['VaultOnly'] },
    pack: '[images]\nground = "vault:VaultOnly/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'VaultOnly'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'VaultOnly', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:VaultOnly/x.webp" is under excluded directory "VaultOnly"; images from excluded or hidden folders are never published`;
    },
  });

  // -- excluded dir: multi-segment entry -> A-EXCLUDED
  runRefusalRow(t, 'excluded dir (multi-segment entry)', {
    buildOpts: { excludeDirs: ['Maps/Secret'] },
    pack: '[images]\nground = "vault:Maps/Secret/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'Maps', 'Secret'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'Maps', 'Secret', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:Maps/Secret/x.webp" is under excluded directory "Maps/Secret"; images from excluded or hidden folders are never published`;
    },
  });

  // -- excluded dir: segment-anywhere -> A-EXCLUDED
  runRefusalRow(t, 'excluded dir (segment anywhere)', {
    buildOpts: { excludeDirs: ['B'] },
    pack: '[images]\nground = "vault:Q/B/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'Q', 'B'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'Q', 'B', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:Q/B/x.webp" is under excluded directory "B"; images from excluded or hidden folders are never published`;
    },
  });

  // -- excluded dir: case variant, win32/darwin refuse, linux accepts
  {
    const setupCase = ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'secret'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'secret', 'x.webp'), 'x');
    };
    const expectMessage = ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:secret/x.webp" is under excluded directory "Secret"; images from excluded or hidden folders are never published`;
    };
    runRefusalRow(t, 'excluded dir case variant (win32)', {
      buildOpts: { excludeDirs: ['Secret'] },
      pack: '[images]\nground = "vault:secret/x.webp"\n',
      setup: setupCase,
      expectMessage,
      platform: 'win32',
    });
    runRefusalRow(t, 'excluded dir case variant (darwin)', {
      buildOpts: { excludeDirs: ['Secret'] },
      pack: '[images]\nground = "vault:secret/x.webp"\n',
      setup: setupCase,
      expectMessage,
      platform: 'darwin',
    });

    withScratchDir((root) => {
      const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root, { excludeDirs: ['Secret'] });
      setupCase({ vaultPath });
      writePackToml(siteDir, '[images]\nground = "vault:secret/x.webp"\n');
      const configPath = writeConfigToml(root, { vaultPath, finalOut });
      withPlatform('linux', () => {
        const result = runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha');
        assert.equal(result.exitCode, EXIT_CODES.OK, 'the case variant must be accepted on linux');
      });
    });
  }

  // -- dot-dir -> A-EXCLUDED
  runRefusalRow(t, 'dot-dir', {
    pack: '[images]\nground = "vault:.hidden/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, '.hidden', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:.hidden/x.webp" is under excluded directory ".hidden"; images from excluded or hidden folders are never published`;
    },
  });

  // -- "_meta" -> P-META (syntax stage)
  runRefusalRow(t, '_meta', {
    pack: '[images]\nground = "vault:_meta/x.webp"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const D = path.dirname(T);
      return `campaign "${c}": ${T}: [images] ground = "vault:_meta/x.webp" points into _meta/; put the image in ${D} and write its path relative to that folder instead`;
    },
  });

  // -- nested "_meta" -> A-EXCLUDED via the ALWAYS arm
  runRefusalRow(t, 'nested _meta', {
    pack: '[images]\nground = "vault:Sub/_meta/x.webp"\n',
    setup: ({ vaultPath }) => {
      fs.mkdirSync(path.join(vaultPath, 'Sub', '_meta'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'Sub', '_meta', 'x.webp'), 'x');
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: [images] ground = "vault:Sub/_meta/x.webp" is under excluded directory "_meta"; images from excluded or hidden folders are never published`;
    },
  });

  // -- symlink escaping the vault -> A-ESCAPE
  runRefusalRow(t, 'symlink escaping the vault', {
    pack: '[images]\nground = "vault:_attachments/escape.webp"\n',
    setup: ({ vaultPath, root, t: rowT }) => {
      const outside = path.join(root, 'outside-vault.webp');
      fs.writeFileSync(outside, 'x');
      try {
        fs.symlinkSync(outside, path.join(vaultPath, '_attachments', 'escape.webp'));
      } catch (err) {
        if (err.code === 'EPERM') {
          rowT.skip('symlinks unavailable: EPERM creating a symlink in this environment');
          return 'SKIP';
        }
        throw err;
      }
      return undefined;
    },
    expectMessage: ({ siteDir, vaultPath }) => {
      const T = path.join(siteDir, 'pack.toml');
      const real = fs.realpathSync(path.join(vaultPath, '_attachments', 'escape.webp'));
      return `campaign "${c}": ${T}: [images] ground = "vault:_attachments/escape.webp" resolves outside the vault (${real}); symlinks may not leave ${vaultPath}`;
    },
  });

  // -- pack-relative symlink escaping the pack -> A-ESCAPE (pack)
  runRefusalRow(t, 'pack-relative symlink escaping the pack', {
    pack: '[images]\nground = "images/escape.webp"\n',
    setup: ({ siteDir, root, t: rowT }) => {
      const outside = path.join(root, 'outside-pack.webp');
      fs.writeFileSync(outside, 'x');
      fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
      try {
        fs.symlinkSync(outside, path.join(siteDir, 'images', 'escape.webp'));
      } catch (err) {
        if (err.code === 'EPERM') {
          rowT.skip('symlinks unavailable: EPERM creating a symlink in this environment');
          return 'SKIP';
        }
        throw err;
      }
      return undefined;
    },
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const real = fs.realpathSync(path.join(siteDir, 'images', 'escape.webp'));
      return `campaign "${c}": ${T}: [images] ground = "images/escape.webp" resolves outside the pack (${real}); symlinks may not leave ${siteDir}`;
    },
  });

  // -- symlink in pack images/ -> A-PSYMLINK
  runRefusalRow(t, 'symlink in pack images/', {
    pack: 'theme = "plain"\n',
    setup: ({ siteDir, root, t: rowT }) => {
      const target = path.join(root, 'link-target.webp');
      fs.writeFileSync(target, 'x');
      fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
      try {
        fs.symlinkSync(target, path.join(siteDir, 'images', 'link.webp'));
      } catch (err) {
        if (err.code === 'EPERM') {
          rowT.skip('symlinks unavailable: EPERM creating a symlink in this environment');
          return 'SKIP';
        }
        throw err;
      }
      return undefined;
    },
    expectMessage: ({ siteDir }) => {
      const abs = path.join(siteDir, 'images', 'link.webp');
      return `campaign "${c}": symbolic links are not allowed in the pack's images folder: ${abs}`;
    },
  });

  // -- symlink from an allowed dir into an excluded dir -> A-EXCLUDED-REAL
  runRefusalRow(t, 'symlink from an allowed dir into an excluded dir', {
    buildOpts: { excludeDirs: ['Secret'] },
    pack: '[images]\nground = "vault:Allowed/link.webp"\n',
    setup: ({ vaultPath, t: rowT }) => {
      fs.mkdirSync(path.join(vaultPath, 'Secret'), { recursive: true });
      fs.writeFileSync(path.join(vaultPath, 'Secret', 'real.webp'), 'x');
      fs.mkdirSync(path.join(vaultPath, 'Allowed'), { recursive: true });
      try {
        fs.symlinkSync(path.join(vaultPath, 'Secret', 'real.webp'), path.join(vaultPath, 'Allowed', 'link.webp'));
      } catch (err) {
        if (err.code === 'EPERM') {
          rowT.skip('symlinks unavailable: EPERM creating a symlink in this environment');
          return 'SKIP';
        }
        throw err;
      }
      return undefined;
    },
    expectMessage: ({ siteDir, vaultPath }) => {
      const T = path.join(siteDir, 'pack.toml');
      const relReal = 'Secret/real.webp';
      return `campaign "${c}": ${T}: [images] ground = "vault:Allowed/link.webp" resolves to ${relReal}, which is under excluded directory "Secret"; images from excluded or hidden folders are never published`;
    },
  });

  // -- unknown theme -> P-THEME (syntax stage)
  runRefusalRow(t, 'unknown theme', {
    pack: 'theme = "nonexistent"\n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      return `campaign "${c}": ${T}: unknown theme "nonexistent"; valid themes: gloam, haze, plain`;
    },
  });

  // -- TOML syntax error -> P-TOML (syntax stage)
  runRefusalRow(t, 'TOML syntax error', {
    pack: 'theme = \n',
    expectMessage: ({ siteDir }) => {
      const T = path.join(siteDir, 'pack.toml');
      const prefix = `campaign "${c}": ${T} is not valid TOML: `;
      return (msg) => msg.startsWith(prefix) && !msg.includes('\n');
    },
  });
});

// --- B5: check/status/build agree; the CLI prints one clean line ------------

test('B5: a bad pack.toml makes check and status throw the same VaultUnreachableError as build', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "nonexistent"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    let buildMessage;
    try {
      runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
      assert.fail('expected build to throw');
    } catch (err) {
      assert.ok(err instanceof VaultUnreachableError);
      buildMessage = err.message;
    }

    assert.throws(() => runCheckCommand({ config: configPath }, 'alpha'), (err) => err instanceof VaultUnreachableError && err.message === buildMessage);
    // status reports an unreachable-class error as its own exit-3 result instead of throwing.
    const statusResult = runStatusCommand({ config: configPath }, 'alpha');
    assert.equal(statusResult.exitCode, 3);
    assert.ok(statusResult.human.includes(buildMessage), statusResult.human);
  });
});

test('B5: subprocess build with an unknown theme gives exit 3 (#108), one stderr line, no stack trace', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "nonexistent"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    let stderr = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, 'build', 'alpha', '--no-check', '--config', configPath], { stdio: 'pipe' });
      assert.fail('expected the subprocess to exit non-zero');
    } catch (err) {
      stderr = err.stderr.toString('utf8');
      status = err.status;
    }

    assert.equal(status, EXIT_CODES.VAULT_UNREACHABLE);
    const lines = stderr.trim().split('\n');
    assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(stderr)}`);
    assert.ok(!stderr.includes('    at '), 'must not print a stack trace for a user config error');
  });
});

// --- B6: an unknown key warns, and --json is otherwise unchanged ------------

test('B6: an unrecognised key warns in human output; --json is unchanged apart from generatedAt/elapsedMs', () => {
  withScratchDir((root) => {
    function stripVolatile(envelope) {
      const copy = { ...envelope };
      delete copy.generatedAt;
      delete copy.elapsedMs;
      if (copy.check) copy.check = stripVolatile(copy.check);
      return copy;
    }

    // Same vault/siteDir/finalOut throughout: only pack.toml's content changes between the
    // "base" and "warn" runs, so every envelope field but generatedAt/elapsedMs must match.
    // check/status are compared BEFORE anything is built (their own findings/verdict read
    // whether finalOut exists, so building between the two runs would move unrelated
    // leak/l2-l4 "no output yet" INFO findings and break the comparison); build is compared
    // last, since each call fully rebuilds finalOut from scratch regardless of prior state.
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    writePackToml(siteDir, 'theme = "plain"\n');
    const baseCheck = runCheckCommand({ config: configPath }, 'alpha');
    const baseStatus = runStatusCommand({ config: configPath }, 'alpha');
    assert.doesNotMatch(baseCheck.human, /warning:/);
    assert.doesNotMatch(baseStatus.human, /warning:/);

    writePackToml(siteDir, 'theme = "plain"\nnot_a_pack_key = 1\n');
    const warnCheck = runCheckCommand({ config: configPath }, 'alpha');
    const warnStatus = runStatusCommand({ config: configPath }, 'alpha');
    assert.match(warnCheck.human, /^warning: .*unrecognised key "not_a_pack_key"/m);
    assert.match(warnStatus.human, /warning: .*unrecognised key "not_a_pack_key"/);

    assert.deepEqual(stripVolatile(warnCheck.envelope), stripVolatile(baseCheck.envelope));
    assert.deepEqual(stripVolatile(warnStatus.envelope), stripVolatile(baseStatus.envelope));

    writePackToml(siteDir, 'theme = "plain"\n');
    const baseBuild = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.doesNotMatch(baseBuild.human, /warning:/);

    writePackToml(siteDir, 'theme = "plain"\nnot_a_pack_key = 1\n');
    const warnBuild = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.match(warnBuild.human, /warning: .*unrecognised key "not_a_pack_key"/);

    assert.deepEqual(stripVolatile(warnBuild.envelope), stripVolatile(baseBuild.envelope));
    void jsonConfig;
  });
});

// --- B7: E-COLLISION ---------------------------------------------------------

test('B7: a folderMap entry mapping to "scriptorium" collides with a slot, but builds fine without a pack.toml', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root, { folderMap: { NPCs: 'scriptorium' } });
    writePackToml(siteDir, '[images]\nground = "vault:_attachments/ground.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    fs.mkdirSync(finalOut, { recursive: true });
    fs.writeFileSync(path.join(finalOut, 'sentinel.txt'), 'sentinel');
    const beforeManifest = sha256Manifest(finalOut);

    const T = path.join(siteDir, 'pack.toml');
    const expected = `campaign "alpha": the generated site already has a scriptorium/ folder (a folderMap entry probably maps a vault folder to it); rename that output folder, because image slots and pack images are written to scriptorium/`;

    expectedConfigError(() => runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha'), expected, 'B7 collision', ConfigError);
    assert.equal(sha256Manifest(finalOut), beforeManifest);
    assert.deepEqual(siblingDirs(finalOut), []);
    void T;

    // EBUSY on the staging cleanup must not change the error.
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, opts) => {
      if (/\.scriptorium-build-/.test(String(target))) {
        const err = new Error(`EBUSY: resource busy or locked, unlink '${target}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };
    try {
      expectedConfigError(() => runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha'), expected, 'B7 collision (EBUSY cleanup)', ConfigError);
    } finally {
      fs.rmSync = originalRmSync;
    }

    // The same folderMap with no pack.toml builds successfully.
    fs.rmSync(path.join(siteDir, 'pack.toml'), { force: true });
    const result = runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
  });
});

// --- B8: SVG slots and pack images are scanned by the output-leak gate ------

const WITHELD_NAME = 'Secret Witness';

function buildLeakVault(root, { heroSvgContent, packImageName = 'secret-witness.png' } = {}) {
  const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
  fs.writeFileSync(
    path.join(vaultPath, 'NPCs', 'Secret-Witness.md'),
    `---\ntype: npc\ntitle: ${WITHELD_NAME}\nwithheld: true\n---\nNever meant to reach a player.\n`,
  );
  fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'images', 'hero.svg'), heroSvgContent);
  fs.writeFileSync(path.join(siteDir, 'images', packImageName), 'not really a png, just bytes');
  writePackToml(siteDir, '[images]\nhero = "images/hero.svg"\n');
  const configPath = writeConfigToml(root, { vaultPath, finalOut });
  return { vaultPath, siteDir, finalOut, configPath };
}

test('B8: a pack SVG slot and a pack image containing the withheld name both fire the output-leak scan', () => {
  withScratchDir((root) => {
    const { finalOut, configPath } = buildLeakVault(root, { heroSvgContent: `<svg><text>${WITHELD_NAME}</text></svg>` });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.refusedByScan, true);

    const findings = result.envelope.outputScanFindings;
    assert.ok(findings.some((f) => f.outputPath === 'scriptorium/slots/hero.svg'), 'the SVG slot content must be scanned');
    assert.ok(findings.some((f) => f.outputPath === 'scriptorium/campaign/secret-witness.png'), 'the pack image filename must be scanned (path arm)');
    void finalOut;
  });
});

test('B8: a clean SVG (control) gives exit 0', () => {
  withScratchDir((root) => {
    const { configPath } = buildLeakVault(root, { heroSvgContent: '<svg><text>An ordinary crest</text></svg>', packImageName: 'ordinary.png' });
    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
  });
});

// --- B9: a file-backed fixture theme ----------------------------------------

test('B9: a fixture theme through planThemeAssets + runAtomicBuild', () => {
  withScratchDir((root) => {
    const themeDir = path.join(root, 'fixture-theme');
    fs.mkdirSync(path.join(themeDir, 'images'), { recursive: true });
    const fixtureCss = '@import url("x");\nbody { color: red; }\n';
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify({ name: 'fixture', scheme: 'dark', slots: ['hero'] }));
    fs.writeFileSync(path.join(themeDir, 'theme.css'), fixtureCss);
    fs.writeFileSync(path.join(themeDir, 'images', 'mark.svg'), '<svg>mark</svg>');
    const registry = Object.freeze({ fixture: Object.freeze({ name: 'fixture', dir: themeDir }) });

    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'hero.png'), 'hero-bytes');

    const T = path.join(siteDir, 'pack.toml');
    const packToml = {
      path: T,
      present: true,
      theme: 'fixture',
      images: [{ slot: 'hero', raw: 'vault:_attachments/hero.png', kind: 'vault', rel: '_attachments/hero.png' }],
      warnings: [],
    };
    const themePlan = planThemeAssets({ vaultPath, jsonConfig: { ...jsonConfig, vaultPath }, siteDir, packToml, campaign: 'alpha', registry });

    const expectedCss = `${fixtureCss}\n:root {\n  --sc-img-hero: url("../scriptorium/slots/hero.png");\n}\n`;
    assert.equal(themePlan.css, expectedCss);
    assert.ok(themePlan.css.startsWith('@import'));

    const result = directBuild({ vaultPath, jsonConfig, siteDir, finalOut, themePlan });
    assert.equal(result.ok, true);

    assert.deepEqual(fs.readFileSync(path.join(finalOut, 'scriptorium', 'theme', 'mark.svg'), 'utf8'), '<svg>mark</svg>');

    const htmlFiles = findHtmlFiles(finalOut);
    let checkedAny = false;
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes('data-scriptorium-housestyle')) continue;
      checkedAny = true;
      assert.equal((html.match(/data-scriptorium-theme/g) || []).length, 1, `${file}: exactly one theme link`);
    }
    assert.ok(checkedAny, 'sanity: at least one housestyle page existed');
  });
});
