'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const { parseConfig } = require('../src/config/load');

/*
 * ADR 0021, subprocess end-to-end tests. Synthetic names only (NFR-08).
 * Every synthetic vault is built fresh in os.tmpdir(). --config isolation
 * is used throughout, and SCRIPTORIUM_CONFIG/APPDATA/XDG_CONFIG_HOME are
 * also pointed into scratch so a code path that ever bypassed --config
 * would still land in scratch, not the owner's real config.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-init-e2e-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function run(args, { input, env } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    timeout: 60000,
    killSignal: 'SIGKILL',
    input,
    env,
    encoding: 'utf8',
  });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  assert.equal(res.signal, null, `killed by signal: ${res.signal}`);
  return res;
}

function initVault(root, { campaign = 'Fixture Chronicle', dirname = 'vault' } = {}) {
  const vaultPath = path.join(root, dirname);
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

const L_VCJ = `{
  "siteTitle": "Fixture Chronicle",
  "landingTagline": "",
  "host": "github-pages",
  "attachmentsDir": "_attachments",
  "folderMap": {
    "Characters/PCs": "characters/pcs",
    "Characters/NPCs": "characters/npcs",
    "Locations": "locations",
    "Factions & Organizations": "factions",
    "Items & Artifacts": "items",
    "Creatures": "creatures",
    "Events": "events",
    "Documents": "documents",
    "Clues": "clues",
    "Chapters": "chapters",
    "_Campaign": "campaign",
    "_World": "world",
    "Heritages": "heritages",
    "Sessions": "sessions"
  },
  "excludeDirs": [
    "_meta",
    "_Templates",
    "_resources"
  ],
  "excludeSections": [
    "GM Notes",
    "DM Notes",
    "Player Notes",
    "Source References",
    "Reconciliation Context",
    "Handoff to Reconcile"
  ],
  "excludeCallouts": true,
  "backend": {
    "statusBar": false,
    "inbox": false
  }
}
`;

function assertFreshPack(packDir) {
  assert.deepEqual(fs.readdirSync(packDir).sort(), ['css', 'images', 'pack.toml', 'vault.config.json']);
  assert.deepEqual(fs.readdirSync(path.join(packDir, 'css')), []);
  assert.deepEqual(fs.readdirSync(path.join(packDir, 'images')), []);
  assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), 'theme = "gloam"\n');
  assert.equal(fs.readFileSync(path.join(packDir, 'vault.config.json'), 'utf8'), L_VCJ);
}

test('E1 (flags): init --name alpha --vault V --yes exits 0 and creates exactly the expected pack', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const before = treeManifest(vaultPath, '_meta/scriptorium');

    const res = run(['init', '--name', 'alpha', '--vault', vaultPath, '--yes', '--config', configPath], {
      env: scratchEnv(root),
    });
    assert.equal(res.status, 0);

    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    assertFreshPack(packDir);
    assert.deepEqual(treeManifest(vaultPath, '_meta/scriptorium'), before);

    const { config } = parseConfig(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.campaigns.alpha.vault, vaultPath);
    assert.equal(config.campaigns.alpha.output, path.join(path.dirname(vaultPath), 'alpha-site'));
    assert.equal(config.default_campaign, 'alpha');
    assert.equal('site_config' in config.campaigns.alpha, false);
    assert.equal('pack' in config.campaigns.alpha, false);

    const outputPath = path.join(path.dirname(vaultPath), 'alpha-site');
    assert.equal(fs.existsSync(outputPath), false);

    assert.ok(res.stdout.split('\n')[0].includes('GM-Scriptorium'));
    assert.ok(res.stdout.includes(`registered campaign "alpha" in ${configPath} (now the default campaign)`));
  });
});

test('E2 (scripted stdin): the same 7-line input produces the same end state as E1', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');

    const input = `alpha\n${vaultPath}\n\n\n\ny\nn\n`;
    const res = run(['init', '--config', configPath], { input, env: scratchEnv(root) });
    assert.equal(res.status, 0);

    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    assertFreshPack(packDir);

    const { config } = parseConfig(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.campaigns.alpha.vault, vaultPath);
    assert.equal(config.campaigns.alpha.output, path.join(path.dirname(vaultPath), 'alpha-site'));
    assert.equal(config.default_campaign, 'alpha');
    assert.equal(fs.existsSync(path.join(path.dirname(vaultPath), 'alpha-site')), false);
  });
});

test('E3 (re-run): both a flags re-run and a 4-line scripted re-run leave the pack byte- and mtime-identical', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    // Flags-mode fresh run, then flags-mode re-run.
    const vaultA = initVault(root, { dirname: 'vault-a' });
    const configA = path.join(root, 'config-a.toml');
    run(['init', '--name', 'alpha', '--vault', vaultA, '--yes', '--config', configA], { env: scratchEnv(root) });
    const packDirA = path.join(vaultA, '_meta', 'scriptorium');
    const past = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(packDirA, past, past);
    for (const rel of ['css', 'images', 'pack.toml', 'vault.config.json']) {
      fs.utimesSync(path.join(packDirA, rel), past, past);
    }
    const shaBefore = fs.readdirSync(packDirA).sort().map((n) => `${n}:${fs.statSync(path.join(packDirA, n)).isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(path.join(packDirA, n))).digest('hex')}`);
    const mtimeBefore = fs.statSync(packDirA).mtimeMs;

    const res = run(['init', '--name', 'alpha', '--vault', vaultA, '--yes', '--config', configA], { env: scratchEnv(root) });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes('left untouched: css/, images/, pack.toml, vault.config.json'));
    const shaAfter = fs.readdirSync(packDirA).sort().map((n) => `${n}:${fs.statSync(path.join(packDirA, n)).isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(path.join(packDirA, n))).digest('hex')}`);
    assert.deepEqual(shaAfter, shaBefore);
    assert.equal(fs.statSync(packDirA).mtimeMs, mtimeBefore);

    // Scripted-stdin fresh run, then scripted-stdin re-run.
    const vaultB = initVault(root, { dirname: 'vault-b' });
    const configB = path.join(root, 'config-b.toml');
    run(['init', '--config', configB], { input: `beta\n${vaultB}\n\n\n\ny\nn\n`, env: scratchEnv(root) });
    const packDirB = path.join(vaultB, '_meta', 'scriptorium');
    for (const rel of ['css', 'images', 'pack.toml', 'vault.config.json']) {
      fs.utimesSync(path.join(packDirB, rel), past, past);
    }
    fs.utimesSync(packDirB, past, past);
    const shaBefore2 = fs.readdirSync(packDirB).sort();
    const hashesBefore2 = shaBefore2.map((n) => (fs.statSync(path.join(packDirB, n)).isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(path.join(packDirB, n))).digest('hex')));

    const res2 = run(['init', '--config', configB], { input: 'beta\n\n\nn\n', env: scratchEnv(root) });
    assert.equal(res2.status, 0);
    assert.ok(res2.stdout.includes('left untouched: css/, images/, pack.toml, vault.config.json'));
    const hashesAfter2 = shaBefore2.map((n) => (fs.statSync(path.join(packDirB, n)).isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(path.join(packDirB, n))).digest('hex')));
    assert.deepEqual(hashesAfter2, hashesBefore2);
  });
});

test('E4 (later commands): check and build succeed through the pack, and the gloam theme assets are exactly the fonts/ listing', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    run(['init', '--name', 'alpha', '--vault', vaultPath, '--yes', '--config', configPath], { env: scratchEnv(root) });

    const checkRes = run(['check', 'alpha', '--json', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(checkRes.status, 0, `unexpected check failure: ${checkRes.stdout}\n${checkRes.stderr}`);
    const envelope = JSON.parse(checkRes.stdout);
    assert.equal(envelope.counts.error, 0, `unexpected ERROR finding(s): ${JSON.stringify(envelope.findings)}`);
    assert.ok(!envelope.findings.some((f) => f.id === 'config/pack-shadowed'));
    // ADR 0032: init's default is gloam, whose own theme.json owns the palette, so a fresh,
    // freshly light-defaulted vault must never trip the scheme-mismatch INFO either.
    assert.ok(!envelope.findings.some((f) => f.id === 'config/theme-scheme-mismatch'));

    const buildRes = run(['build', 'alpha', '--json', '--config', configPath], { env: scratchEnv(root) });
    assert.equal(buildRes.status, 0, `unexpected build failure: ${buildRes.stdout}\n${buildRes.stderr}`);

    const outputPath = path.join(path.dirname(vaultPath), 'alpha-site');
    assert.ok(fs.readFileSync(path.join(outputPath, 'index.html'), 'utf8').includes('Fixture Chronicle'));
    assert.ok(fs.existsSync(path.join(outputPath, 'css', 'scriptorium-theme.css')));

    const gloamFontsDir = path.join(__dirname, '..', 'assets', 'themes', 'gloam', 'fonts');
    const expectedFontFiles = fs.readdirSync(gloamFontsDir).sort();
    const builtFontsDir = path.join(outputPath, 'scriptorium', 'theme', 'fonts');
    assert.deepEqual(fs.readdirSync(builtFontsDir).sort(), expectedFontFiles);
  });
});

test('E5 (exit 3): an unreachable vault exits 3 with locateVault\'s own one-line message', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const configPath = path.join(root, 'config.toml');
    const missing = path.join(root, 'does-not-exist');
    const res1 = run(['init', '--name', 'alpha', '--vault', missing, '--yes', '--config', configPath], {
      env: scratchEnv(root),
    });
    assert.equal(res1.status, 3);
    assert.equal(res1.stderr.split('\n').filter(Boolean).length, 1);
    assert.ok(!res1.stderr.includes('    at '));
    assert.equal(fs.existsSync(configPath), false);

    const notAVault = path.join(root, 'not-a-vault');
    fs.mkdirSync(notAVault, { recursive: true });
    const res2 = run(['init', '--name', 'alpha', '--vault', notAVault, '--yes', '--config', configPath], {
      env: scratchEnv(root),
    });
    assert.equal(res2.status, 3);
    assert.equal(res2.stderr.split('\n').filter(Boolean).length, 1);
    assert.ok(!res2.stderr.includes('    at '));
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(path.join(notAVault, '_meta', 'scriptorium')), false);
  });
});

test('E6 (exit 1): each malformed invocation exits with its mapped code and one exact stderr line and writes nothing', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const before = treeManifest(vaultPath);

    const cases = [
      {
        args: ['init', '--name', 'alpha', '--vault', vaultPath, '--out', path.join(vaultPath, 'site'), '--yes', '--config', configPath],
        stderr: `refusing to build inside the vault: ${path.join(vaultPath, 'site')}\n`,
        code: 3, // #108: --out inside the vault is a vault/campaign problem
      },
      {
        args: ['init', '--name', 'Bad_Name', '--config', configPath],
        stderr:
          'invalid campaign name "Bad_Name": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit\n',
      },
      {
        args: ['init', '--theme', 'nonexistent', '--config', configPath],
        stderr: 'unknown theme "nonexistent"; valid themes: gloam, haze, plain\n',
      },
      {
        args: ['init', '--yes', '--name', 'alpha', '--config', configPath],
        stderr: 'init --yes needs --name <name> and --vault <path>\n',
      },
    ];

    for (const { args, stderr, code = 1 } of cases) {
      const res = run(args, { env: scratchEnv(root) });
      assert.equal(res.status, code, `args: ${JSON.stringify(args)}`);
      assert.equal(res.stderr, stderr, `args: ${JSON.stringify(args)}`);
      assert.deepEqual(treeManifest(vaultPath), before);
      assert.equal(fs.existsSync(configPath), false);
    }
  });
});

test('E7 (EOF): empty stdin, and stdin ending after two lines, each aborts with nothing written', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const before = treeManifest(vaultPath);

    const res1 = run(['init', '--config', configPath], { input: '', env: scratchEnv(root) });
    assert.equal(res1.status, 1);
    assert.equal(res1.stderr, 'init aborted; nothing written\n');
    assert.deepEqual(treeManifest(vaultPath), before);
    assert.equal(fs.existsSync(configPath), false);

    const res2 = run(['init', '--config', configPath], { input: `alpha\n${vaultPath}\n`, env: scratchEnv(root) });
    assert.equal(res2.status, 1);
    assert.equal(res2.stderr, 'init aborted; nothing written\n');
    assert.deepEqual(treeManifest(vaultPath), before);
    assert.equal(fs.existsSync(configPath), false);
  });
});

/** Async spawn with an explicit deadline, for the never-ended-stdin no-hang proofs. */
function spawnWithDeadline(args, { env, deadlineMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`did not exit within ${deadlineMs}ms`));
    }, deadlineMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, child });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('E8 (no hang): stdin piped and never ended still exits within 20s, with and without --yes', { timeout: 45000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(root, 'config.toml');
    const env = scratchEnv(root);

    const result1 = await spawnWithDeadline(
      ['init', '--name', 'alpha', '--vault', vaultPath, '--yes', '--config', configPath],
      { env },
    );
    assert.equal(result1.code, 0, `stdout: ${result1.stdout}\nstderr: ${result1.stderr}`);

    const vaultPath2 = initVault(root, { dirname: 'vault2', campaign: 'Second Chronicle' });
    const configPath2 = path.join(root, 'config2.toml');
    const child = spawn(process.execPath, [BIN, 'init', '--config', configPath2], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    try {
      const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.stdin.write(`beta\n${vaultPath2}\n\n\n\ny\nn\n`);
      // stdin deliberately never ended: a hang here means a missing SIGINT/EOF safeguard.
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 20000));
      const code = await Promise.race([exitPromise, timeout]);
      assert.equal(code, 0, `stdout: ${stdout}`);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('E9 (no args, not a TTY): exits 0 with the exact HELP init line, and writes nothing under XDG_CONFIG_HOME', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const env = scratchEnv(root);
    const res = run([], { input: '', env });
    assert.equal(res.status, 0);
    assert.ok(
      res.stdout
        .split('\n')
        .includes('  init     [--name <name>] [--vault <path>] [--out <path>] [--title <text>] [--theme <name>] [--yes]'),
    );
    assert.equal(fs.existsSync(env.XDG_CONFIG_HOME), false);
  });
});

