'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const gmaccess = require('../src/build/gmaccess');
const { GM_ACCESS_MARKER, gmAccessHref, gmAccessSnippet, injectGmAccessLink } = gmaccess;
const { GM_LINK_MARKER } = require('../src/build/gmmarker');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultContext, resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const preview = require('../src/admin/preview');

/*
 * The published GM link, through the real build. The off build is the parent's build, byte for
 * byte: (a) the writer touches nothing when off, (b) an on build minus the one snippet per page
 * equals the off build, (c) the injection runs before all three output gates, (d) the gates still
 * refuse with the link on, (e) the preview carries the link. Synthetic vaults only.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const ONE_PIXEL_PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'pin-vault', '_attachments', 'personal', 'hidden-map.png'));
const GM_URL = 'https://gm.example.net';
const GM_TOML = `[gm_link]\nurl = "${GM_URL}"\n`;

function cliEnv(root, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  return env;
}

function runBin(args, root, extraEnv) {
  const res = spawnSync(process.execPath, [BIN, ...args], { env: cliEnv(root, extraEnv), encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL' });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  return res;
}

/**
 * A scratch campaign: a few published pages (so there is more than index.html), a pack.toml of the
 * caller's choosing, and optionally a withheld note whose image a published page embeds (a leak),
 * a %% comment (for the comment gate) or the preview marker text.
 */
function writeVault(root, { pack = 'theme = "plain"\n', leak = false, comment = false, marker = false } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config body\n');
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n- [x] Notes/Second.md\n',
  );
  fs.writeFileSync(path.join(packDir, 'pack.toml'), pack);
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Alpha Test', folderMap: { Notes: 'notes' }, attachmentsDir: '_attachments', excludeDirs: ['_meta'] }, null, 2) + '\n',
  );
  const fine = ['---\ntype: character\n---\n\n# Fine\n\nAn ordinary page.\n'];
  if (leak) fine.push('\n![[secret-witness.png]]\n');
  if (comment) fine.push('\nA visible line %%ZQXHIDDEN-COMMENT%% and more.\n');
  if (marker) fine.push(`\nA stray literal ${GM_LINK_MARKER} in prose.\n`);
  fs.writeFileSync(path.join(vaultPath, 'Notes', 'Fine.md'), fine.join(''));
  fs.writeFileSync(path.join(vaultPath, 'Notes', 'Second.md'), '---\ntype: character\n---\n\n# Second\n\nAnother page.\n');
  if (leak) {
    fs.writeFileSync(path.join(vaultPath, 'Notes', 'Secret-Witness.md'), '---\ntype: character\ntitle: Secret Witness\nwithheld: true\n---\nNever meant to reach a player.\n');
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'secret-witness.png'), ONE_PIXEL_PNG);
  }
  const configPath = path.join(root, 'config.toml');
  const output = path.join(root, 'out');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${output}'`, ''].join('\n'),
  );
  return { vaultPath, packDir, configPath, output };
}

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gma-build-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function listFiles(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// (a) off writes nothing -------------------------------------------------------------------------

test('(a) off writes nothing: injectGmAccessLink(tree, null) with every fs writer patched to throw returns { pagesLinked: 0 }', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body><p class="scriptorium-notice-link"><a href="NOTICE.txt">x</a></p></body></html>');
    const names = ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'copyFileSync', 'openSync', 'truncateSync'];
    const saved = {};
    for (const n of names) {
      saved[n] = fs[n];
      fs[n] = () => {
        throw new Error(`fs.${n} must not be called when the link is off`);
      };
    }
    try {
      assert.deepEqual(injectGmAccessLink(root, null, 'alpha'), { pagesLinked: 0 });
      assert.deepEqual(injectGmAccessLink(root, undefined, 'alpha'), { pagesLinked: 0 });
    } finally {
      for (const n of names) fs[n] = saved[n];
    }
  });
});

test('(a) control: with the link on, the same patched writer is hit (so the guard above can fail)', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body><p class="scriptorium-notice-link"><a href="NOTICE.txt">x</a></p></body></html>');
    const saved = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw new Error('hit');
    };
    try {
      assert.throws(() => injectGmAccessLink(root, { url: GM_URL }, 'alpha'), /hit/);
    } finally {
      fs.writeFileSync = saved;
    }
  });
});

// (b) on minus snippet equals off ----------------------------------------------------------------

