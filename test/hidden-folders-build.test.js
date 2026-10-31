'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite, runCheckCommand } = require('../src/cli/check');
const { runBuildCommand } = require('../src/cli/build');
const { createAdminContext } = require('../src/admin/context');
const preview = require('../src/admin/preview');
const candidatecheck = require('../src/admin/candidatecheck');
const { runExcludedDirInOutput } = require('../src/checks/leak/l2');
const { scanStagingOutput } = require('../src/build/outputgate');
const { moveVaultCopy, assertMovedLayout, onLayout } = require('./helpers/moved-vault');

// The cases that hide folders through the vault's settings run on both layouts: the old
// _meta/vault-config.md and the moved _meta/vault-config.yaml. Where a check compares the pack with
// the vault (config/exclude-dirs-divergence), the moved layout is silent by design: the carry checks own it.
const LAYOUTS = ['legacy', 'new'];

/*
 * Issue #141: a folder hidden only in _meta/vault-config.md is a WARN, and
 * leak/l2-excluded-dir-in-output is judged on the staging tree inside `build`
 * (deferred in the pre-build check). Expected values are literals, never read
 * from src. Scratch folders are removed in `finally`. Invented names only.
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');
const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

const L2 = 'leak/l2-excluded-dir-in-output';
const L2_DEFERRED_MESSAGE =
  "leak/l2-excluded-dir-in-output: the output scan is deferred to this build's own staging tree (it runs before the swap, not against the existing, about-to-be-replaced output)";
const HIDE_CHRONICLE = '---\ntype: meta\npublish:\n  mode: full\n  exclude_dirs:\n    - Chronicle\n---\n\nScratch config.\n';
const CHRONICLE_WARN_LINE =
  'WARN config/exclude-dirs-divergence  "Chronicle" is excluded in _meta/vault-config.md (publish.exclude_dirs) but not in vault.config.json (excludeDirs). This folder holds pages or images. A fresh build leaves it out, but a site built before the exclusion may still hold its files until you build again. Add it to excludeDirs in vault.config.json as well to clear this warning.';
const CHRONICLE_WARN_MESSAGE =
  '"Chronicle" is excluded in _meta/vault-config.md (publish.exclude_dirs) but not in vault.config.json (excludeDirs). This folder holds pages or images. A fresh build leaves it out, but a site built before the exclusion may still hold its files until you build again. Add it to excludeDirs in vault.config.json as well to clear this warning.';

function withScratch(label, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-141-${label}-`));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function vocabScratch(root, layout = 'legacy') {
  let vaultPath;
  if (layout === 'new') {
    // The pin's move, with the pack in the vault folded into the yaml.
    vaultPath = moveVaultCopy(VOCAB_VAULT_SRC, path.join(root, 'moved'), { inVaultPack: true }).vaultPath;
    assertMovedLayout(vaultPath);
  } else {
    vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    assert.ok(fs.existsSync(path.join(vaultPath, '_meta', 'vault-config.md')));
  }
  const configPath = path.join(root, 'config.toml');
  const out = path.join(root, 'out');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${out}'`, ''].join('\n'),
  );
  return { vaultPath, configPath, out };
}

/**
 * Hide Chronicle in the vault's settings, replacing them as HIDE_CHRONICLE does. On the moved layout
 * the yaml is the one the pin's move makes from the same settings, so the edit is the same hide.
 */
function hideChronicle(vaultPath, layout = 'legacy') {
  if (layout === 'legacy') {
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), HIDE_CHRONICLE);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-141-hide-'));
  try {
    const src = path.join(root, 'src');
    fs.cpSync(VOCAB_VAULT_SRC, src, { recursive: true });
    fs.writeFileSync(path.join(src, '_meta', 'vault-config.md'), HIDE_CHRONICLE);
    const moved = moveVaultCopy(src, path.join(root, 'moved'), { inVaultPack: true }).vaultPath;
    fs.copyFileSync(path.join(moved, '_meta', 'vault-config.yaml'), path.join(vaultPath, '_meta', 'vault-config.yaml'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assertMovedLayout(vaultPath);
}

/** Every relative file path under `dir`, POSIX separators; [] when `dir` is absent. */
function listTree(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  })(dir, '');
  return out;
}