test('E10: a --config path inside the about-to-be-registered vault is refused, and nothing is written', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const configPath = path.join(vaultPath, 'cfg.toml');
    const res = run(['init', '--name', 'alpha', '--vault', vaultPath, '--yes', '--config', configPath], {
      env: scratchEnv(root),
    });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.startsWith('refusing to write config to '), res.stderr);
    assert.equal(fs.existsSync(path.join(vaultPath, '_meta', 'scriptorium')), false);
    assert.equal(fs.existsSync(configPath), false);
  });
});

test('E11: a pre-existing hand-edited pack.toml is left untouched, and the other three entries are created', { timeout: 15000 }, async () => {
  await withScratchDir(async (root) => {
    const vaultPath = initVault(root);
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    const sentinel = 'theme = "plain"\n# hand-made\n';
    fs.writeFileSync(path.join(packDir, 'pack.toml'), sentinel);
    const past = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(path.join(packDir, 'pack.toml'), past, past);
    const mtimeBefore = fs.statSync(path.join(packDir, 'pack.toml')).mtimeMs;

    const configPath = path.join(root, 'config.toml');
    const res = run(['init', '--name', 'alpha', '--vault', vaultPath, '--yes', '--config', configPath], {
      env: scratchEnv(root),
    });
    assert.equal(res.status, 0, res.stderr);

    assert.equal(fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8'), sentinel);
    assert.equal(fs.statSync(path.join(packDir, 'pack.toml')).mtimeMs, mtimeBefore);
    assert.deepEqual(fs.readdirSync(packDir).sort(), ['css', 'images', 'pack.toml', 'vault.config.json']);
    assert.ok(res.stdout.includes('left untouched: pack.toml'));
    assert.ok(res.stdout.includes(`theme: plain (from ${path.join(packDir, 'pack.toml')}`));
  });
});
