'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');

const { ConfigError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * rc.2 Windows follow-ups, DEFECT 2 (the Windows verifier, 2026-09-29-v0.3.0-rc.2-windows-c34-themes-slots.md):
 * a vault.config.json missing `excludeDirs` or `folderMap` used to crash the real generator's scan
 * (lib/scanner.js's scanVaultReport/mapFolder, reached from `build()` via
 * src/generator/bootstrap.js's runGeneratorBuild) with a raw, unhelpful TypeError:
 *
 *   neither key        -> "Cannot read properties of undefined (reading 'some')"
 *   folderMap only      -> the same message (excludeDirs.some fails first, before mapFolder runs)
 *   excludeDirs only    -> "Cannot convert undefined or null to object" (Object.entries(folderMap))
 *
 * src/cli/check.js's assertScanKeysPresent (called from resolveVaultContext, the one function
 * `check`, `build`, `serve --admin`'s preview build, and init's post-scaffold check all resolve
 * the site config through) now refuses early with a ConfigError naming the missing key and the
 * file, before any of those four ever reaches the generator. Synthetic cast only, scratch dirs
 * only, per this repo's own convention (NFR-08/NFR-10/NFR-11 as used throughout test/).
 *
 * Reviewer correction (2026-09-29, same-day re-review): the original assertScanKeysPresent only
 * checked PRESENCE (`== null`), so a present-but-wrong-typed key -- `excludeDirs` as a string,
 * number or plain object -- still reaches src/vault/publishset.js's own ported scan
 * (isExcludedDir's `excludeDirs.some(...)`) and throws the identical unrefused class of raw
 * TypeError DEFECT 2 was meant to close (reproduced live: `excludeDirs: "not-an-array"` against
 * `runCheckCommand` throws "TypeError: excludeDirs.some is not a function" straight out of
 * src/vault/publishset.js:208, with a full stack trace, exit 0 from bin/scriptorium.js's own
 * top-level catch never even running because the process dies first). `folderMap` typed wrong
 * (string/array/number) does NOT crash the same way -- `Object.entries()` tolerates all of those
 * without throwing -- so the shape check below only rejects folderMap shapes that are actually not
 * an object (an array, or a primitive), which is the type Object.entries/mapFolder's own
 * `[vaultDir, outputDir]` destructuring assumes.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const MINI_VAULT_SITE_CONFIG = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');
const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-scan-keys-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Async-safe counterpart: `fn` may be async, and the scratch dir is not removed until it
 * actually settles (a sync try/finally around an unawaited async fn would delete the dir out
 * from under it -- test/init-flow.test.js's own withScratchDir is async for the same reason). */
async function withScratchDirAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-scan-keys-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

/** A minimal vault: just <dir>/vault/_meta/vault-config.md. */
function makeVault(dir) {
  const vaultPath = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ncampaign: fixture\n---\n');
  return vaultPath;
}

function conventionDirFor(vaultPath) {
  return path.join(vaultPath, '_meta', 'scriptorium');
}

function writeConventionPack(vaultPath, obj) {
  const packDir = conventionDirFor(vaultPath);
  fs.mkdirSync(packDir, { recursive: true });
  const jsonPath = path.join(packDir, 'vault.config.json');
  fs.writeFileSync(jsonPath, JSON.stringify(obj, null, 2));
  return jsonPath;
}

function writeScratchToml(configPath, { vault, output, campaign = 'fixture' }) {
  fs.writeFileSync(
    configPath,
    ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vault}'`, `output = '${output}'`, ''].join(
      '\n',
    ),
  );
}

// The three negative shapes from the Windows report's own table, plus a fourth ("both absent,
// but as explicit null") that hits the same TypeErrors and the brief's `== null` rationale.
const SHAPES = [
  { label: 'neither excludeDirs nor folderMap', json: { siteTitle: 'Scan Keys' }, missing: ['excludeDirs', 'folderMap'] },
  { label: 'folderMap only (no excludeDirs)', json: { siteTitle: 'Scan Keys', folderMap: {} }, missing: ['excludeDirs'] },
  { label: 'excludeDirs only (no folderMap)', json: { siteTitle: 'Scan Keys', excludeDirs: [] }, missing: ['folderMap'] },
];

function expectedMessage(jsonPath, missing) {
  return `campaign "fixture": ${jsonPath} is missing required key${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}`;
}

// --- Unit: assertScanKeysPresent, in isolation ------------------------------------------------

test('assertScanKeysPresent: unit coverage for all three negative shapes plus a positive control', () => {
  const { assertScanKeysPresent } = require('../src/cli/check');

  for (const shape of SHAPES) {
    assert.throws(
      () => assertScanKeysPresent(shape.json, '/fake/vault.config.json', 'fixture'),
      (err) => err instanceof ConfigError && err.message === expectedMessage('/fake/vault.config.json', shape.missing),
      shape.label,
    );
  }

  // Positive control: both present -> no throw.
  assert.doesNotThrow(() => assertScanKeysPresent({ excludeDirs: [], folderMap: {} }, '/fake/vault.config.json', 'fixture'));

  // `== null` also catches an explicit null, not just an absent key (same raw TypeError either way).
  assert.throws(
    () => assertScanKeysPresent({ excludeDirs: null, folderMap: {} }, '/fake/vault.config.json', 'fixture'),
    (err) => err instanceof ConfigError && err.message === expectedMessage('/fake/vault.config.json', ['excludeDirs']),
  );
});

// --- Wrong-shaped keys: present, but not the type the pin's scanner actually consumes ----------
// Reviewer finding, 2026-09-29: excludeDirs is read with `.some(...)` (lib/scanner.js /
// src/vault/publishset.js's ported isExcludedDir), which only exists on an array -- a string,
// number or plain object all throw "TypeError: ... .some is not a function", unrefused, the exact
// class of bug DEFECT 2 was meant to close. folderMap is read with `Object.entries(...)` then
// `[vaultDir, outputDir]` destructuring -- JS tolerates a non-object argument there without
// throwing (Object.entries on a string/array/number returns entries or []), so a wrong-typed
// folderMap does not crash, but it is just as much "not a valid configuration" as a missing one
// (every folder silently becomes unmapped, or maps to garbage), so it is refused for the same
// reason a missing key is: the generator's own contract assumes a plain object here.
const WRONG_SHAPES = [
  {
    label: 'excludeDirs as a string',
    json: { excludeDirs: 'not-an-array', folderMap: {} },
    expected: (p) => `campaign "fixture": ${p}: excludeDirs must be an array of directory names, not a string`,
  },
  {
    label: 'excludeDirs as a number',
    json: { excludeDirs: 42, folderMap: {} },
    expected: (p) => `campaign "fixture": ${p}: excludeDirs must be an array of directory names, not a number`,
  },
  {
    label: 'excludeDirs as a plain object',
    json: { excludeDirs: { a: 1 }, folderMap: {} },
    expected: (p) => `campaign "fixture": ${p}: excludeDirs must be an array of directory names, not an object`,
  },
  {
    label: 'folderMap as an array',
    json: { excludeDirs: [], folderMap: ['a', 'b'] },
    expected: (p) => `campaign "fixture": ${p}: folderMap must be an object mapping vault folders to output folders, not an array`,
  },
  {
    label: 'folderMap as a string',
    json: { excludeDirs: [], folderMap: 'not-an-object' },
    expected: (p) => `campaign "fixture": ${p}: folderMap must be an object mapping vault folders to output folders, not a string`,
  },
  {
    label: 'folderMap as a number',
    json: { excludeDirs: [], folderMap: 42 },
    expected: (p) => `campaign "fixture": ${p}: folderMap must be an object mapping vault folders to output folders, not a number`,
  },
];

test('assertScanKeysPresent: unit coverage for all six wrong-shape cases', () => {
  const { assertScanKeysPresent } = require('../src/cli/check');
  for (const shape of WRONG_SHAPES) {
    assert.throws(
      () => assertScanKeysPresent(shape.json, '/fake/vault.config.json', 'fixture'),
      (err) => err instanceof ConfigError && err.message === shape.expected('/fake/vault.config.json'),
      shape.label,
    );
  }
});

test('assertScanKeysPresent: excludeDirs as an empty array and folderMap as an empty object both pass (the real shapes every fixture uses)', () => {
  const { assertScanKeysPresent } = require('../src/cli/check');
  assert.doesNotThrow(() => assertScanKeysPresent({ excludeDirs: [], folderMap: {} }, '/fake/vault.config.json', 'fixture'));
  assert.doesNotThrow(() =>
    assertScanKeysPresent({ excludeDirs: ['_meta'], folderMap: { Characters: 'characters' } }, '/fake/vault.config.json', 'fixture'),
  );
});

test('the shape check does not regress any real, already-shipped config: mini-vault, vocab-vault, and a fresh init scaffold all pass', () => {
  const { assertScanKeysPresent } = require('../src/cli/check');

  const miniVaultSiteConfig = JSON.parse(fs.readFileSync(MINI_VAULT_SITE_CONFIG, 'utf8'));
  assert.doesNotThrow(() => assertScanKeysPresent(miniVaultSiteConfig, MINI_VAULT_SITE_CONFIG, 'fixture'));
  assert.ok(Array.isArray(miniVaultSiteConfig.excludeDirs), 'sanity: the fixture really is an array on disk, not just accepted by coincidence');
  assert.ok(
    typeof miniVaultSiteConfig.folderMap === 'object' && !Array.isArray(miniVaultSiteConfig.folderMap),
    'sanity: the fixture really is a plain object on disk',
  );

  const vocabVaultPackPath = path.join(VOCAB_VAULT_SRC, '_meta', 'scriptorium', 'vault.config.json');
  const vocabVaultPack = JSON.parse(fs.readFileSync(vocabVaultPackPath, 'utf8'));
  assert.doesNotThrow(() => assertScanKeysPresent(vocabVaultPack, vocabVaultPackPath, 'fixture'));

  // What a brand-new `init` run writes to disk, before any GM has touched it: the pin's scaffold
  // template run through composeVaultConfigJson. Up to publish-v1.11.44 the raw template carried
  // excludeDirs and folderMap itself; at publish-v1.12.0 it holds deploy keys only and
  // composeVaultConfigJson supplies them (src/cli/init.js, LEGACY_SCAFFOLD_SETTINGS).
  const { readVaultConfigTemplate } = require('../src/generator/pinned');
  const { composeVaultConfigJson } = require('../src/cli/init');
  const scaffold = JSON.parse(composeVaultConfigJson(readVaultConfigTemplate(), 'x'));
  assert.doesNotThrow(() => assertScanKeysPresent(scaffold, '<scaffold>', 'fixture'));
});

test('reproduces the reviewer-found crash live, then confirms it is refused: excludeDirs as a string reaches src/vault/publishset.js\'s own ported scan unrefused today only without the fix', () => {
  // This is the exact repro from the live-reproduced finding: runCheckCommand against a real
  // scratch vault with excludeDirs: "not-an-array". Before the fix this throws a raw TypeError
  // out of src/vault/publishset.js:208 with a full stack trace; after the fix it throws a clean
  // ConfigError instead. Asserting the ConfigError here is the red/green evidence for the fix
  // itself (see the entry-point tests below for check/build coverage of every shape).
  withScratchDir((dir) => {
    const vaultPath = makeVault(dir);
    const jsonPath = writeConventionPack(vaultPath, { siteTitle: 'Scan Keys', excludeDirs: 'not-an-array', folderMap: {} });
    const configPath = path.join(dir, 'config.toml');
    writeScratchToml(configPath, { vault: vaultPath, output: path.join(dir, 'out') });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    assert.throws(
      () => runCheckCommand({ config: configPath }, 'fixture'),
      (err) =>
        err instanceof ConfigError &&
        err.message === `campaign "fixture": ${jsonPath}: excludeDirs must be an array of directory names, not a string` &&
        !(err instanceof TypeError),
    );
  });
});

// --- Entry point 1: check ---------------------------------------------------------------------

test('runCheckCommand refuses with a ConfigError naming the missing key and the file, for all three shapes', () => {
  for (const shape of SHAPES) {
    withScratchDir((dir) => {
      const vaultPath = makeVault(dir);
      const jsonPath = writeConventionPack(vaultPath, shape.json);
      const configPath = path.join(dir, 'config.toml');
      writeScratchToml(configPath, { vault: vaultPath, output: path.join(dir, 'out') });

      const { runCheckCommand } = requireFresh('../src/cli/check');
      assert.throws(
        () => runCheckCommand({ config: configPath }, 'fixture'),
        (err) => err instanceof ConfigError && err.message === expectedMessage(jsonPath, shape.missing),
        shape.label,
      );
    });
  }
});

test('runCheckCommand: positive control, both keys present, check runs to completion', () => {
  // vocab-vault, not the bare makeVault() helper: makeVault() has no publish-manifest.md and no
  // typed content, which trips leak/l1-no-manifest and frontmatter/missing-type on its own,
  // unrelated to DEFECT 2 -- see the panel-preview positive control's comment above for the same
  // reasoning. This assertion is about assertScanKeysPresent never firing, not about the rest of
  // check's report being clean by coincidence.
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const configPath = path.join(dir, 'config.toml');
    writeScratchToml(configPath, { vault: vaultPath, output: path.join(dir, 'out') });

    const { runCheckCommand } = requireFresh('../src/cli/check');
    const result = runCheckCommand({ config: configPath }, 'fixture');
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  });
});

