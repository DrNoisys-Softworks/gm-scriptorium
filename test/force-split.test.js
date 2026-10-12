'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { parseArgv } = require('../src/cli/args');
const { withScratch, run } = require('./helpers/b4-cli');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * ADR 0055: `--force` is split into `--force-out` (the site-config outputDir collision guard only)
 * and `--force-check` (check ERROR findings only). Nothing on the command line overrides the
 * output-leak scan, and a bare `--force` is a one-line usage error (exit 1).
 *
 * Fixtures are scratch copies with a convention pack (no site_config), so nothing here depends on
 * the retired key. Expected values are literals, not derived from the code under test.
 */

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');
const MINI_SITE = path.join(__dirname, 'fixtures', 'mini-vault-site-config.json');
const ONE_PIXEL_PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'pin-vault', '_attachments', 'personal', 'hidden-map.png'));

const BARE_FORCE_LINE =
  "--force has been split: use --force-check to build despite check errors, or --force-out to build into the site config's own outputDir. Nothing overrides the output-leak scan.";

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function sha256Tree(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else entries.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir, '');
  return entries.sort().join('\n');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeConfig(dir, vault, out) {
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]', `vault = '${vault}'`, `output = '${out}'`, ''].join('\n'),
  );
  return configPath;
}

/** mini-vault copied to <dir>/vault with a convention pack. `outputDir` is pack-relative; '../../../out' is <dir>/out. */
function miniCampaign(dir, { outputDir } = {}) {
  const vault = path.join(dir, 'vault');
  fs.cpSync(MINI_VAULT, vault, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(MINI_SITE, 'utf8'));
  delete cfg.vaultPath;
  if (outputDir === undefined) delete cfg.outputDir;
  else cfg.outputDir = outputDir;
  const packDir = path.join(vault, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify(cfg, null, 2));
  const out = path.join(dir, 'out');
  return { vault, out, configPath: writeConfig(dir, vault, out) };
}

/** A vault whose only published page embeds an attachment named after a withheld entity: a source-side leak/* check error AND a staged-output scan hit. */
function gateCampaign(dir) {
  const vault = path.join(dir, 'vault');
  for (const d of ['NPCs', '_meta/scriptorium', '_attachments']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
  fs.writeFileSync(path.join(vault, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public Page\n---\nAn ordinary published page.\n\n![[secret-witness.png]]\n');
  fs.writeFileSync(path.join(vault, 'NPCs', 'Secret-Witness.md'), '---\ntype: npc\ntitle: Secret Witness\nwithheld: true\n---\nNever meant to reach a player.\n');
  fs.writeFileSync(path.join(vault, '_attachments', 'secret-witness.png'), ONE_PIXEL_PNG);
  fs.writeFileSync(
    path.join(vault, '_meta', 'scriptorium', 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Gate Vault', siteUrl: 'https://example.invalid', attachmentsDir: '_attachments', folderMap: { NPCs: 'npcs' }, excludeDirs: [] }),
  );
  const out = path.join(dir, 'out');
  return { vault, out, configPath: writeConfig(dir, vault, out) };
}

function siblings(out) {
  const parent = path.dirname(out);
  return fs.readdirSync(parent).filter((e) => /^\.scriptorium-(build|old)-/.test(e));
}

// --- parsing ---------------------------------------------------------------------------------------

test('parseArgv: --force-check and --force-out are booleans and never swallow the campaign name', () => {
  const a = parseArgv(['build', '--force-check', 'lease']);
  assert.deepEqual(a._, ['build', 'lease']);
  assert.equal(a.flags['force-check'], true);
  const b = parseArgv(['build', '--force-out', 'lease']);
  assert.deepEqual(b._, ['build', 'lease']);
  assert.equal(b.flags['force-out'], true);
});

test('parseArgv: bare --force still never swallows the campaign name (the refusal is a flag check, not a parse accident)', () => {
  const a = parseArgv(['build', '--force', 'lease']);
  assert.deepEqual(a._, ['build', 'lease']);
  assert.equal(a.flags.force, true);
});

test('validateFlags: build refuses force with the split line, every other command keeps its own unknown-flag message', () => {
  const { validateFlags } = require('../src/cli/args');
  const { ConfigError } = require('../src/util/errors');
  assert.throws(
    () => validateFlags('build', { force: true }),
    (err) => err instanceof ConfigError && err.message === BARE_FORCE_LINE,
  );
  assert.doesNotThrow(() => validateFlags('build', { 'force-check': true, 'force-out': true, 'no-check': true }));
  assert.throws(() => validateFlags('serve', { force: true }), /unknown flag --force for "serve"/);
});

// --- bare --force ----------------------------------------------------------------------------------

test('CLI: bare --force exits 1 with the one line, no stack, writes nothing, config untouched', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir);
    const before = sha256File(configPath);
    const res = run(dir, ['build', 'fixture', '--force']);
    assert.equal(res.code, 1, res.all);
    assert.ok(res.all.includes(BARE_FORCE_LINE), res.all);
    assert.equal(res.all.trim().split('\n').length, 1, `exactly one line: ${res.all}`);
    assert.doesNotMatch(res.all, /\bat .*\.js:\d+/);
    assert.equal(fs.existsSync(out), false, 'nothing may be written');
    assert.equal(sha256File(configPath), before);
  });
});

