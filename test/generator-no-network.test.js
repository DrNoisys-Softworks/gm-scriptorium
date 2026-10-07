'use strict';

/*
 * FR-19/SD-19 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): the runtime
 * no-network guarantee. src/generator/netguard.js is process-lifetime, so these tests spawn a
 * fresh child process per scenario rather than requiring it in-process (this repo's process is
 * already guarded, transitively, the moment anything requires src/generator/pinned.js -- which
 * `npm test` itself does across many other files -- so an in-process "before" state doesn't
 * exist to test against here).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runNode(script) {
  const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  return result;
}

test('installNetworkGuard(): a direct fetch() call throws a ScriptoriumError and attempts() goes 0 to 1', () => {
  const script = `
    const { installNetworkGuard, attempts } = require('./src/generator/netguard');
    installNetworkGuard();
    if (attempts() !== 0) throw new Error('expected 0 before any call, got ' + attempts());
    let threw = null;
    try { globalThis.fetch('https://example.invalid'); } catch (err) { threw = err; }
    if (!threw) throw new Error('expected fetch() to throw');
    if (threw.name !== 'ScriptoriumError') throw new Error('expected ScriptoriumError, got ' + threw.name);
    if (!threw.message.startsWith('network access is disabled in Scriptorium')) {
      throw new Error('unexpected message: ' + threw.message);
    }
    if (attempts() !== 1) throw new Error('expected 1 after one call, got ' + attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('installNetworkGuard(): plain reassignment does not remove the guard', () => {
  const script = `
    const { installNetworkGuard, attempts } = require('./src/generator/netguard');
    installNetworkGuard();
    globalThis.fetch = async (u) => new Response('not the real network');
    let threw = null;
    try { globalThis.fetch('https://example.invalid'); } catch (err) { threw = err; }
    if (!threw) throw new Error('expected fetch() to still throw after reassignment');
    if (attempts() !== 1) throw new Error('expected 1, got ' + attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('installNetworkGuard(): idempotent -- a second install call does not reset attempts() or double-wrap', () => {
  const script = `
    const netguard = require('./src/generator/netguard');
    const first = netguard.installNetworkGuard();
    if (first.installed !== true) throw new Error('expected the first call to report installed:true');
    try { globalThis.fetch(); } catch (_) {}
    const second = netguard.installNetworkGuard();
    if (second.installed !== false) throw new Error('expected the second call to report installed:false');
    if (netguard.attempts() !== 1) throw new Error('expected attempts() to stay 1, got ' + netguard.attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('installNetworkGuard(): guards WebSocket too, when present', () => {
  const script = `
    globalThis.WebSocket = function () { throw new Error('should never construct'); };
    const { installNetworkGuard, attempts } = require('./src/generator/netguard');
    installNetworkGuard();
    let threw = null;
    try { globalThis.WebSocket('wss://example.invalid'); } catch (err) { threw = err; }
    if (!threw || threw.name !== 'ScriptoriumError') throw new Error('expected a guarded WebSocket to throw ScriptoriumError');
    if (attempts() !== 1) throw new Error('expected 1, got ' + attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('requiring src/generator/pinned.js installs the guard (module-load install)', () => {
  const script = `
    require('./src/generator/pinned');
    const { attempts } = require('./src/generator/netguard');
    let threw = null;
    try { globalThis.fetch(); } catch (err) { threw = err; }
    if (!threw || threw.name !== 'ScriptoriumError') throw new Error('expected pinned.js to have installed the guard');
    if (attempts() !== 1) throw new Error('expected 1, got ' + attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('requiring src/generator/bootstrap.js installs the guard (module-load install)', () => {
  const script = `
    require('./src/generator/bootstrap');
    const { attempts } = require('./src/generator/netguard');
    let threw = null;
    try { globalThis.fetch(); } catch (err) { threw = err; }
    if (!threw || threw.name !== 'ScriptoriumError') throw new Error('expected bootstrap.js to have installed the guard');
    if (attempts() !== 1) throw new Error('expected 1, got ' + attempts());
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

// --- FR-19 runtime: a real build/check/preview run makes zero guarded calls, and the vault stays
// byte-unchanged, on a self-host-fonts fixture (a non-generic family, which is exactly the case
// that would trigger lib/fonts.js's prefetch if Scriptorium ever called it). ---

const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand } = require('../src/cli/check');
const { runPreviewBuild } = require('../src/admin/preview');
const { resolveCampaignContext } = require('../src/cli/args');
const netguard = require('../src/generator/netguard');

function sha256OfTree(dir) {
  const crypto = require('crypto');
  const out = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else out.push([r, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  })(dir, '');
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

test('FR-19 runtime: build+check+preview on a self-host-fonts fixture make zero guarded calls; vault byte-unchanged; no font-cache', () => {
  // A minimal, self-contained, definitely-clean vault (not mini-vault: that fixture deliberately
  // carries broken-frontmatter/ambiguous-name/dead-link cases for other tests, and
  // runPreviewBuild offers no --force/--no-check to build past them -- FR29, by design).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fr19-runtime-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'Locations'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, '_meta'), { recursive: true });

    fs.writeFileSync(
      path.join(vaultDir, 'Locations', 'Town-Square.md'),
      ['---', 'type: location', 'title: Town Square', '---', '', 'The heart of the settlement.', ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(vaultDir, '_meta', 'entity-types.md'),
      ['---', 'type: reference', '---', '', '# Entity types', '', '- location', ''].join('\n'),
    );
    // publish.theme.fonts lives in _meta/vault-config.md's own publish: frontmatter block (the
    // pin's own PUBLISH_DEFAULTS.theme, lib/config.js), the same surface exclude_sections/
    // exclude_dirs already use. A non-generic heading family under self-host is exactly the case
    // that would need lib/fonts.js's prefetch if Scriptorium ever called it (OD-1: it never does).
    // mode: gm sidesteps the manifest-review gate entirely (player mode requires
    // _meta/publish-manifest.md, orthogonal to what this test is about).
    fs.writeFileSync(
      path.join(vaultDir, '_meta', 'vault-config.md'),
      [
        '---',
        'type: meta',
        'publish:',
        '  mode: gm',
        '  theme:',
        '    fonts:',
        '      source: self-host',
        '      heading: Cinzel Decorative',
        '---',
        '',
        '# Vault config',
        '',
        'Synthetic fixture. Not a real campaign.',
        '',
      ].join('\n'),
    );

    const beforeHashes = sha256OfTree(vaultDir);

    const siteConfig = {
      siteTitle: 'FR-19 Runtime',
      siteUrl: 'https://example.invalid',
      vaultPath: vaultDir,
      outputDir: './out',
      attachmentsDir: '_attachments',
      folderMap: { Locations: 'locations' },
      excludeDirs: ['_meta'],
    };
    const siteConfigPath = path.join(scratch, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfig));

    const outDir = path.join(scratch, 'out');
    const configToml = path.join(scratch, 'config.toml');
    fs.writeFileSync(
      configToml,
      [
        'config_version = 1',
        'default_campaign = "fr19"',
        '',
        '[campaigns.fr19]',
        `vault = '${vaultDir}'`,
        `site_config = '${siteConfigPath}'`,
        `output = '${outDir}'`,
        '',
      ].join('\n'),
    );

    const attemptsBefore = netguard.attempts();

    const buildResult = runBuildCommand({ config: configToml, 'no-check': true, force: true }, 'fr19');
    assert.equal(buildResult.exitCode, 0, buildResult.human);

    const checkResult = runCheckCommand({ config: configToml }, 'fr19');
    assert.ok([0, 2].includes(checkResult.exitCode), checkResult.human);

    const ctxInfo = resolveCampaignContext({ config: configToml }, 'fr19');
    const previewDir = path.join(scratch, 'preview');
    const previewResult = runPreviewBuild({ ctxInfo, previewDir });
    assert.equal(previewResult.exitCode, 0, previewResult.human);

    assert.equal(netguard.attempts(), attemptsBefore, 'no guarded network call across build+check+preview');

    const afterHashes = sha256OfTree(vaultDir);
    assert.deepEqual(afterHashes, beforeHashes, 'the vault must be byte-unchanged');

    assert.equal(fs.existsSync(path.join(vaultDir, '_meta', 'font-cache')), false, 'no _meta/font-cache must be created');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