// --- Entry point 2: build ----------------------------------------------------------------------

test('runBuildCommand refuses with a ConfigError and writes nothing, for all three shapes', () => {
  for (const shape of SHAPES) {
    withScratchDir((dir) => {
      const vaultPath = makeVault(dir);
      const jsonPath = writeConventionPack(vaultPath, shape.json);
      const configPath = path.join(dir, 'config.toml');
      const outDir = path.join(dir, 'out');
      writeScratchToml(configPath, { vault: vaultPath, output: outDir });

      const { runBuildCommand } = requireFresh('../src/cli/build');
      assert.throws(
        () => runBuildCommand({ config: configPath, force: true }, 'fixture'),
        (err) => err instanceof ConfigError && err.message === expectedMessage(jsonPath, shape.missing),
        shape.label,
      );
      assert.equal(fs.existsSync(outDir), false, 'nothing should be written; the vault context never even resolves');
      // No leftover staging tree either -- the throw happens before writeStagedConfig ever runs.
      const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.scriptorium-build-'));
      assert.deepEqual(leftovers, []);
    });
  }
});

test('runBuildCommand refuses with a ConfigError and writes nothing, for all six wrong-shape cases', () => {
  for (const shape of WRONG_SHAPES) {
    withScratchDir((dir) => {
      const vaultPath = makeVault(dir);
      const jsonPath = writeConventionPack(vaultPath, shape.json);
      const configPath = path.join(dir, 'config.toml');
      const outDir = path.join(dir, 'out');
      writeScratchToml(configPath, { vault: vaultPath, output: outDir });

      const { runBuildCommand } = requireFresh('../src/cli/build');
      assert.throws(
        () => runBuildCommand({ config: configPath, force: true }, 'fixture'),
        (err) => err instanceof ConfigError && err.message === shape.expected(jsonPath),
        shape.label,
      );
      assert.equal(fs.existsSync(outDir), false, 'nothing should be written; the vault context never even resolves');
      const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.scriptorium-build-'));
      assert.deepEqual(leftovers, []);
    });
  }
});

