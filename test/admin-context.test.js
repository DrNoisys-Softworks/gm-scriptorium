'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAdminContext, runExclusive } = require('../src/admin/context');
const { readPackFile } = require('../src/admin/packfiles');
const { resolveVaultSite, resolveVaultContext } = require('../src/cli/check');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md, "Test-first order"
 * item 4). Synthetic cast only (NFR-10/NFR-11); scratch dirs only, never test/fixtures.
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-context-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- runExclusive ------------------------------------------------------------

test('runExclusive: busy gives {ok:false, busy} and fn is not called', async () => {
  const ctx = { busy: 'building' };
  let called = false;
  const result = await runExclusive(ctx, 'check', async () => {
    called = true;
  });
  assert.deepEqual(result, { ok: false, busy: 'building' });
  assert.equal(called, false);
});

test('runExclusive: busy clears after a throw', async () => {
  const ctx = { busy: null };
  await assert.rejects(
    () =>
      runExclusive(ctx, 'check', async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(ctx.busy, null);
});

test('runExclusive: a successful run sets then clears busy, and returns the value', async () => {
  const ctx = { busy: null };
  let busyDuring = null;
  const result = await runExclusive(ctx, 'check', async () => {
    busyDuring = ctx.busy;
    return 42;
  });
  assert.equal(busyDuring, 'check');
  assert.equal(ctx.busy, null);
  assert.deepEqual(result, { ok: true, value: 42 });
});

// --- readPackFile --------------------------------------------------------

test('readPackFile: sha256 equals a literal hex, computed once with sha256sum for a fixed content string', () => {
  withScratchDir((dir) => {
    const packDir = path.join(dir, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    const content = 'theme = "plain"\n';
    fs.writeFileSync(path.join(packDir, 'pack.toml'), content);

    // Literal, computed once independently of this codebase:
    //   $ printf 'theme = "plain"\n' | sha256sum
    //   9225ea257c5c72bb27d65bb0acff2e22e26a247f99273dd5c8af2cea24fbecc4
    const expected = '9225ea257c5c72bb27d65bb0acff2e22e26a247f99273dd5c8af2cea24fbecc4';

    const ctx = { packDir, siteConfigPath: path.join(packDir, 'vault.config.json') };
    const result = readPackFile(ctx, 'pack.toml');
    assert.equal(result.exists, true);
    assert.equal(result.sha256, expected);
    assert.equal(result.sha256.length, 64);
  });
});

test('readPackFile: an absent file gives exists:false with raw and sha256 null', () => {
  withScratchDir((dir) => {
    const packDir = path.join(dir, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    const ctx = { packDir, siteConfigPath: path.join(packDir, 'vault.config.json') };
    const result = readPackFile(ctx, 'pack.toml');
    assert.deepEqual(result, { name: 'pack.toml', path: path.join(packDir, 'pack.toml'), exists: false, raw: null, sha256: null });
  });
});

test('readPackFile: for site_config, vault.config.json maps to ctx.siteConfigPath', () => {
  withScratchDir((dir) => {
    const siteConfigPath = path.join(dir, 'somewhere', 'site.json');
    fs.mkdirSync(path.dirname(siteConfigPath), { recursive: true });
    fs.writeFileSync(siteConfigPath, '{"siteTitle":"X"}\n');
    const ctx = { packDir: path.join(dir, 'unused'), siteConfigPath };
    const result = readPackFile(ctx, 'vault.config.json');
    assert.equal(result.exists, true);
    assert.equal(result.path, siteConfigPath);
  });
});

test('readPackFile: an unknown name throws', () => {
  const ctx = { packDir: '/nowhere', siteConfigPath: '/nowhere/vault.config.json' };
  assert.throws(() => readPackFile(ctx, 'other.toml'));
});

// --- resolveVaultSite --------------------------------------------------------

function writeConventionVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"X","excludeDirs":[],"folderMap":{}}\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  return vaultPath;
}

test('resolveVaultSite returns the same site as resolveVaultContext for the convention source', () => {
  withScratchDir((dir) => {
    const vaultPath = writeConventionVault(dir);
    const ctxInfo = { campaign: 'alpha', vault: vaultPath };
    const { vaultPath: vp1, site } = resolveVaultSite(ctxInfo);
    const full = resolveVaultContext(ctxInfo);
    assert.equal(vp1, full.vaultPath);
    assert.equal(site.siteSource, full.siteSource);
    assert.equal(site.siteDir, full.siteDir);
    assert.equal(site.siteConfigPath, path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json'));
  });
});

test('resolveVaultSite returns the same site as resolveVaultContext for the pack source', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
    const packDir = path.join(dir, 'external-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"X","excludeDirs":[],"folderMap":{}}\n');

    const ctxInfo = { campaign: 'alpha', vault: vaultPath, pack: packDir };
    const { site } = resolveVaultSite(ctxInfo);
    const full = resolveVaultContext(ctxInfo);
    assert.equal(site.siteSource, 'pack');
    assert.equal(site.siteSource, full.siteSource);
    assert.equal(site.siteDir, full.siteDir);
  });
});

test('resolveVaultSite returns the same site as resolveVaultContext for the site_config source', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
    const siteConfigPath = path.join(dir, 'site.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ siteTitle: 'X', vaultPath: './vault', excludeDirs: [], folderMap: {} }));

    const ctxInfo = { campaign: 'alpha', vault: vaultPath, site_config: siteConfigPath };
    const { site } = resolveVaultSite(ctxInfo);
    const full = resolveVaultContext(ctxInfo);
    assert.equal(site.siteSource, 'site_config');
    assert.equal(site.siteSource, full.siteSource);
    assert.equal(site.siteDir, full.siteDir);
  });
});

// --- createAdminContext -------------------------------------------------

test('createAdminContext returns the full shape with null-initialised ports/busy', () => {
  const ctxInfo = { campaign: 'alpha' };
  const site = { siteSource: 'convention', siteConfigPath: '/v/_meta/scriptorium/vault.config.json', siteDir: '/v/_meta/scriptorium' };
  const ctx = createAdminContext({ ctxInfo, vaultPath: '/v', site, token: 'TOK' });
  assert.deepEqual(ctx, {
    campaign: 'alpha',
    ctxInfo,
    vaultPath: '/v',
    siteSource: 'convention',
    siteConfigPath: '/v/_meta/scriptorium/vault.config.json',
    packDir: '/v/_meta/scriptorium',
    writable: true,
    readOnlyReason: null,
    token: 'TOK',
    adminPort: null,
    previewPort: null,
    previewDir: null,
    busy: null,
  });
});