test('CLI: bare --force with --no-check and --json still exits 1 and writes nothing', () => {
  withScratch((dir) => {
    const { out } = gateCampaign(dir);
    const res = run(dir, ['build', 'fixture', '--force', '--no-check', '--json']);
    assert.equal(res.code, 1, res.all);
    assert.ok(res.all.includes(BARE_FORCE_LINE), res.all);
    assert.equal(fs.existsSync(out), false);
  });
});

test('runBuildCommand: bare force (any value, even false) throws the same line before anything is resolved', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const { ConfigError } = require('../src/util/errors');
    for (const value of [true, false]) {
      assert.throws(
        () => runBuildCommand({ config: configPath, force: value }, 'fixture'),
        (err) => err instanceof ConfigError && err.message === BARE_FORCE_LINE,
      );
    }
    // a campaign that does not exist still reports the force line first: the guard runs before resolution
    assert.throws(() => runBuildCommand({ config: configPath, force: true }, 'nonesuch'), (err) => err.message === BARE_FORCE_LINE);
    assert.equal(fs.existsSync(out), false);
  });
});

test('other commands are unaffected: check --force is still an unknown flag, not the split line', () => {
  withScratch((dir) => {
    miniCampaign(dir);
    const res = run(dir, ['check', 'fixture', '--force']);
    assert.equal(res.code, 1);
    assert.match(res.all, /unknown flag --force for "check"/);
    assert.ok(!res.all.includes('has been split'));
  });
});

test('CLI: a typo of --force-check suggests the real flag', () => {
  withScratch((dir) => {
    miniCampaign(dir);
    const res = run(dir, ['build', 'fixture', '--forse-check']);
    assert.equal(res.code, 1);
    assert.match(res.all, /Did you mean --force-check\?/);
  });
});

// --- --force-check / --force-out independence ------------------------------------------------------

test('--force-out alone does not override a check error: exit 2, nothing written', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-out': true }, 'fixture');
    assert.equal(r.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(r.envelope.refused, true);
    assert.match(r.human, /check found \d+ error\(s\); refusing to build/);
    assert.equal(fs.existsSync(out), false);
  });
});

test('--force-check alone does not override the outputDir collision: exit 2, nothing written, message names --force-out', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir, { outputDir: '../../../out' });
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-check': true }, 'fixture');
    assert.equal(r.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(r.envelope.refused, true);
    assert.equal(r.envelope.siteOutputDirCollision, out);
    assert.match(r.human, /rerun with --force-out\. Nothing was written\./);
    assert.ok(!/--force\b(?!-)/.test(r.human), `no bare --force in: ${r.human}`);
    assert.match(r.envelope.error, /refusing without --force-out$/);
    assert.equal(fs.existsSync(out), false);
  });
});