test('runBuildCommand: positive control, a real mini-vault with both keys builds cleanly', () => {
  withScratchDir((dir) => {
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const siteConfig = JSON.parse(fs.readFileSync(MINI_VAULT_SITE_CONFIG, 'utf8'));
    fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(siteConfig, null, 2));
    const outDir = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'config_version = 1',
        'default_campaign = "fixture"',
        '',
        '[campaigns.fixture]',
        `vault = '${MINI_VAULT}'`,
        `site_config = '${path.join(siteDir, 'vault.config.json')}'`,
        `output = '${outDir}'`,
        '',
      ].join('\n'),
    );

    const { runBuildCommand } = requireFresh('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  });
});

// --- Entry point 3: the panel preview build -----------------------------------------------------

test('the panel preview build (runPreviewBuild) refuses with the same ConfigError', () => {
  withScratchDir((dir) => {
    const vaultPath = makeVault(dir);
    const jsonPath = writeConventionPack(vaultPath, SHAPES[0].json);

    const { resolveVaultSite } = requireFresh('../src/cli/check');
    const { createAdminContext } = requireFresh('../src/admin/context');
    const preview = requireFresh('../src/admin/preview');

    const ctxInfo = { campaign: 'fixture', vault: vaultPath, output: path.join(dir, 'out') };
    const { vaultPath: resolvedVaultPath, site } = resolveVaultSite(ctxInfo);
    const ctx = createAdminContext({ ctxInfo, vaultPath: resolvedVaultPath, site, token: 'TOK' });
    preview.ensurePreviewRoot(ctx);

    assert.throws(
      () => preview.runPreviewBuild(ctx),
      (err) => err instanceof ConfigError && err.message === expectedMessage(jsonPath, SHAPES[0].missing),
    );

    preview.removePreviewRoot(ctx);
  });
});

