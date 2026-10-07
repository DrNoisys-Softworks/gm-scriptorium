'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runAtomicBuild } = require('../src/build/run');
const preview = require('../src/admin/preview');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultContext, resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const { GM_LINK_MARKER, findGmLinkMarker } = require('../src/build/gmmarker');

/*
 * Phase 8 slice S6 (docs/agent-runs/admin-s6-engineering-brief-2026-09-28.md, "Test-first order"
 * item 2). FR34(b) and (c): the output-gate marker refusal is unconditional (no parameter or
 * flag disables it, --force included), proved through the REAL pipeline at three call depths
 * (runBuildCommand, a spawned CLI process, a direct runAtomicBuild call), each paired with a
 * positive control that differs only in whether the marker text is present. Synthetic cast only
 * (NFR-10/NFR-11); every vault here is written fresh into a scratch temp dir, never into
 * test/fixtures.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', ...opts });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  return res;
}

/** A minimal convention-pack scratch vault. Notes/Fine.md's body optionally carries the literal GM-link marker text, as prose -- not as a real GM link, which is the point: any note that happens to contain the literal string must refuse a build, the same as an actual leaked link would. */
function writeMarkerVault(root, { withMarker }) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n',
  );
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n',
  );
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n',
  );
  const body = withMarker
    ? `---\ntype: character\n---\n\n# Fine\n\nA stray literal ${GM_LINK_MARKER} snuck into this note's own prose.\n`
    : '---\ntype: character\n---\n\n# Fine\n';
  fs.writeFileSync(path.join(vaultPath, 'Notes', 'Fine.md'), body);

  const configPath = path.join(root, 'config.toml');
  const output = path.join(root, 'out');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${output}'`, ''].join('\n'),
  );
  return { vaultPath, packDir, configPath, output };
}