test('--force-check overrides check errors: exit 0, OVERRIDDEN lines, JSON forceCheck true and forceOut false', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-check': true }, 'fixture');
    assert.equal(r.exitCode, EXIT_CODES.OK, r.human);
    assert.match(r.human, /--force-check: overriding \d+ error finding\(s\):/);
    assert.match(r.human, /OVERRIDDEN /);
    assert.equal(r.envelope.forced, true);
    assert.equal(r.envelope.forceCheck, true);
    assert.equal(r.envelope.forceOut, false);
    assert.ok(r.envelope.overriddenFindings.length > 0);
    assert.ok(r.envelope.overriddenFindings.every((f) => f.severity === 'error'));
    assert.equal(r.envelope.siteOutputDirCollision, null);
    assert.equal(fs.existsSync(path.join(out, 'index.html')), true);
  });
});

test('--force-out overrides the collision: exit 0 (no check errors with --no-check), announce line, JSON siteOutputDirCollision set', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir, { outputDir: '../../../out' });
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-out': true, 'no-check': true }, 'fixture');
    assert.equal(r.exitCode, EXIT_CODES.OK, r.human);
    assert.ok(r.human.includes(`--force-out: building into the site config's own outputDir (${out}) despite the collision guard.`), r.human);
    assert.equal(r.envelope.forceOut, true);
    assert.equal(r.envelope.forceCheck, false);
    assert.equal(r.envelope.forced, true);
    assert.equal(r.envelope.siteOutputDirCollision, out);
    assert.deepEqual(r.envelope.overriddenFindings, []);
    assert.equal(fs.existsSync(path.join(out, 'index.html')), true);
  });
});

// --- no flag reaches the output scan ---------------------------------------------------------------

for (const [label, extra] of [
  ['--force-out --force-check', {}],
  ['--force-out --force-check --no-check', { 'no-check': true }],
]) {
  test(`the output-leak scan refuses with ${label}: exit 2, nothing written, no staging left`, () => {
    withScratch((dir) => {
      const { out, configPath } = gateCampaign(dir);
      const { runBuildCommand } = requireFresh('../src/cli/build');
      const r = runBuildCommand({ config: configPath, 'force-out': true, 'force-check': true, ...extra }, 'fixture');
      assert.equal(r.exitCode, EXIT_CODES.CHECK_FAILED, r.human);
      assert.equal(r.envelope.refusedByScan, true);
      assert.equal(r.envelope.forceOut, true);
      assert.equal(r.envelope.forceCheck, true);
      assert.ok(r.envelope.outputScanFindings.some((f) => f.outputPath === 'images/secret-witness.png'));
      assert.match(r.human, /secret-witness\.png/);
      assert.equal(sha256Tree(out), null, 'the output folder must not exist');
      assert.deepEqual(siblings(out), []);
    });
  });
}