test('the panel preview build: positive control, both keys present, builds into the preview dir', () => {
  // runPreviewBuild accepts neither --force nor --no-check (FR29), so the fixture itself must be
  // clean of ERROR findings; vocab-vault (publish.mode: full, so leak/l1-no-manifest never fires)
  // and its own convention pack (both keys already present) fit, unlike the bare-bones makeVault()
  // helper used elsewhere in this file, which trips frontmatter/missing-type and leak/l1-no-manifest
  // for reasons unrelated to DEFECT 2.
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });

    const { resolveVaultSite } = requireFresh('../src/cli/check');
    const { createAdminContext } = requireFresh('../src/admin/context');
    const preview = requireFresh('../src/admin/preview');

    const ctxInfo = { campaign: 'fixture', vault: vaultPath, output: path.join(dir, 'out') };
    const { vaultPath: resolvedVaultPath, site } = resolveVaultSite(ctxInfo);
    const ctx = createAdminContext({ ctxInfo, vaultPath: resolvedVaultPath, site, token: 'TOK' });
    preview.ensurePreviewRoot(ctx);

    const result = preview.runPreviewBuild(ctx);
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.ok(fs.existsSync(path.join(ctx.previewDir, 'index.html')));

    preview.removePreviewRoot(ctx);
  });
});