async function withMarkerVault(withMarker, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-gate-'));
  try {
    return await fn(writeMarkerVault(root, { withMarker }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function scratchCopyVault(fixtureName, root) {
  const dest = path.join(root, fixtureName);
  fs.cpSync(path.join(__dirname, 'fixtures', fixtureName), dest, { recursive: true });
  return dest;
}

function scratchCopySiteConfig(fixtureName, root) {
  const src = path.join(__dirname, 'fixtures', `${fixtureName}-site-config.json`);
  const dest = path.join(root, `${fixtureName}-site-config.json`);
  fs.cpSync(src, dest);
  return dest;
}

// --- FR34(b): runBuildCommand, real call site, both flags -----------------

test('FR34(b): runBuildCommand with force:true and no-check:true still refuses a vault whose text carries the marker; exit 2, output not written', async () => {
  await withMarkerVault(true, ({ configPath, output }) => {
    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, 2);
    assert.equal(result.envelope.refusedByScan, true);
    assert.ok(
      result.envelope.outputScanFindings.some((f) => f.id === 'build/gm-link-marker'),
      `expected a build/gm-link-marker finding; got: ${JSON.stringify(result.envelope.outputScanFindings.map((f) => f.id))}`,
    );
    assert.equal(fs.existsSync(output), false, 'the configured output must not exist after a refusal');
    const root = path.dirname(output);
    const leftover = fs.readdirSync(root).filter((e) => /^\.scriptorium-build-/.test(e));
    assert.deepEqual(leftover, [], 'no .scriptorium-build-* staging dir may be left behind');
  });
});

test('FR34(b) positive control: the same vault without the marker text, same flags, gives exit 0', async () => {
  await withMarkerVault(false, ({ configPath, output }) => {
    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, 0, result.human);
    assert.equal(result.envelope.ok, true);
    assert.ok(fs.existsSync(path.join(output, 'index.html')));
  });
});

// --- FR34(b): a spawned CLI process ----------------------------------------

test('FR34(b), CLI spawn: build --force exits 2 and stdout names build/gm-link-marker', async () => {
  await withMarkerVault(true, ({ configPath }, root) => {
    const res = run(['build', 'alpha', '--force', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 2);
    assert.match(res.stdout, /build\/gm-link-marker/);
  });
});

test('FR34(b), CLI spawn positive control: without the marker text, build --force exits 0', async () => {
  await withMarkerVault(false, ({ configPath }, root) => {
    const res = run(['build', 'alpha', '--force', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});

// --- FR34(b): runAtomicBuild called directly, force:true ------------------

test('FR34(b), direct runAtomicBuild({force:true}): still {ok:false, refusedByScan:true}', async () => {
  await withMarkerVault(true, ({ configPath, output }) => {
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'alpha');
    const { vaultPath, jsonConfig, siteDir } = resolveVaultContext(ctxInfo);
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut: output, siteDir, campaign: 'alpha', force: true });
    assert.equal(result.ok, false);
    assert.equal(result.refusedByScan, true);
  });
});

// --- FR34(b): the gate scans the fresh staging tree, not a stale preview --

test('a second preview build, after a first one injected GM links, still succeeds (the gate scans the fresh staging tree, not the old preview)', async () => {
  await withMarkerVault(false, async ({ configPath }) => {
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'alpha');
    const { vaultPath, site } = resolveVaultSite(ctxInfo);
    const ctx = createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
    ctx.adminPort = 34567;
    preview.ensurePreviewRoot(ctx);
    try {
      const build1 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build1.exitCode, 0, build1.human);
      assert.ok(findGmLinkMarker(ctx.previewDir).length > 0, 'expected the first build to actually inject a GM link');

      const build2 = preview.buildPreviewWithGmLink(ctx);
      assert.equal(build2.exitCode, 0, build2.human);
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- FR34(c): CLI builds of the synthetic vaults contain no marker --------
// Named per CLAUDE.md's testing standard: this passes today because no marker exists yet in
// either fixture. On its own it proves nothing; it only means something paired with the
// --force refusal tests above, which prove the SAME gate does refuse when the marker IS present.

test('FR34(c): a CLI build of a scratch copy of vocab-vault contains no marker (paired with the --force refusal above)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-frc-vocab-'));
  try {
    const dest = scratchCopyVault('vocab-vault', root);
    const output = path.join(root, 'out-vocab');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${dest}'`, `output = '${output}'`, ''].join('\n'),
    );
    const res = run(['build', 'vocab', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(findGmLinkMarker(output), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR34(c): a CLI build of a scratch copy of mini-vault contains no marker (paired with the --force refusal above)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-frc-mini-'));
  try {
    const dest = scratchCopyVault('mini-vault', root);
    const siteConfigPath = scratchCopySiteConfig('mini-vault', root);
    const output = path.join(root, 'out-mini');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'config_version = 1',
        'default_campaign = "mini"',
        '',
        '[campaigns.mini]',
        `vault = '${dest}'`,
        `site_config = '${siteConfigPath}'`,
        `output = '${output}'`,
        '',
      ].join('\n'),
    );
    // mini-vault is a shared fixture deliberately full of pre-existing check ERRORs (broken
    // frontmatter, unresolved links) used by other suites; --force --no-check isolates this
    // test to the staging-tree scan the GM-link gate itself runs, the same way
    // test/build-output-gate.test.js's own CLI test does.
    const res = run(['build', 'mini', '--force', '--no-check', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(findGmLinkMarker(output), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- SD-1: the detector covers every file type, not only HTML --------------
// (M11: a walker that skips non-.html files would miss a marker that only reached the search
// index. This is a direct, deterministic proof of the detector's own file-type coverage, rather
// than relying on the pin's generator to happen to place text there.)

test('SD-1: findGmLinkMarker catches a marker present only in a non-.html file (e.g. search-index.json)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-filetype-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>no marker here</body></html>');
    fs.writeFileSync(path.join(root, 'search-index.json'), JSON.stringify({ text: `stray ${GM_LINK_MARKER} in the index` }));
    const hits = findGmLinkMarker(root);
    assert.deepEqual(hits, ['search-index.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- C42 step 6's fixture assumption (docs/HANDOVER-WINDOWS.md): the note TYPE matters ---------
// The Windows verifier found, testing rc.2 on Windows 2026-09-29, that following C42 step 6 literally --
// appending the marker to a note under vocab-vault's People\ -- gives a FALSE PASS: those notes
// are `type: pc`, whose template publishes only the first body line as a pull quote, so an
// appended line never reaches the staged tree and the gate has nothing to refuse (exit 0, looks
// like the gate failed open, when it was never exercised). Against Episodes\, where prose
// actually publishes, the gate does refuse. These two tests pin that exact real-fixture
// assumption with the real pipeline, not a synthetic vault, so it cannot silently drift back.

test("C42 step 6, real fixture: a marker appended to vocab-vault's Episodes/Episode-01.md (prose that publishes) is refused, exit 2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-c42-episode-'));
  try {
    const dest = scratchCopyVault('vocab-vault', root);
    fs.appendFileSync(path.join(dest, 'Episodes', 'Episode-01.md'), `\n${GM_LINK_MARKER}\n`);
    const output = path.join(root, 'out');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${dest}'`, `output = '${output}'`, ''].join('\n'),
    );
    const res = run(['build', 'vocab', '--force', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /build\/gm-link-marker/);
    assert.equal(fs.existsSync(output), false, 'a refused build must write nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("C42 step 6, real fixture: the SAME marker appended to vocab-vault's People/Doran Vex.md (type: pc, publishes only a pull quote) never reaches the staged tree, exit 0", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gm-link-c42-people-'));
  try {
    const dest = scratchCopyVault('vocab-vault', root);
    // A second body line, not the first: type: pc's template publishes only the first body line
    // as a pull quote (confirmed live on Windows), so the marker must land after it to reproduce
    // the exact false-pass Win found by following the step literally.
    fs.appendFileSync(path.join(dest, 'People', 'Doran Vex.md'), `\n${GM_LINK_MARKER}\n`);
    const output = path.join(root, 'out');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${dest}'`, `output = '${output}'`, ''].join('\n'),
    );
    const res = run(['build', 'vocab', '--force', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.deepEqual(findGmLinkMarker(output), [], 'the marker must never reach the staged tree from a type: pc note\'s non-publishing body');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Structural: run.js's call site --------------------------------------

test('structural: run.js keeps its exact runAtomicBuild signature line, and calls scanGmLinkMarker( exactly once, never inside an if() that mentions force', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'run.js'), 'utf8');
  const sigLine = src.split('\n').find((l) => l.includes('function runAtomicBuild('));
  assert.equal(
    sigLine.trim(),
    'function runAtomicBuild({ vaultPath, userJsonConfig, finalOut, siteDir, campaign, force = false, themePlan = null, vocab }) {',
  );

  const occurrences = [...src.matchAll(/scanGmLinkMarker\(/g)];
  assert.equal(occurrences.length, 1, `expected scanGmLinkMarker( exactly once in run.js, found ${occurrences.length}`);

  assert.doesNotMatch(
    src,
    /if\s*\([^)]*force[^)]*\)\s*\{[^}]*scanGmLinkMarker\(/s,
    'scanGmLinkMarker must never be called from inside an if() whose condition mentions force',
  );
});