test('(b) on minus the one snippet per page is byte-equal to the off build; same file set; non-HTML bytes equal', () => {
  withRoot((root) => {
    const offRoot = path.join(root, 'off');
    const onRoot = path.join(root, 'on');
    fs.mkdirSync(offRoot);
    fs.mkdirSync(onRoot);
    const off = writeVault(offRoot, { pack: 'theme = "plain"\n' });
    const on = writeVault(onRoot, { pack: `theme = "plain"\n${GM_TOML}` });
    const a = runBin(['build', 'alpha', '--config', off.configPath], offRoot);
    const b = runBin(['build', 'alpha', '--config', on.configPath], onRoot);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.equal(b.status, 0, b.stdout + b.stderr);

    const offFiles = listFiles(off.output);
    assert.deepEqual(listFiles(on.output), offFiles, 'same file set');
    assert.ok(offFiles.filter((f) => f.endsWith('.html')).length >= 3, 'a real multi-page site');

    const snippet = gmAccessSnippet(gmAccessHref(GM_URL, 'alpha'));
    let linked = 0;
    for (const f of offFiles) {
      const offBytes = fs.readFileSync(path.join(off.output, f));
      const onBytes = fs.readFileSync(path.join(on.output, f));
      if (!f.endsWith('.html')) {
        assert.equal(sha(onBytes), sha(offBytes), `${f}: non-HTML bytes equal`);
        continue;
      }
      const onText = onBytes.toString('utf8');
      const count = onText.split(snippet).length - 1;
      assert.ok(count <= 1, `${f}: at most one snippet`);
      if (count === 1) {
        linked++;
        assert.equal(onText.replace(snippet, ''), offBytes.toString('utf8'), `${f}: on minus snippet equals off`);
      } else {
        assert.equal(onText, offBytes.toString('utf8'), `${f}: an unlinked page is unchanged`);
      }
    }
    assert.ok(linked >= 3, `expected the link on every page with a notice footer, linked ${linked}`);
    // the off build carries neither marker
    for (const f of offFiles) assert.ok(!fs.readFileSync(path.join(off.output, f)).includes(GM_ACCESS_MARKER), f);
  });
});

// (c) ordering -----------------------------------------------------------------------------------

test('(c) the injection runs before all three output gates: each saw the new marker in the staged index.html', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: 'theme = "plain"\n' });
    const gate = require('../src/build/outputgate');
    const names = ['scanGmLinkMarker', 'scanCommentSurvivors', 'scanStagingOutput'];
    const originals = {};
    const seen = {};
    for (const n of names) {
      originals[n] = gate[n];
      gate[n] = (args) => {
        seen[n] = fs.readFileSync(path.join(args.stagingOut, 'index.html'), 'utf8').includes(GM_ACCESS_MARKER);
        return originals[n](args);
      };
    }
    const runPath = require.resolve('../src/build/run');
    delete require.cache[runPath];
    try {
      const { runAtomicBuild } = require('../src/build/run');
      const ctxInfo = resolveCampaignContext({ config: v.configPath }, 'alpha');
      const { vaultPath, jsonConfig, siteDir } = resolveVaultContext(ctxInfo);
      const result = runAtomicBuild({
        vaultPath,
        userJsonConfig: jsonConfig,
        finalOut: v.output,
        siteDir,
        campaign: 'alpha',
        gmLink: { url: GM_URL },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(seen, { scanGmLinkMarker: true, scanCommentSurvivors: true, scanStagingOutput: true });
    } finally {
      for (const n of names) gate[n] = originals[n];
      delete require.cache[runPath];
    }
  });
});

test('(c) control: with gmLink omitted, no gate sees the marker (so the assertion above can be false)', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: 'theme = "plain"\n' });
    const gate = require('../src/build/outputgate');
    const original = gate.scanGmLinkMarker;
    let sawMarker = null;
    gate.scanGmLinkMarker = (args) => {
      sawMarker = fs.readFileSync(path.join(args.stagingOut, 'index.html'), 'utf8').includes(GM_ACCESS_MARKER);
      return original(args);
    };
    const runPath = require.resolve('../src/build/run');
    delete require.cache[runPath];
    try {
      const { runAtomicBuild } = require('../src/build/run');
      const ctxInfo = resolveCampaignContext({ config: v.configPath }, 'alpha');
      const { vaultPath, jsonConfig, siteDir } = resolveVaultContext(ctxInfo);
      runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut: v.output, siteDir, campaign: 'alpha' });
      assert.equal(sawMarker, false);
    } finally {
      gate.scanGmLinkMarker = original;
      delete require.cache[runPath];
    }
  });
});