// --- Entry point 4: init's post-scaffold check --------------------------------------------------

function makeStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, getWritten: () => written };
}

function waitForOutput(getWritten, substring, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (getWritten().includes(substring)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error(`timed out waiting for output to include ${JSON.stringify(substring)}; got: ${JSON.stringify(getWritten())}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/** A vault with ALL FOUR scaffold entries already present (css/, images/, pack.toml,
 * vault.config.json), so init's own scaffold step treats everything as "left untouched" and
 * proceeds straight to "Run a first check now?" without prompting for title or theme (both are
 * only prompted when their file is about to be created). The pre-existing vault.config.json is
 * deliberately missing folderMap, reproducing a hand-edited pack a real user would have. */
function initVaultWithIncompletePack(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: Scan Keys\n---\n\n# x\n');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(path.join(packDir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  const jsonPath = path.join(packDir, 'vault.config.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ siteTitle: 'Scan Keys', excludeDirs: [] }, null, 2));
  return { vaultPath, jsonPath };
}

test("init's post-scaffold check: a hand-edited pack missing folderMap prints a clean ConfigError, not a stack trace, and init itself still exits 0", { timeout: 15000 }, async () => {
  await withScratchDirAsync(async (root) => {
    const { vaultPath, jsonPath } = initVaultWithIncompletePack(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const { runInitCommand } = requireFresh('../src/cli/init');

    const promise = runInitCommand({ config: configPath }, [], { input, output });
    input.write('scankeys\n'); // campaign name
    input.write(`${vaultPath}\n`); // vault path
    input.write('\n'); // output: accept default (title/theme are never prompted -- both files exist)
    input.write('y\n'); // "Run a first check now? [Y/n]:"

    await waitForOutput(getWritten, 'check could not run');
    const result = await promise;

    assert.equal(result.exitCode, 0, 'init itself must still succeed; a check failure is caught and printed, not thrown');
    assert.ok(
      getWritten().includes(`check could not run: campaign "scankeys": ${jsonPath} is missing required key excludeDirs`) === false,
    );
    assert.ok(
      getWritten().includes(`check could not run: campaign "scankeys": ${jsonPath} is missing required key folderMap`),
      getWritten(),
    );
    assert.ok(!getWritten().includes('    at '), 'must not print a stack trace for a user config error');
  });
});

test("init's post-scaffold check: positive control, a complete pack runs a real check and prints its human report", { timeout: 15000 }, async () => {
  await withScratchDirAsync(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: Scan Keys\n---\n\n# x\n');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(path.join(packDir, 'css'), { recursive: true });
    fs.mkdirSync(path.join(packDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(
      path.join(packDir, 'vault.config.json'),
      JSON.stringify({ siteTitle: 'Scan Keys', excludeDirs: [], folderMap: {} }, null, 2),
    );

    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const { runInitCommand } = requireFresh('../src/cli/init');

    const promise = runInitCommand({ config: configPath }, [], { input, output });
    input.write('scankeys\n');
    input.write(`${vaultPath}\n`);
    input.write('\n');
    input.write('y\n');

    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.ok(!getWritten().includes('check could not run'));
    assert.ok(!getWritten().includes('    at '));
  });
});

// --- CLI-level: exit code and no stack trace, for both check and build --------------------------

test('CLI: check on a vault.config.json missing folderMap prints one clean line, no stack trace, exit 1 (existing exit code)', () => {
  withScratchDir((dir) => {
    const vaultPath = makeVault(dir);
    const jsonPath = writeConventionPack(vaultPath, SHAPES[2].json);
    const configPath = path.join(dir, 'config.toml');
    writeScratchToml(configPath, { vault: vaultPath, output: path.join(dir, 'out') });

    let stderr = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, 'check', 'fixture', '--config', configPath], { stdio: 'pipe' });
    } catch (err) {
      stderr = err.stderr.toString('utf8');
      status = err.status;
    }

    assert.equal(status, EXIT_CODES.SCRIPTORIUM_ERROR);
    assert.equal(stderr.trim(), expectedMessage(jsonPath, SHAPES[2].missing));
    assert.ok(!stderr.includes('    at '), 'must not print a stack trace for a user config error');
  });
});

test('CLI: build on a vault.config.json missing both keys prints one clean line, no stack trace, exit 1, writes nothing', () => {
  withScratchDir((dir) => {
    const vaultPath = makeVault(dir);
    const jsonPath = writeConventionPack(vaultPath, SHAPES[0].json);
    const outDir = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    writeScratchToml(configPath, { vault: vaultPath, output: outDir });

    let stderr = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, 'build', 'fixture', '--config', configPath, '--force'], { stdio: 'pipe' });
    } catch (err) {
      stderr = err.stderr.toString('utf8');
      status = err.status;
    }

    assert.equal(status, EXIT_CODES.SCRIPTORIUM_ERROR);
    assert.equal(stderr.trim(), expectedMessage(jsonPath, SHAPES[0].missing));
    assert.ok(!stderr.includes('    at '), 'must not print a stack trace for a user config error');
    assert.equal(fs.existsSync(outDir), false);
  });
});