function chronicleFiles(dir) {
  return listTree(dir).filter((rel) => rel.split('/')[0] === 'chronicle');
}

// --- T7: the pre-build deferral ---------------------------------------------------------------

test('T7: l2 under deferOutputScan gives exactly one INFO with the deferral message, whatever the output path', () => {
  const findings = runExcludedDirInOutput({
    campaign: 'unit',
    outputPath: '/does/not/matter',
    outputPathConfigured: '/does/not/matter',
    deferOutputScan: true,
  });
  assert.equal(findings.length, 1);
  assert.deepEqual(
    { id: findings[0].id, severity: findings[0].severity, message: findings[0].message },
    { id: L2, severity: 'info', message: L2_DEFERRED_MESSAGE },
  );
});

// --- T8, T9: the staging gate ------------------------------------------------------------------

const STAGED_L2_EXPECTED = [
  {
    id: L2,
    severity: 'error',
    path: '_attachments/personal/hidden-map.png',
    outputPath: 'images/personal/hidden-map.png',
    message: 'images/personal/hidden-map.png is copied from _attachments/personal/hidden-map.png, which is under excluded directory "personal"',
  },
  {
    id: L2,
    severity: 'error',
    path: 'Scenes/Active-Scene.md',
    outputPath: 'scenes/active-scene.html',
    message: 'scenes/active-scene.html is built from Scenes/Active-Scene.md, which is under excluded directory "Scenes"',
  },
];

