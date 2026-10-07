'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigError, VaultUnreachableError } = require('../src/util/errors');
const readModule = require('../src/vault/read');

/*
 * ADR 0018 (P2-FR02/FR03/FR04/FR05): resolveVaultContext resolves a
 * campaign's site inputs by precedence: site_config (including
 * --site-config) > the pack key > the convention directory
 * <vault>/_meta/scriptorium/, where a pack is a directory holding
 * vault.config.json. Every test here uses a scratch directory and
 * synthetic names only (NFR-08).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pack-resolution-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** resolveCampaign's profile matching reads SCRIPTORIUM_PROFILE directly; force it off so tests exercise the real match logic regardless of the ambient shell. */
function withCleanProfileEnv(fn) {
  const saved = process.env.SCRIPTORIUM_PROFILE;
  delete process.env.SCRIPTORIUM_PROFILE;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SCRIPTORIUM_PROFILE;
    else process.env.SCRIPTORIUM_PROFILE = saved;
  }
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function writeScratchConfig(configPath, { vault, siteConfig, pack, output, campaign = 'alpha' }) {
  const lines = ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vault}'`];
  if (siteConfig !== undefined) lines.push(`site_config = '${siteConfig}'`);
  if (pack !== undefined) lines.push(`pack = '${pack}'`);
  lines.push(`output = '${output}'`);
  fs.writeFileSync(configPath, lines.join('\n'));
}

/** A minimal vault: just <dir>/vault/_meta/vault-config.md, per the brief's scratch-helper spec. */
function makeVault(dir) {
  const vaultDir = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vaultDir, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), '---\ncampaign: fixture\n---\n');
  return vaultDir;
}

function conventionDirFor(vaultDir) {
  return path.join(vaultDir, '_meta', 'scriptorium');
}

// rc.2 Windows follow-ups, DEFECT 2: resolveVaultContext now requires excludeDirs and
// folderMap to be present (src/cli/check.js's assertScanKeysPresent). These two synthetic
// fixture writers are shared by every test in this file, most of which are about site-source
// resolution, not about the scan-keys check itself, so the defaults are supplied here rather
// than repeated at each call site; a call that wants to test a missing key passes it explicitly.
function writePackDir(dirPath, obj) {
  fs.mkdirSync(dirPath, { recursive: true });
  const withDefaults = { excludeDirs: [], folderMap: {}, ...obj };
  fs.writeFileSync(path.join(dirPath, 'vault.config.json'), JSON.stringify(withDefaults, null, 2));
  return dirPath;
}

function writeLegacySiteConfig(dirPath, obj) {
  fs.mkdirSync(dirPath, { recursive: true });
  const p = path.join(dirPath, 'vault.config.json');
  const withDefaults = { excludeDirs: [], folderMap: {}, ...obj };
  fs.writeFileSync(p, JSON.stringify(withDefaults, null, 2));
  return p;
}

function baseCtxInfo(vaultDir, extra = {}) {
  return { campaign: 'fixture', vault: vaultDir, ...extra };
}

// Expected values, stated independently of src/cli/check.js.

function eNone(vaultDir) {
  return (
    `campaign "fixture" has no site config: site_config is not set, pack is not set, and ` +
    `${path.join(vaultDir, '_meta', 'scriptorium', 'vault.config.json')} does not exist.${' Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.'}`
  );
}
function ePackDir(packDir) {
  return `campaign "fixture": pack directory does not exist: ${packDir}`;
}
function ePackJson(packDir) {
  return `campaign "fixture": pack directory ${packDir} has no vault.config.json`;
}
function eConv(vaultDir) {
  return `campaign "fixture": ${path.join(vaultDir, '_meta', 'scriptorium')} exists but has no vault.config.json`;
}
function eShape(jsonPath) {
  return `campaign "fixture": ${jsonPath} must contain a JSON object`;
}

test('T1: convention pack only', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir));

    assert.equal(result.siteSource, 'convention');
    assert.equal(result.siteDir, conventionDirFor(vaultDir));
    assert.equal(result.jsonConfig.siteTitle, 'CONVENTION-PACK');
    assert.equal(result.packShadowed, null);
  });
});

test('T2: pack key and convention both present', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });
    const explicitPack = writePackDir(path.join(dir, 'explicit-pack'), { siteTitle: 'EXPLICIT-PACK' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir, { pack: explicitPack }));

    assert.equal(result.siteSource, 'pack');
    assert.equal(result.siteDir, explicitPack);
    assert.equal(result.jsonConfig.siteTitle, 'EXPLICIT-PACK');
    assert.equal(result.packShadowed, null);
  });
});