// (d) the gates still refuse with the link on ----------------------------------------------------

function assertRefused(res, v, id) {
  assert.equal(res.status, 2, `exit 2 expected, got ${res.status}: ${res.stdout}${res.stderr}`);
  assert.ok((res.stdout + res.stderr).includes(id), `expected ${id} in: ${res.stdout}${res.stderr}`);
  assert.equal(fs.existsSync(v.output), false, 'nothing is swapped into place');
  const leftover = fs.readdirSync(path.dirname(v.output)).filter((e) => /^\.scriptorium-build-/.test(e));
  assert.deepEqual(leftover, [], 'no staging tree is left behind');
}

test('(d) link on: a note carrying the preview marker text is still refused, exit 2, even with --force-check', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: `theme = "plain"\n${GM_TOML}`, marker: true });
    assertRefused(runBin(['build', 'alpha', '--config', v.configPath], root), v, 'build/gm-link-marker');
    assertRefused(runBin(['build', 'alpha', '--force-check', '--no-check', '--config', v.configPath], root), v, 'build/gm-link-marker');
  });
});

test('(d) link on: a withheld-name leak is refused, exit 2', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: `theme = "plain"\n${GM_TOML}`, leak: true });
    assertRefused(runBin(['build', 'alpha', '--no-check', '--config', v.configPath], root), v, 'leak/');
  });
});

test('(d) link on: a %% comment that survives into the output is refused, exit 2, even with --force-check', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: `theme = "plain"\n${GM_TOML}`, comment: true });
    const breaker = path.join(root, 'break.js');
    fs.writeFileSync(
      breaker,
      `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'generator', 'bootstrap.js'))}).READ_TRANSFORMS_FOR_BUILD.length = 0;\n`,
    );
    const env = { NODE_OPTIONS: `--require ${breaker}` };
    for (const extra of [[], ['--force-check']]) {
      assertRefused(runBin(['build', 'alpha', '--no-check', ...extra, '--config', v.configPath], root, env), v, 'leak/l6-comment-in-output');
    }
  });
});

test('(d) control: the same vault without the offending text builds and carries the link', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: `theme = "plain"\n${GM_TOML}` });
    const res = runBin(['build', 'alpha', '--force-check', '--no-check', '--config', v.configPath], root);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(fs.readFileSync(path.join(v.output, 'index.html'), 'utf8').includes(GM_ACCESS_MARKER));
  });
});

// (e) the preview carries the link ----------------------------------------------------------------

test('(e) the preview tree (through runBuildForContext) carries the link; the preview GM link is added separately', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: `theme = "plain"\n${GM_TOML}` });
    const ctxInfo = resolveCampaignContext({ config: v.configPath }, 'alpha');
    const { vaultPath, site } = resolveVaultSite(ctxInfo);
    const ctx = createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
    ctx.adminPort = 34567;
    preview.ensurePreviewRoot(ctx);
    try {
      const plain = preview.runPreviewBuild(ctx);
      assert.equal(plain.exitCode, 0, plain.human);
      let html = fs.readFileSync(path.join(ctx.previewDir, 'index.html'), 'utf8');
      assert.ok(html.includes(GM_ACCESS_MARKER), 'the published link is in the preview');
      assert.ok(html.includes('href="https://gm.example.net/?campaign=alpha"'));
      assert.ok(!html.includes(GM_LINK_MARKER), 'the preview GM link is not part of the build itself');

      const full = preview.buildPreviewWithGmLink(ctx);
      assert.equal(full.exitCode, 0, full.human);
      html = fs.readFileSync(path.join(ctx.previewDir, 'index.html'), 'utf8');
      assert.ok(html.includes(GM_ACCESS_MARKER) && html.includes(GM_LINK_MARKER), 'preview pages carry both links');
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('(e) control: with the link off the preview carries neither new marker', () => {
  withRoot((root) => {
    const v = writeVault(root, { pack: 'theme = "plain"\n' });
    const ctxInfo = resolveCampaignContext({ config: v.configPath }, 'alpha');
    const { vaultPath, site } = resolveVaultSite(ctxInfo);
    const ctx = createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
    ctx.adminPort = 34567;
    preview.ensurePreviewRoot(ctx);
    try {
      assert.equal(preview.runPreviewBuild(ctx).exitCode, 0);
      assert.ok(!fs.readFileSync(path.join(ctx.previewDir, 'index.html'), 'utf8').includes(GM_ACCESS_MARKER));
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});