function stagedL2(root, { withIndex, layout }) {
  const stagingOut = path.join(root, 'staging');
  fs.mkdirSync(path.join(stagingOut, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(stagingOut, 'images', 'personal'), { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(stagingOut, 'index.html'), '<html><body>Home</body></html>');
  fs.writeFileSync(path.join(stagingOut, 'scenes', 'active-scene.html'), '<html><body>Scene</body></html>');
  fs.writeFileSync(path.join(stagingOut, 'images', 'personal', 'hidden-map.png'), 'png');
  const { vaultPath, jsonConfig } = onLayout(layout, PIN_VAULT, PIN_SITE_CONFIG, path.join(root, 'layout'));
  const findings = scanStagingOutput({
    vaultPath,
    jsonConfig,
    stagingOut,
    campaign: 'pin-vault',
  });
  return findings
    .filter((f) => f.id === L2)
    .map((f) => ({ id: f.id, severity: f.severity, path: f.path, outputPath: f.outputPath, message: f.message }))
    .sort((a, b) => (a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0));
}

for (const layout of LAYOUTS) {
  test(`T8: the staging gate reports l2 ERRORs for excluded-folder pages and images in the staged tree [${layout}]`, () => {
    withScratch('gate', (root) => {
      assert.deepEqual(stagedL2(root, { withIndex: true, layout }), STAGED_L2_EXPECTED);
    });
  });

  test(`T9: the staging gate reports the same two l2 ERRORs when the staged tree has no index.html [${layout}]`, () => {
    withScratch('gate-noindex', (root) => {
      assert.deepEqual(stagedL2(root, { withIndex: false, layout }), STAGED_L2_EXPECTED);
    });
  });
}

// --- T10: FR-06 --------------------------------------------------------------------------------

for (const layout of LAYOUTS) {
  test(`T10: hiding Chronicle only in vault-config.md gives check exit 0 with one WARN line, and a flagless build leaves Chronicle out [${layout}]`, () => {
    withScratch('fr06', (root) => {
      const { vaultPath, configPath, out } = vocabScratch(root, layout);
      hideChronicle(vaultPath, layout);

      const checked = runCheckCommand({ config: configPath }, 'vocab');
      assert.equal(checked.exitCode, 0, checked.human);
      assert.equal(checked.envelope.counts.error, 0);
      assert.deepEqual(
        checked.human.split('\n').filter((line) => line === CHRONICLE_WARN_LINE),
        layout === 'legacy' ? [CHRONICLE_WARN_LINE] : [], // the pack-against-vault warning is the carry checks' job on a moved vault
      );

      const built = runBuildCommand({ config: configPath }, 'vocab');
      assert.equal(built.exitCode, 0, built.human);
      assert.ok(listTree(out).length > 0, 'the build wrote a site');
      assert.deepEqual(chronicleFiles(out), []);
    });
  });

  // --- T11: hide after publish, CLI --------------------------------------------------------------

  test(`T11: hide a published folder, then check errors on the old site, build succeeds and removes it, check goes clean [${layout}]`, () => {
    withScratch('hide-after', (root) => {
      const { vaultPath, configPath, out } = vocabScratch(root, layout);

      const first = runBuildCommand({ config: configPath }, 'vocab');
      assert.equal(first.exitCode, 0, first.human);
      assert.ok(chronicleFiles(out).length > 0, 'precondition: Chronicle is published');

      hideChronicle(vaultPath, layout);

      const stale = runCheckCommand({ config: configPath }, 'vocab');
      assert.equal(stale.exitCode, 2, stale.human);
      const l2Errors = stale.envelope.findings.filter((f) => f.id === L2 && f.severity === 'error');
      assert.ok(l2Errors.length > 0);
      assert.ok(l2Errors.every((f) => f.outputPath.split('/')[0] === 'chronicle'));
      const divergence = stale.envelope.findings.filter((f) => f.id === 'config/exclude-dirs-divergence' && !f.data.jsonOnly);
      assert.deepEqual(
        divergence.map((f) => ({ severity: f.severity, message: f.message })),
        layout === 'legacy' ? [{ severity: 'warn', message: CHRONICLE_WARN_MESSAGE }] : [],
      );

      const rebuilt = runBuildCommand({ config: configPath }, 'vocab');
      assert.equal(rebuilt.exitCode, 0, rebuilt.human);
      const deferred = rebuilt.envelope.check.findings.filter((f) => f.id === L2);
      assert.deepEqual(
        deferred.map((f) => ({ severity: f.severity, message: f.message })),
        [{ severity: 'info', message: L2_DEFERRED_MESSAGE }],
      );
      assert.deepEqual(chronicleFiles(out), []);

      const after = runCheckCommand({ config: configPath }, 'vocab');
      assert.deepEqual(
        after.envelope.findings.filter((f) => f.id === L2 && f.severity === 'error'),
        [],
      );
    });
  });

  // --- T12: panel preview ------------------------------------------------------------------------

  test(`T12: the panel preview build succeeds after a published folder is hidden, and the preview drops it [${layout}]`, () => {
    withScratch('panel', (root) => {
      const { vaultPath, configPath } = vocabScratch(root, layout);
      const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
      const { vaultPath: resolvedVault, site } = resolveVaultSite(ctxInfo);
      const ctx = createAdminContext({ ctxInfo, vaultPath: resolvedVault, site, token: 'TOK' });
      preview.ensurePreviewRoot(ctx);
      try {
        const first = preview.runPreviewBuild(ctx);
        assert.equal(first.exitCode, 0, first.human);
        assert.ok(chronicleFiles(ctx.previewDir).length > 0, 'precondition: the preview holds Chronicle');

        hideChronicle(vaultPath, layout);
        const second = preview.runPreviewBuild(ctx);
        assert.equal(second.exitCode, 0, second.human);
        assert.deepEqual(chronicleFiles(ctx.previewDir), []);
      } finally {
        preview.removePreviewRoot(ctx);
      }
    });
  });
}

// --- T13: FR-07 --------------------------------------------------------------------------------

test('T13: the candidate check for hiding Chronicle adds one WARN and no new error', () => {
  withScratch('candidate', (root) => {
    const { configPath } = vocabScratch(root);
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
    const { vaultPath } = resolveVaultSite(ctxInfo);
    const rv = candidatecheck.runReview({ vaultPath, ctxInfo }, { candidateBytes: Buffer.from(HIDE_CHRONICLE, 'utf8'), withCheck: true });
    assert.equal(rv.check.newErrorCount, 0);
    assert.deepEqual(
      rv.check.newFindings.map((f) => ({ id: f.id, severity: f.severity, path: f.path })),
      [{ id: 'config/exclude-dirs-divergence', severity: 'warn', path: null }],
    );
  });
});
