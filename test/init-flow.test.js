'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const { runInitCommand } = require('../src/cli/init');
const { createPrompter } = require('../src/cli/prompt');
const { parseConfig } = require('../src/config/load');
const { ConfigError } = require('../src/util/errors');

/*
 * ADR 0021. In-process tests with injected PassThrough streams: no real
 * TTY, no real subprocess. Synthetic names only (NFR-08).
 */

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-init-flow-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

/** Test helper, as specified: a minimal vault with a manifest (leak/l1-no-manifest needs one). */
function initVault(root, { campaign = 'Fixture Chronicle' } = {}) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Characters', 'NPCs'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    `---\ntype: meta\ncampaign: ${campaign}\npublish:\n  mode: player\n---\n\n# Vault config\n`,
  );
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Characters/NPCs/Tess-Harrow.md\n',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'Characters', 'NPCs', 'Tess-Harrow.md'),
    '---\ntype: npc\ntitle: Tess Harrow\n---\nA published page.\n',
  );
  return vaultPath;
}

/** Copied per the brief: sorted d:/f:/l: entries from lstat, skipping skipRel's subtree. */
function treeManifest(root, skipRel) {
  const skipAbs = skipRel ? path.join(root, ...skipRel.split('/')) : null;
  const results = [];
  function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (skipAbs && abs === skipAbs) continue;
      const entryRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        results.push(`l:${entryRel}->${fs.readlinkSync(abs)}`);
      } else if (st.isDirectory()) {
        results.push(`d:${entryRel}/`);
        walk(abs, entryRel);
      } else if (st.isFile()) {
        results.push(`f:${entryRel}:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
      }
    }
  }
  walk(root, '');
  return results.sort();
}

test('F1 (race): a pack.toml planted between the confirm prompt and the write gives W-EXISTS, and nothing else is written', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();

    const promise = runInitCommand({ config: configPath }, [], { input, output });
    input.write('alpha\n');
    input.write(`${vaultPath}\n`);
    input.write('\n'); // output default
    input.write('\n'); // title default
    input.write('\n'); // theme default
    await waitForOutput(getWritten, '? [Y/n]: ');
    assert.ok(getWritten().includes('Create css/, images/, pack.toml, vault.config.json in'));

    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "sentinel"\n');

    input.write('y\n');

    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.message.startsWith(`refusing to overwrite ${path.join(packDir, 'pack.toml')}: it already exists`));
      assert.ok(err.message.includes(path.join(packDir, 'css')));
      assert.ok(err.message.includes(path.join(packDir, 'images')));
      return true;
    });
    assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), 'theme = "sentinel"\n');
    assert.equal(fs.existsSync(path.join(packDir, 'vault.config.json')), false);
    assert.equal(fs.existsSync(configPath), false);
  });
});

test('F2: re-registering an existing campaign preserves every key, updates only vault, and keeps the old output/default', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const toml = [
      'config_version = 1',
      'default_campaign = "beta"',
      '',
      '[campaigns.alpha]',
      "vault = '/old/vault/path'",
      "site_config = '/old/site-config.json'",
      "output = '/old/output'",
      'serve_port = 8123',
      'notes = "keep me"',
      '',
      '[campaigns.alpha.paths.z]',
      'match = { platform = "linux" }',
      '',
      '[campaigns.beta]',
      "vault = '/other/vault'",
      '',
    ].join('\n');
    fs.writeFileSync(configPath, toml);

    const { input, output } = makeStreams();
    const result = await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], {
      input,
      output,
    });
    assert.equal(result.exitCode, 0);

    const { config: reparsed } = parseConfig(fs.readFileSync(configPath, 'utf8'));
    const alpha = reparsed.campaigns.alpha;
    assert.equal(alpha.vault, vaultPath);
    assert.equal(alpha.output, '/old/output');
    assert.equal(alpha.site_config, '/old/site-config.json');
    assert.equal(alpha.serve_port, 8123);
    assert.equal(alpha.notes, 'keep me');
    assert.deepEqual(alpha.paths.z.match, { platform: 'linux' });
    assert.equal(reparsed.default_campaign, 'beta');
  });
});

test('F2b: the pack-shadowed note appears when site_config is set, and is absent (the pack-key note appears) when only pack is set', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root, { campaign: 'Shadow One' });
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, "site_config = '/old/site-config.json'", ''].join('\n'),
    );
    const { input, output, getWritten } = makeStreams();
    const result = await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], { input, output });
    assert.equal(result.exitCode, 0);
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    assert.ok(getWritten().includes(`note: site_config ${path.resolve('/old/site-config.json')} is in use, so the campaign pack at ${packDir} is ignored; remove site_config to use the pack (init left site_config in place)`));
    assert.ok(!getWritten().includes('the pack key'));
  });
});

test('F2c: pack-key-only note', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root, { campaign: 'Shadow Two' });
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, "pack = '/old/pack-dir'", ''].join('\n'),
    );
    const { input, output, getWritten } = makeStreams();
    const result = await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], { input, output });
    assert.equal(result.exitCode, 0);
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    assert.ok(
      getWritten().includes(
        `note: the pack key ${path.resolve('/old/pack-dir')} is in use, so the campaign pack at ${packDir} is ignored; remove the pack key to use it`,
      ),
    );
  });
});

test('F3: theme and title conflicts refuse and write nothing', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const registry = { plain: {}, fixture: {} };

    // Theme conflict.
    const vaultA = initVault(root, { campaign: 'Conflict A' });
    const configA = path.join(root, 'config-a.toml');
    const packDirA = path.join(vaultA, '_meta', 'scriptorium');
    fs.mkdirSync(packDirA, { recursive: true });
    fs.writeFileSync(path.join(packDirA, 'pack.toml'), 'theme = "plain"\n');
    const { input: inputA, output: outputA } = makeStreams();
    await assert.rejects(
      runInitCommand({ config: configA, name: 'alpha', vault: vaultA, yes: true, theme: 'fixture' }, [], {
        input: inputA,
        output: outputA,
        registry,
      }),
      (err) =>
        err instanceof ConfigError &&
        err.message ===
          `--theme "fixture" differs from the theme in ${path.join(packDirA, 'pack.toml')} ("plain"); init never edits existing pack files, so edit that file instead`,
    );
    assert.equal(fs.existsSync(path.join(packDirA, 'vault.config.json')), false);
    assert.equal(fs.existsSync(configA), false);

    // Title conflict.
    const vaultB = initVault(root, { campaign: 'Conflict B' });
    const configB = path.join(root, 'config-b.toml');
    const packDirB = path.join(vaultB, '_meta', 'scriptorium');
    fs.mkdirSync(packDirB, { recursive: true });
    fs.writeFileSync(path.join(packDirB, 'vault.config.json'), JSON.stringify({ siteTitle: 'Other' }));
    const { input: inputB, output: outputB } = makeStreams();
    await assert.rejects(
      runInitCommand({ config: configB, name: 'alpha', vault: vaultB, yes: true, title: 'Fixture Chronicle' }, [], {
        input: inputB,
        output: outputB,
      }),
      (err) =>
        err instanceof ConfigError &&
        err.message ===
          `--title "Fixture Chronicle" differs from the siteTitle in ${path.join(packDirB, 'vault.config.json')} ("Other"); init never edits existing pack files, so edit that file instead`,
    );
    assert.equal(fs.existsSync(configB), false);
  });
});

test('F4: an injected runCheck stub is run, its exitCode is ignored, and its human text is printed', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const runCheck = () => ({ exitCode: 2, human: 'STUB-CHECK' });

    const promise = runInitCommand({ config: configPath }, [], { input, output, runCheck });
    input.write('alpha\n');
    input.write(`${vaultPath}\n`);
    input.write('\n\n\n'); // output, title, theme defaults
    input.write('y\n'); // confirm create
    input.write('y\n'); // run the check

    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.ok(getWritten().includes('STUB-CHECK'));
  });
});

test('F5: EOF at the check prompt resolves exitCode 0, with the pack and config already written', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();

    const promise = runInitCommand({ config: configPath }, [], { input, output });
    input.write('alpha\n');
    input.write(`${vaultPath}\n`);
    input.write('\n\n\n');
    input.write('y\n'); // confirm create
    input.end(); // EOF at the check prompt

    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.ok(!getWritten().includes('nothing written'));
    assert.ok(fs.existsSync(path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json')));
    assert.ok(fs.existsSync(configPath));
  });
});

test('F6: an invalid interactive answer is asked again, and each error message appears exactly once', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const missingVault = path.join(root, 'does-not-exist');
    const { input, output, getWritten } = makeStreams();

    const promise = runInitCommand({ config: configPath }, [], { input, output });
    input.write('Bad_Name\n');
    input.write('alpha\n');
    input.write(`${missingVault}\n`);
    input.write(`${vaultPath}\n`);
    input.write(`${path.join(vaultPath, 'site')}\n`); // inside the vault: refused
    input.write('\n'); // accept the default instead
    input.write('\n\n'); // title, theme defaults
    input.write('y\n'); // confirm
    input.write('n\n'); // skip check

    const result = await promise;
    assert.equal(result.exitCode, 0);
    const written = getWritten();

    const nameErr = 'invalid campaign name "Bad_Name": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit';
    assert.equal(written.split(nameErr).length - 1, 1);

    const vaultErrCount = (written.match(/configured vault path does not exist/g) || []).length;
    assert.equal(vaultErrCount, 1);

    const outputErrCount = (written.match(/refusing to build inside the vault/g) || []).length;
    assert.equal(outputErrCount, 1);
  });
});

test('F7: the output and title defaults are exactly what the brief states', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultWithCampaign = initVault(root, { campaign: 'Fixture Chronicle' });
    const configPath1 = path.join(root, 'config-1.toml');
    const { input: i1, output: o1 } = makeStreams();
    await runInitCommand({ config: configPath1, name: 'alpha', vault: vaultWithCampaign, yes: true }, [], { input: i1, output: o1 });
    const { config: c1 } = parseConfig(fs.readFileSync(configPath1, 'utf8'));
    assert.equal(c1.campaigns.alpha.output, path.join(path.dirname(vaultWithCampaign), 'alpha-site'));
    const json1 = JSON.parse(
      fs.readFileSync(path.join(vaultWithCampaign, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'),
    );
    assert.equal(json1.siteTitle, 'Fixture Chronicle');

    // No campaign: frontmatter -> the title default is the campaign name.
    const vaultNoCampaign = path.join(root, 'vault-nocampaign');
    fs.mkdirSync(path.join(vaultNoCampaign, '_meta'), { recursive: true });
    fs.mkdirSync(path.join(vaultNoCampaign, 'Characters', 'NPCs'), { recursive: true });
    fs.writeFileSync(path.join(vaultNoCampaign, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# Vault config\n');
    fs.writeFileSync(
      path.join(vaultNoCampaign, '_meta', 'publish-manifest.md'),
      '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Characters/NPCs/Tess-Harrow.md\n',
    );
    fs.writeFileSync(
      path.join(vaultNoCampaign, 'Characters', 'NPCs', 'Tess-Harrow.md'),
      '---\ntype: npc\ntitle: Tess Harrow\n---\nA published page.\n',
    );
    const configPath2 = path.join(root, 'config-2.toml');
    const { input: i2, output: o2 } = makeStreams();
    await runInitCommand({ config: configPath2, name: 'alpha', vault: vaultNoCampaign, yes: true }, [], { input: i2, output: o2 });
    const json2 = JSON.parse(
      fs.readFileSync(path.join(vaultNoCampaign, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'),
    );
    assert.equal(json2.siteTitle, 'alpha');
  });
});

test('F8: a re-run shows the read-only theme: and site title: lines verbatim', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input: i1, output: o1 } = makeStreams();
    await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], { input: i1, output: o1 });

    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    const { input: i2, output: o2, getWritten } = makeStreams();
    await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], { input: i2, output: o2 });
    const written = getWritten();
    assert.ok(
      written.includes(
        `theme: gloam (from ${path.join(packDir, 'pack.toml')}; init never edits it, edit that file to change it)`,
      ),
    );
    assert.ok(
      written.includes(
        `site title: "Fixture Chronicle" (from ${path.join(packDir, 'vault.config.json')}; init never edits it, edit that file to change it)`,
      ),
    );
  });
});

test('F9: an explicit init never pauses', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    await runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, yes: true }, [], { input, output });
    assert.ok(!getWritten().includes('Press Enter to close this window.'));
  });
});

test('F10: SIGINT at the vault prompt rejects with I-ABORT, and the vault is unchanged', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const before = treeManifest(vaultPath);
    const configPath = path.join(root, 'config.toml');
    const { input, output } = makeStreams();
    input.isTTY = true;
    output.isTTY = true;
    const prompter = createPrompter({ input, output });

    const promise = runInitCommand({ config: configPath }, [], { input, output, prompter });
    input.write('alpha\n');
    // Wait until the vault prompt is pending, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    prompter.rl.emit('SIGINT');

    await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
    assert.deepEqual(treeManifest(vaultPath), before);
    assert.equal(fs.existsSync(configPath), false);
    prompter.close();
  });
});

// --- A1 (orchestrator addendum): the non-empty foreign output folder -------

function makeOutputDir(root, name, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('A1-1: an empty existing output folder needs no confirmation, flags and --yes alike', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const outDir = makeOutputDir(root, 'empty-out', {});
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const result = await runInitCommand(
      { config: configPath, name: 'alpha', vault: vaultPath, out: outDir, yes: true },
      [],
      { input, output },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(!getWritten().includes('warning:'));
  });
});

test('A1-2: a folder that looks like a previous build needs no confirmation', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const outDir = makeOutputDir(root, 'prior-build', {
      'index.html': '<html></html>',
      'css/scriptorium.css': 'body {}',
    });
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const result = await runInitCommand(
      { config: configPath, name: 'alpha', vault: vaultPath, out: outDir, yes: true },
      [],
      { input, output },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(!getWritten().includes('warning:'));
  });
});

test('A1-3: --yes refuses a non-empty foreign output folder, and writes nothing', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const outDir = makeOutputDir(root, 'foreign-out', { 'somefile.txt': 'junk' });
    const configPath = path.join(root, 'config.toml');
    const { input, output } = makeStreams();
    await assert.rejects(
      runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, out: outDir, yes: true }, [], {
        input,
        output,
      }),
      (err) =>
        err instanceof ConfigError &&
        err.message ===
          `refusing to use ${outDir} as the output folder: it exists and is not empty and does not look like a previous build; choose an empty or new folder`,
    );
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'scriptorium')), false);
    assert.equal(fs.existsSync(configPath), false);
  });
});

test('A1-4: interactively, declining the warning aborts with nothing written', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const outDir = makeOutputDir(root, 'foreign-out', { 'somefile.txt': 'junk' });
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();
    const promise = runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, out: outDir }, [], {
      input,
      output,
    });
    input.write('n\n');
    await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
    assert.ok(getWritten().includes(`warning: ${outDir} exists and is not empty; the first build will replace its contents`));
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'scriptorium')), false);
    assert.equal(fs.existsSync(configPath), false);
  });
});

test('A1-5: interactively, accepting the warning proceeds', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const outDir = makeOutputDir(root, 'foreign-out', { 'somefile.txt': 'junk' });
    const configPath = path.join(root, 'config.toml');
    const { input, output } = makeStreams();
    const promise = runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath, out: outDir }, [], {
      input,
      output,
    });
    input.write('y\n'); // accept the warning
    input.write('\n\n'); // title, theme defaults
    input.write('y\n'); // confirm create
    input.write('n\n'); // skip check
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.ok(fs.existsSync(path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json')));
    assert.equal(fs.existsSync(configPath), true);
  });
});

// ==== ADR 0032, Structural decision 6: the init default split (INIT_DEFAULT_THEME) ============

test('theme prompt literal: interactively the default-suffixed prompt is exactly "Theme (gloam, haze, plain) [gloam]: "', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();

    const promise = runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath }, [], { input, output });
    input.write('\n'); // output default
    input.write('\n'); // title default
    await waitForOutput(getWritten, 'Theme (');
    assert.ok(getWritten().includes('Theme (gloam, haze, plain) [gloam]: '));

    input.write('haze\n'); // a valid, non-default answer, so the prompt loop moves on
    await waitForOutput(getWritten, '? [Y/n]: ');
    input.write('n\n'); // decline the confirm, so the flow ends cleanly without writing anything
    await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
  });
});

test('Enter at the theme prompt gives gloam (GM17 control)', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const { input, output, getWritten } = makeStreams();

    const promise = runInitCommand({ config: configPath, name: 'alpha', vault: vaultPath }, [], { input, output });
    input.write('\n'); // output default
    input.write('\n'); // title default
    input.write('\n'); // theme: Enter -> gloam
    await waitForOutput(getWritten, '? [Y/n]: ');
    input.write('y\n'); // confirm create
    input.write('n\n'); // skip check
    const result = await promise;
    assert.equal(result.exitCode, 0);
    const packToml = path.join(vaultPath, '_meta', 'scriptorium', 'pack.toml');
    assert.equal(fs.readFileSync(packToml, 'utf8'), 'theme = "gloam"\n');
  });
});