test('T3: site_config, pack key and convention all present', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });
    const explicitPack = writePackDir(path.join(dir, 'explicit-pack'), { siteTitle: 'EXPLICIT-PACK' });
    const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir, { site_config: legacyPath, pack: explicitPack }));

    assert.equal(result.siteSource, 'site_config');
    assert.equal(result.siteDir, path.dirname(legacyPath));
    assert.equal(result.jsonConfig.siteTitle, 'LEGACY-SITE');
    assert.deepEqual(result.packShadowed, {
      siteConfigPath: path.resolve(legacyPath),
      packDir: explicitPack,
      packSource: 'pack',
    });
  });
});

test('T4: site_config and convention (no pack key)', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });
    const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir, { site_config: legacyPath }));

    assert.equal(result.siteSource, 'site_config');
    assert.equal(result.packShadowed.packSource, 'convention');
    assert.equal(result.packShadowed.packDir, conventionDirFor(vaultDir));
  });
});

test('T5: site_config and no pack anywhere', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir, { site_config: legacyPath }));

    assert.equal(result.packShadowed, null);
  });
});

test('T6: explicit pack directory missing, convention present -> E-PACKDIR, no fallthrough', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });
    const missingPack = path.join(dir, 'does-not-exist-pack');

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir, { pack: missingPack })),
      (err) => err instanceof VaultUnreachableError && err.message === ePackDir(missingPack),
    );
  });
});

test('T7: explicit pack directory present with no JSON, convention present -> E-PACKJSON', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    writePackDir(conventionDirFor(vaultDir), { siteTitle: 'CONVENTION-PACK' });
    const emptyPack = path.join(dir, 'empty-pack');
    fs.mkdirSync(emptyPack, { recursive: true });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir, { pack: emptyPack })),
      (err) => err instanceof VaultUnreachableError && err.message === ePackJson(emptyPack),
    );
  });
});

test('T8: convention directory present with no JSON -> E-CONV', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    fs.mkdirSync(conventionDirFor(vaultDir), { recursive: true });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir)),
      (err) => err instanceof VaultUnreachableError && err.message === eConv(vaultDir),
    );
  });
});

test('T9: nothing at all -> E-NONE', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir)),
      (err) => err instanceof VaultUnreachableError && err.message === eNone(vaultDir),
    );
  });
});

test('T10: vault path does not exist, and no site inputs -> VaultUnreachableError (vault checked first)', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'does-not-exist-vault');

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(() => resolveVaultContext(baseCtxInfo(vaultDir)), VaultUnreachableError);
  });
});

test('T11: pack JSON `{"a":` -> VaultUnreachableError (exit 3, #108) naming the path, no newline', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const packDir = conventionDirFor(vaultDir);
    fs.mkdirSync(packDir, { recursive: true });
    const jsonPath = path.join(packDir, 'vault.config.json');
    fs.writeFileSync(jsonPath, '{"a":');

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir)),
      (err) => err instanceof VaultUnreachableError && err.message.includes(jsonPath) && !err.message.includes('\n'),
    );
  });
});

test('T12: pack JSON `[]` -> throws exactly E-SHAPE', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const packDir = conventionDirFor(vaultDir);
    fs.mkdirSync(packDir, { recursive: true });
    const jsonPath = path.join(packDir, 'vault.config.json');
    fs.writeFileSync(jsonPath, '[]');

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    assert.throws(
      () => resolveVaultContext(baseCtxInfo(vaultDir)),
      (err) => err instanceof VaultUnreachableError && err.message === eShape(jsonPath),
    );
  });
});

test('T13: pack vaultPath "../../../elsewhere" resolves relative to the pack directory', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const packDir = conventionDirFor(vaultDir);
    writePackDir(packDir, { siteTitle: 'CONVENTION-PACK', vaultPath: '../../../elsewhere' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir));

    assert.equal(result.vaultMismatch.siteConfigVaultPath, path.join(dir, 'elsewhere'));
    assert.equal(result.vaultMismatch.siteConfigPath, path.join(packDir, 'vault.config.json'));
  });
});

test('T13b: pack vaultPath "../.." resolves to the real vault, so vaultMismatch is null', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const packDir = conventionDirFor(vaultDir);
    writePackDir(packDir, { siteTitle: 'CONVENTION-PACK', vaultPath: '../..' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const result = resolveVaultContext(baseCtxInfo(vaultDir));

    assert.equal(result.vaultMismatch, null);
  });
});