test('without --no-check, --force-check overrides the source-side leak/* check error and only the scan refuses', () => {
  withScratch((dir) => {
    const { configPath } = gateCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const refused = runBuildCommand({ config: configPath }, 'fixture');
    assert.equal(refused.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.match(refused.human, /check found \d+ error\(s\); refusing to build/);
    const r = runBuildCommand({ config: configPath, 'force-check': true }, 'fixture');
    assert.equal(r.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(r.envelope.refusedByScan, true, 'the pre-build check was overridden, so it is the scan that refused');
    assert.match(r.human, /--force-check: overriding \d+ error finding\(s\):/);
  });
});

test('CLI spawn: build --force-out --force-check --no-check on a scan hit exits 2 and writes nothing', () => {
  withScratch((dir) => {
    const { out } = gateCampaign(dir);
    const res = run(dir, ['build', 'fixture', '--force-out', '--force-check', '--no-check', '--json']);
    assert.equal(res.code, 2, res.all);
    const env = JSON.parse(res.out);
    assert.equal(env.refusedByScan, true);
    assert.equal(fs.existsSync(out), false);
  });
});

// --- non-YAML frontmatter stays unforceable --------------------------------------------------------

test('non-YAML frontmatter is still refused with --force-check and --force-out together', () => {
  withScratch((dir) => {
    const { out, configPath } = miniCampaign(dir);
    fs.writeFileSync(path.join(dir, 'vault', 'Locations', 'Bad.md'), '---toml\ntype = "location"\n---\n\nx\n');
    const { runBuildCommand } = requireFresh('../src/cli/build');
    for (const noCheck of [false, true]) {
      const r = runBuildCommand({ config: configPath, 'force-check': true, 'force-out': true, 'no-check': noCheck }, 'fixture');
      assert.equal(r.exitCode, EXIT_CODES.CHECK_FAILED, r.human);
      assert.equal(fs.existsSync(out), false);
    }
  });
});

// --- JSON fields on every envelope -----------------------------------------------------------------

test('every build envelope carries forced, forceOut, forceCheck and siteOutputDirCollision; schemaVersion is unchanged', () => {
  const FIELDS = ['forced', 'forceOut', 'forceCheck', 'siteOutputDirCollision'];
  const seen = [];
  withScratch((dir) => {
    const { requireFreshBuild } = { requireFreshBuild: () => requireFresh('../src/cli/build') };
    const { runBuildCommand } = requireFreshBuild();

    // check refusal
    const mini = miniCampaign(dir);
    seen.push(['check refusal', runBuildCommand({ config: mini.configPath }, 'fixture')]);
    // success
    seen.push(['success', runBuildCommand({ config: mini.configPath, 'force-check': true }, 'fixture')]);
    // non-YAML frontmatter refusal
    fs.writeFileSync(path.join(dir, 'vault', 'Locations', 'Bad.md'), '---toml\ntype = "location"\n---\n\nx\n');
    seen.push(['frontmatter refusal', runBuildCommand({ config: mini.configPath, 'no-check': true }, 'fixture')]);
  });
  withScratch((dir) => {
    const { runBuildCommand } = requireFresh('../src/cli/build');
    // collision refusal
    const col = miniCampaign(dir, { outputDir: '../../../out' });
    seen.push(['collision refusal', runBuildCommand({ config: col.configPath }, 'fixture')]);
  });
  withScratch((dir) => {
    const { runBuildCommand } = requireFresh('../src/cli/build');
    // scan refusal
    const gate = gateCampaign(dir);
    seen.push(['scan refusal', runBuildCommand({ config: gate.configPath, 'no-check': true }, 'fixture')]);
  });
  assert.equal(seen.length, 5);
  for (const [label, r] of seen) {
    for (const f of FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(r.envelope, f), `${label}: missing ${f}`);
    assert.equal(r.envelope.schemaVersion, 1, `${label}: schemaVersion`);
  }
  const byLabel = Object.fromEntries(seen);
  assert.equal(byLabel['success'].envelope.forceCheck, true);
  assert.equal(byLabel['check refusal'].envelope.forced, false);
  assert.equal(typeof byLabel['collision refusal'].envelope.siteOutputDirCollision, 'string');
  assert.equal(byLabel['success'].envelope.siteOutputDirCollision, null);
});

test('overriddenFindings holds check findings only: a scan hit is never recorded as overridden', () => {
  withScratch((dir) => {
    const { configPath } = gateCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-check': true, 'no-check': true }, 'fixture');
    assert.deepEqual(r.envelope.overriddenFindings, []);
  });
});

test('a successful build reports outputScan.overridden false', () => {
  withScratch((dir) => {
    const { configPath } = miniCampaign(dir);
    const { runBuildCommand } = requireFresh('../src/cli/build');
    const r = runBuildCommand({ config: configPath, 'force-check': true }, 'fixture');
    assert.equal(r.envelope.outputScan.overridden, false);
  });
});