test('T14: pack JSON is read through read.readText (module-object call), never for the legacy path', () => {
  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const packDir = conventionDirFor(vaultDir);
    const jsonPath = writeLegacySiteConfig(packDir, { siteTitle: 'CONVENTION-PACK' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const spy = mock.method(readModule, 'readText');
    try {
      resolveVaultContext(baseCtxInfo(vaultDir));
      assert.equal(spy.mock.calls.length, 1);
      assert.equal(spy.mock.calls[0].arguments[0], jsonPath);
    } finally {
      spy.mock.restore();
    }
  });

  withScratchDir((dir) => {
    const vaultDir = makeVault(dir);
    const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });

    const { resolveVaultContext } = requireFresh('../src/cli/check');
    const spy = mock.method(readModule, 'readText');
    try {
      resolveVaultContext(baseCtxInfo(vaultDir, { site_config: legacyPath }));
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});

test('T15: a matched profile can override "pack" (through resolveCampaignContext + resolveVaultContext)', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const vaultDir = makeVault(dir);
      const packA = writePackDir(path.join(dir, 'pack-a'), { siteTitle: 'A' });
      const packB = writePackDir(path.join(dir, 'pack-b'), { siteTitle: 'B' });
      const configPath = path.join(dir, 'config.toml');
      const toml = [
        'config_version = 1',
        'default_campaign = "alpha"',
        '',
        '[campaigns.alpha]',
        `vault = '${vaultDir}'`,
        `pack = '${packA}'`,
        `output = '${path.join(dir, 'out')}'`,
        '',
        '[campaigns.alpha.paths.profile-z]',
        `match = { platform = "${process.platform}" }`,
        `pack = '${packB}'`,
      ].join('\n');
      fs.writeFileSync(configPath, toml);

      const { resolveCampaignContext } = requireFresh('../src/cli/args');
      const { resolveVaultContext } = requireFresh('../src/cli/check');
      const ctxInfo = resolveCampaignContext({ config: configPath }, 'alpha');
      const result = resolveVaultContext(ctxInfo);

      assert.equal(result.siteDir, packB);
    });
  });
});

test("T15b: base site_config, profile site_config = '' and pack -> 'pack'", () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const vaultDir = makeVault(dir);
      const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });
      const packB = writePackDir(path.join(dir, 'pack-b'), { siteTitle: 'B' });
      const configPath = path.join(dir, 'config.toml');
      const toml = [
        'config_version = 1',
        'default_campaign = "alpha"',
        '',
        '[campaigns.alpha]',
        `vault = '${vaultDir}'`,
        `site_config = '${legacyPath}'`,
        `output = '${path.join(dir, 'out')}'`,
        '',
        '[campaigns.alpha.paths.profile-z]',
        `match = { platform = "${process.platform}" }`,
        `site_config = ''`,
        `pack = '${packB}'`,
      ].join('\n');
      fs.writeFileSync(configPath, toml);

      const { resolveCampaignContext } = requireFresh('../src/cli/args');
      const { resolveVaultContext } = requireFresh('../src/cli/check');
      const ctxInfo = resolveCampaignContext({ config: configPath }, 'alpha');
      const result = resolveVaultContext(ctxInfo);

      assert.equal(result.siteSource, 'pack');
      assert.equal(result.siteDir, packB);
    });
  });
});

test('T16: --site-config flag wins over a TOML "pack" key, and the pack is reported shadowed', () => {
  withCleanProfileEnv(() => {
    withScratchDir((dir) => {
      const vaultDir = makeVault(dir);
      const legacyPath = writeLegacySiteConfig(path.join(dir, 'site'), { siteTitle: 'LEGACY-SITE' });
      const packB = writePackDir(path.join(dir, 'pack-b'), { siteTitle: 'B' });
      const configPath = path.join(dir, 'config.toml');
      const toml = [
        'config_version = 1',
        'default_campaign = "alpha"',
        '',
        '[campaigns.alpha]',
        `vault = '${vaultDir}'`,
        `pack = '${packB}'`,
        `output = '${path.join(dir, 'out')}'`,
      ].join('\n');
      fs.writeFileSync(configPath, toml);

      const { resolveCampaignContext } = requireFresh('../src/cli/args');
      const { resolveVaultContext } = requireFresh('../src/cli/check');
      const ctxInfo = resolveCampaignContext({ config: configPath, 'site-config': legacyPath }, 'alpha');
      const result = resolveVaultContext(ctxInfo);

      assert.equal(result.siteSource, 'site_config');
      assert.equal(result.packShadowed.packSource, 'pack');
      assert.equal(result.packShadowed.packDir, packB);
    });
  });
});
