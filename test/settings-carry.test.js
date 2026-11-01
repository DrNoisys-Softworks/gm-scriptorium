'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');
const { runCarryCommand } = require('../src/cli/carry');
const { planCarry, applyCarry, discardCarry } = require('../src/vault/settingscarry');
const { writeCarriedPack } = require('../src/vault/carrypack');
const packreplace = require('../src/vault/packreplace');
const backups = require('../src/config/backups');
const { VaultUnreachableError, ScriptoriumError } = require('../src/util/errors');

/*
 * `gm-scriptorium carry` (ADR 0071): folds the pack's leftover site settings into a moved vault's
 * _meta/vault-config.yaml with the pin's own move code, then rewrites the pack without them.
 * Every case starts from a copy of the sample vault that the pin's own move has already run on,
 * with 'Pack Only Secret' added to the pack's hide list, which the yaml does not hold.
 */

const CARRY_IDS = ['config/pack-hiding-not-carried', 'config/pack-setting-not-carried', 'config/pack-setting-differs', 'config/folder-map-not-carried', 'config/folder-map-missing'];
// What the planner's scratch folder is called; it must never reach the GM's screen.
const SCRATCH_PREFIX = 'scriptorium-carry-';

// A finding line, not the list of checks that ran (the human report ends with that list).
const reports = (out, id) => new RegExp(`^(?:ERROR|WARN|INFO) ${id}`, 'm').test(out);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const yamlOf = (vault) => path.join(vault, '_meta', 'vault-config.yaml');
const packOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');

function register(root, vault) {
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\noutput = '${path.join(root, 'site')}'\n`);
}

/**
 * A moved copy of the sample whose move already folded the pack in (so the yaml holds the title, the
 * folder map and the hide lists), with the pack then given one hide entry the yaml lacks. Registered as
 * campaign "t".
 */
function setup(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  const pack = JSON.parse(fs.readFileSync(packOf(vaultPath), 'utf8'));
  assert.ok(!('excludeSections' in pack), 'the move must have taken the hide list out of the pack');
  pack.excludeSections = ['Pack Only Secret'];
  fs.writeFileSync(packOf(vaultPath), JSON.stringify(pack, null, 2));
  register(root, vaultPath);
  return vaultPath;
}

/**
 * A moved copy of the sample whose move did NOT fold the pack in: the yaml sets no title and no folder
 * map, and the pack still holds the lot (plus 'Pack Only Secret'). What a vault gets when gm-apprentice
 * moves it without knowing where Scriptorium keeps the pack.
 */
function setupUnfolded(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  const pack = JSON.parse(fs.readFileSync(packOf(vaultPath), 'utf8'));
  pack.excludeSections.push('Pack Only Secret');
  fs.writeFileSync(packOf(vaultPath), JSON.stringify(pack, null, 2));
  register(root, vaultPath);
  return vaultPath;
}

function backupsIn(root) {
  const dir = path.join(root, 'backups', 'campaign-t');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function insideVault(vault) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.bak')) found.push(full);
    }
  })(vault);
  return found;
}

/** Runs the command in this process. `onQuestion` runs when the question is printed, before the answer is read. */
async function inProcess(root, { yes = false, answer = 'y\n', onQuestion } = {}) {
  const input = new PassThrough();
  let out = '';
  const output = {
    isTTY: false,
    write(s) {
      out += s;
      if (onQuestion && s.includes('[y/N]')) {
        const f = onQuestion;
        onQuestion = null;
        f();
        input.end(answer);
      }
      return true;
    },
  };
  if (!yes && !onQuestion) input.end(answer);
  const flags = { config: path.join(root, 'config.toml') };
  if (yes) flags.yes = true;
  try {
    const result = await runCarryCommand(flags, [], { input, output, now: () => Date.parse('2026-10-27T10:00:00Z') });
    return { code: result.exitCode, out };
  } catch (err) {
    if (err instanceof VaultUnreachableError) return { code: 3, out, err };
    if (err instanceof ScriptoriumError) return { code: 1, out, err };
    throw err;
  }
}

test('carry --yes folds the pack into the yaml, strips the pack, backs both up outside the vault and names real paths', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.ok(!yamlBefore.includes('Pack Only Secret'));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.ok(!('excludeSections' in pack));
    assert.ok(!('vaultPath' in pack));
    assert.equal(backupsIn(root).length, 2, backupsIn(root).join(','));
    assert.ok(backupsIn(root).some((n) => /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak$/.test(n)));
    assert.ok(backupsIn(root).some((n) => /^vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak$/.test(n)));
    assert.deepEqual(insideVault(vault), []);
    assert.ok(res.out.includes(packOf(vault)), res.out);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('a leftover vault-config.md the pin removes as redundant is backed up first, outside the vault, under its own name the panel neither lists nor prunes, and the output says where', () => {
  withScratch((root) => {
    const vault = setup(root);
    const md = path.join(vault, '_meta', 'vault-config.md');
    const MD = '---\ntype: meta\n---\n';
    fs.writeFileSync(md, MD);
    const planned = planCarry({ vaultPath: vault, packConfigPath: packOf(vault) });
    discardCarry(planned);
    assert.ok(planned.plan.files.remove.some((f) => path.basename(f) === 'vault-config.md'), 'the pin plans to remove the leftover file');
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.equal(fs.existsSync(md), false, 'the pin removed it');
    const mdBackups = backupsIn(root).filter((n) => n.endsWith('.md.bak'));
    assert.equal(mdBackups.length, 1, backupsIn(root).join(','));
    assert.match(mdBackups[0], /^vault-config-leftover-\d{8}T\d{9}Z-[0-9a-f]{6}\.md\.bak$/);
    const backup = path.join(root, 'backups', 'campaign-t', mdBackups[0]);
    assert.equal(fs.readFileSync(backup, 'utf8'), MD);
    assert.deepEqual(insideVault(vault), []);
    assert.ok(res.out.includes(backup), res.out);
    // The panel's restore list is for its own vault-config.md saves: the carry's copy is not one of them,
    // and the panel's newest-20 prune must never delete it.
    const listed = backups.listBackups({ machineDir: root, campaign: 't', vaultPath: vault });
    assert.deepEqual(listed.ok && listed.items, []);
    backups.pruneBackups({ machineDir: root, campaign: 't', keep: 0 });
    assert.equal(fs.readFileSync(backup, 'utf8'), MD);
  });
});

test('the backups hold the files as they were before the carry', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBytes = fs.readFileSync(yamlOf(vault));
    const packBytes = fs.readFileSync(packOf(vault));
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const dir = path.join(root, 'backups', 'campaign-t');
    const yamlBak = backupsIn(root).find((n) => n.endsWith('.yaml.bak'));
    const packBak = backupsIn(root).find((n) => n.endsWith('.json.bak'));
    assert.equal(sha(fs.readFileSync(path.join(dir, yamlBak))), sha(yamlBytes));
    assert.equal(sha(fs.readFileSync(path.join(dir, packBak))), sha(packBytes));
  });
});

test('the title and the folder map land in the yaml, the pack is stripped, and the built site shows both', () => {
  withScratch((root) => {
    const vault = setupUnfolded(root);
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    pack.siteTitle = 'A Renamed Lease';
    fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    assert.ok(!/^\s+title:/m.test(yamlBefore.toString()), 'the yaml must not set a title yet');
    assert.ok(!/folder_map:/.test(yamlBefore.toString()), 'the yaml must not set a folder map yet');
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(yaml, /^\s+title: "?A Renamed Lease"?$/m);
    assert.match(yaml, /folder_map:/);
    assert.match(yaml, /Sessions: "?sessions"?/);
    assert.ok(yaml.includes('Pack Only Secret'));
    const left = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.ok(!('siteTitle' in left));
    assert.ok(!('folderMap' in left));
    assert.ok(res.out.includes('`siteTitle` moved to `player_site.title`.'), res.out);
    assert.ok(res.out.includes('`folderMap` moved to `player_site.folder_map`.'), res.out);
    assert.ok(!res.out.includes('stays in'), res.out);
    // The backup of the yaml is the file as it was before the carry.
    const dir = path.join(root, 'backups', 'campaign-t');
    const yamlBak = backupsIn(root).find((n) => n.endsWith('.yaml.bak'));
    assert.equal(Buffer.compare(fs.readFileSync(path.join(dir, yamlBak)), yamlBefore), 0);
    // check is clean, and the build uses the title and the folder layout.
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    for (const id of CARRY_IDS) assert.ok(!reports(checked.out, id), `${id} still reported:\n${checked.out}`);
    assert.ok(!reports(checked.out, 'vault/unmapped-directory'), checked.out);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    assert.match(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8'), /A Renamed Lease/);
    assert.ok(fs.existsSync(path.join(root, 'site', 'characters', 'pcs')), 'the folder map must put the PCs under characters/pcs');
    // Run again: nothing to do, no new backup, no change.
    const yamlAfter = fs.readFileSync(yamlOf(vault));
    const packAfter = fs.readFileSync(packOf(vault));
    const backups = backupsIn(root);
    const again = run(root, ['carry', '--yes']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to carry/);
    assert.deepEqual(backupsIn(root), backups);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlAfter), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfter), 0);
  });
});

test('a title and folder map the yaml already holds are not overwritten, and the differing values are said', () => {
  withScratch((root) => {
    const vault = setupUnfolded(root);
    // Test-only: the pin's own writer sets what the vault already holds.
    const { applyChanges } = require('gm-apprentice-publish/lib/settings/write');
    applyChanges(vault, [
      { op: 'set', name: 'player_site.title', value: 'Yaml Title' },
      { op: 'set', name: 'player_site.folder_map', value: { Sessions: 'yaml-sessions' } },
    ]);
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    pack.siteTitle = 'Pack Title';
    fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
    // The plan, which the GM reads before answering, already says the vault's value is used.
    const planned = planCarry({ vaultPath: vault, packConfigPath: packOf(vault) });
    discardCarry(planned);
    assert.ok(
      planned.lines.includes('siteTitle in the pack is "Pack Title", but the vault\'s settings set player_site.title to "Yaml Title"; the vault\'s value is used.'),
      planned.lines.join('\n'),
    );
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.equal(res.out.split('siteTitle in the pack is').length - 1, 1, 'said once');
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(yaml, /^\s+title: "?Yaml Title"?$/m);
    assert.ok(!yaml.includes('Pack Title'));
    assert.match(yaml, /Sessions: "?yaml-sessions"?/);
    assert.ok(!yaml.includes('characters/pcs'), 'the pack folder map must not be merged in');
    assert.ok(res.out.includes('siteTitle in the pack is "Pack Title", but the vault\'s settings set player_site.title to "Yaml Title"; the vault\'s value is used.'), res.out);
    assert.match(res.out, /folderMap in the pack is \{.*\}, but the vault's settings set player_site\.folder_map to \{"Sessions":"yaml-sessions"\}; the vault's value is used\./);
    const left = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.ok(!('siteTitle' in left) && !('folderMap' in left));
  });
});

test('a yaml title and folder map the pin cannot read are kept as written, named, and the pack keeps its own', () => {
  withScratch((root) => {
    const vault = setupUnfolded(root);
    const yamlText = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.ok(yamlText.includes('player_site:\n'));
    fs.writeFileSync(yamlOf(vault), yamlText.replace('player_site:\n', 'player_site:\n  title: ["a", "b"]\n  folder_map: "not a map"\n'));
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    pack.siteTitle = 'Pack Title';
    fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.ok(yaml.includes('  title: ["a", "b"]\n'), yaml);
    assert.ok(yaml.includes('  folder_map: "not a map"\n'), yaml);
    assert.ok(!yaml.includes('Pack Title'));
    assert.ok(!yaml.includes('characters/pcs'), 'the pack folder map is not written over the vault\'s');
    const p = packOf(vault);
    assert.ok(
      res.out.includes(`siteTitle stays in ${p}: the vault's settings set player_site.title to ["a","b"], which cannot be read, and the carry leaves it as it is. Fix player_site.title in _meta/vault-config.yaml.`),
      res.out,
    );
    assert.ok(
      res.out.includes(`folderMap stays in ${p}: the vault's settings set player_site.folder_map to "not a map", which cannot be read, and the carry leaves it as it is. Fix player_site.folder_map in _meta/vault-config.yaml.`),
      res.out,
    );
    const left = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(left.siteTitle, 'Pack Title');
    assert.equal(left.folderMap['Characters/PCs'], 'characters/pcs');
  });
});

test('when the title and folder map cannot be written, the pack keeps both, the command exits 3, and the rest is carried', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const pinned = require('../src/generator/pinned');
  const real = pinned.applySettingsChanges;
  try {
    const vault = setupUnfolded(root);
    pinned.applySettingsChanges = () => {
      throw new Error('EACCES: permission denied');
    };
    const res = await inProcess(root, { yes: true });
    pinned.applySettingsChanges = real;
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.match(res.err.message, /siteTitle and folderMap are still in /);
    assert.ok(res.err.message.includes(packOf(vault)), res.err.message);
    const left = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.equal(left.siteTitle, 'The Long Lease');
    assert.equal(left.folderMap.Sessions, 'sessions');
    assert.ok(!('excludeSections' in left));
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    assert.ok(!/folder_map:/.test(fs.readFileSync(yamlOf(vault), 'utf8')));
  } finally {
    pinned.applySettingsChanges = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings the pin drops without carrying stay in the pack with their values, are named, and are not lost from the vault', () => {
  withScratch((root) => {
    const vault = setupUnfolded(root);
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    pack.footer = 'Pack footer';
    pack.attachmentsDir = 'files';
    pack.searchEnabled = false;
    fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    const left = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.equal(left.footer, 'Pack footer');
    assert.equal(left.attachmentsDir, 'files');
    assert.equal(left.searchEnabled, false);
    // The title, the folder map and the hide list did move.
    assert.ok(!('siteTitle' in left) && !('folderMap' in left) && !('excludeSections' in left));
    for (const name of ['footer', 'attachmentsDir', 'searchEnabled']) {
      assert.ok(res.out.includes(`${name} stays in ${packOf(vault)}`), `${name} not named:\n${res.out}`);
    }
    // Not silently lost: the yaml did not take them, so they are only in the pack.
    assert.ok(!fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack footer'));
    // A second carry has nothing to move, and still names them.
    const again = run(root, ['carry', '--yes']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to carry/);
    for (const name of ['footer', 'attachmentsDir', 'searchEnabled']) assert.ok(again.out.includes(`${name} stays in`), again.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(packOf(vault), 'utf8')), left);
  });
});

test('if the title write and the pack rewrite both fail, exit 3, the message says the title is still only in the pack, and names both backups', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const pinned = require('../src/generator/pinned');
  const realWrite = pinned.applySettingsChanges;
  const realReplace = packreplace.replacePackFile;
  try {
    const vault = setupUnfolded(root);
    const packBefore = fs.readFileSync(packOf(vault));
    pinned.applySettingsChanges = () => {
      throw new Error('EACCES: yaml');
    };
    packreplace.replacePackFile = () => {
      const e = new Error('EACCES: pack');
      e.code = 'EACCES';
      throw e;
    };
    const res = await inProcess(root, { yes: true });
    pinned.applySettingsChanges = realWrite;
    packreplace.replacePackFile = realReplace;
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.ok(!res.err.message.includes('nothing else needs doing'), res.err.message);
    assert.match(res.err.message, /siteTitle and folderMap are still only in /);
    assert.match(res.err.message, /vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak/);
    assert.match(res.err.message, /vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak/);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
  } finally {
    pinned.applySettingsChanges = realWrite;
    packreplace.replacePackFile = realReplace;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plain title write failure exits 3 and names both backups', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const pinned = require('../src/generator/pinned');
  const real = pinned.applySettingsChanges;
  try {
    setupUnfolded(root);
    pinned.applySettingsChanges = () => {
      throw new Error('EACCES: yaml');
    };
    const res = await inProcess(root, { yes: true });
    pinned.applySettingsChanges = real;
    assert.equal(res.code, 3, res.out);
    assert.match(res.err.message, /vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak/);
    assert.match(res.err.message, /vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak/);
  } finally {
    pinned.applySettingsChanges = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a writer that reports success but writes nothing is caught by the read-back: exit 3, the pack keeps the title and folder map', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const pinned = require('../src/generator/pinned');
  const real = pinned.applySettingsChanges;
  try {
    const vault = setupUnfolded(root);
    pinned.applySettingsChanges = () => ({ file: yamlOf(vault), changed: [] });
    const res = await inProcess(root, { yes: true });
    pinned.applySettingsChanges = real;
    assert.equal(res.code, 3, res.out);
    assert.match(res.err.message, /it did not read back as written/);
    const left = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.equal(left.siteTitle, 'The Long Lease');
    assert.equal(left.folderMap.Sessions, 'sessions');
  } finally {
    pinned.applySettingsChanges = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second carry says there is nothing to carry, exits 0 and makes no backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const yamlAfter = fs.readFileSync(yamlOf(vault));
    const packAfter = fs.readFileSync(packOf(vault));
    const backups = backupsIn(root);
    const again = run(root, ['carry', '--yes']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to carry/);
    assert.deepEqual(backupsIn(root), backups);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlAfter), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfter), 0);
  });
});

test('after the carry, check exits 0 with none of the three carry ids, and build succeeds', () => {
  withScratch((root) => {
    setup(root);
    const before = run(root, ['check']);
    assert.equal(before.code, 2, before.all);
    assert.match(before.out, /config\/pack-hiding-not-carried/);
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    for (const id of CARRY_IDS) assert.ok(!reports(checked.out, id), `${id} still reported:\n${checked.out}`);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    assert.ok(fs.existsSync(path.join(root, 'site', 'index.html')));
  });
});

test('when the pack cannot be rewritten (EACCES), carry exits 1, says the vault settings hold everything, and check is clean', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const real = packreplace.replacePackFile;
  try {
    const vault = setup(root);
    packreplace.replacePackFile = () => {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    };
    const res = await inProcess(root, { yes: true });
    packreplace.replacePackFile = real;
    assert.equal(res.code, 1, res.out);
    assert.match(res.err.message, /vault's settings already hold every value that was carried/);
    assert.ok(res.err.message.includes(packOf(vault)), res.err.message);
    assert.match(res.err.message, /vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak/);
    assert.match(res.err.message, /nothing else needs doing/);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    for (const id of CARRY_IDS) assert.ok(!reports(checked.out, id), `${id} still reported:\n${checked.out}`);
  } finally {
    packreplace.replacePackFile = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a yaml edited between the plan and the apply exits 3 and leaves both files exactly as the edit left them', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  try {
    const vault = setup(root);
    let yamlAfterEdit;
    let packAfterEdit;
    const res = await inProcess(root, {
      onQuestion() {
        fs.appendFileSync(yamlOf(vault), '\n# edited by hand after the plan\n');
        yamlAfterEdit = fs.readFileSync(yamlOf(vault));
        packAfterEdit = fs.readFileSync(packOf(vault));
      },
    });
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.match(res.err.message, /changed since/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlAfterEdit), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfterEdit), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the pack edited between the plan and the apply is not overwritten', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  try {
    const vault = setup(root);
    let packAfterEdit;
    const res = await inProcess(root, {
      onQuestion() {
        const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
        pack.siteTitle = 'Changed After The Plan';
        fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
        packAfterEdit = fs.readFileSync(packOf(vault));
      },
    });
    // Caught before anything is written: the yaml is untouched too.
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfterEdit), 0);
    assert.ok(!fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run through a symlink to the vault, carry still carries', { skip: process.platform === 'win32' }, () => {
  withScratch((root) => {
    const vault = setup(root);
    const link = path.join(root, 'link-to-vault');
    fs.symlinkSync(vault, link, 'dir');
    register(root, link);
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    assert.ok(!('excludeSections' in JSON.parse(fs.readFileSync(packOf(vault), 'utf8'))));
    assert.deepEqual(insideVault(vault), []);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('a yaml the pin cannot parse: exit 3, nothing written, no backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    fs.writeFileSync(yamlOf(vault), 'player_site: [unclosed\n  - : :\n');
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.deepEqual(backupsIn(root), []);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('closed stdin without --yes: exit 1, nothing written', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const res = run(root, ['carry'], { input: '' });
    assert.equal(res.code, 1, res.all);
    assert.match(res.all, /carry aborted; nothing written/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.deepEqual(backupsIn(root), []);
  });
});

test('answering n writes nothing and exits 0; answering y carries', () => {
  withScratch((root) => {
    const vault = setup(root);
    const no = run(root, ['carry'], { input: 'n\n' });
    assert.equal(no.code, 0, no.all);
    assert.match(no.out, /Carry these settings into the vault's settings file\? \[y\/N\]/);
    assert.ok(!fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    assert.deepEqual(backupsIn(root), []);
    const yes = run(root, ['carry'], { input: 'y\n' });
    assert.equal(yes.code, 0, yes.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
  });
});

test('a legacy vault: exit 3 and "nothing to carry"', () => {
  withScratch((root) => {
    const vault = path.join(root, 'legacy');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    register(root, vault);
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /nothing to carry/);
    assert.deepEqual(backupsIn(root), []);
  });
});

test('a pack that lives outside the vault is refused before anything is written', () => {
  withScratch((root) => {
    const vault = setup(root);
    const outside = path.join(root, 'outside', 'vault.config.json');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.copyFileSync(packOf(vault), outside);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\nsite_config = '${outside}'\noutput = '${path.join(root, 'site')}'\n`);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /_meta\/scriptorium|_meta[\\/]scriptorium/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.deepEqual(backupsIn(root), []);
  });
});

// --- the module, driven directly (the options Task 8's init uses) ---------------------------------

function planFor(root, vault, extra = {}) {
  return planCarry({ vaultPath: vault, packConfigPath: packOf(vault), ...extra });
}

test('planCarry writes only its scratch folder and reports the pack as the site file', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault);
    assert.equal(planned.state, 'ready');
    assert.deepEqual(planned.blockers, []);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    const text = planned.lines.join('\n');
    assert.ok(text.includes(packOf(vault)), text);
    assert.ok(!text.includes(SCRATCH_PREFIX), text);
  });
});

test('planCarry with a siteConfig object uses it instead of the pack file, and its lines do not name a pack', () => {
  withScratch((root) => {
    const vault = setup(root);
    const planned = planFor(root, vault, { siteConfig: { excludeSections: ['Only This Section'] }, writePack: false });
    assert.equal(planned.state, 'ready');
    const text = planned.lines.join('\n');
    assert.deepEqual(planned.lines, ['player_site.hide.sections: adds "Only This Section".']);
    assert.ok(!text.includes(packOf(vault)), text);
    // The pack file's own hide entry is not in the plan: the object stood in for the file.
    assert.ok(!text.includes('Pack Only Secret'), text);
  });
});

test('planCarry with writePack false keeps a setting the vault cannot take in unmoved, and says so without naming a pack', () => {
  withScratch((root) => {
    const vault = setup(root);
    const planned = planFor(root, vault, { siteConfig: { excludeSections: ['Only This Section'], footer: 'Pack footer' }, writePack: false });
    assert.equal(planned.state, 'ready');
    assert.deepEqual(planned.unmoved.map((u) => u.name), ['footer']);
    assert.ok(planned.lines.includes("footer is not set in the vault's settings and init cannot put it there, so it stays in the pack for you to set in _meta/vault-config.yaml."), planned.lines.join('\n'));
    discardCarry(planned);
  });
});

test('applyCarry with writePack false changes only the yaml, and makes one backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault, { siteConfig: { excludeSections: ['Only This Section'] }, writePack: false });
    const done = applyCarry(planned, { machineDir: root, campaign: 't', writePack: false });
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Only This Section'));
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.equal(backupsIn(root).length, 1);
    assert.deepEqual(Object.keys(done.backups).sort(), ['yaml']);
  });
});

test('applyCarry with the default writePack rewrites the pack and reports both backups', () => {
  withScratch((root) => {
    const vault = setup(root);
    const planned = planFor(root, vault);
    const done = applyCarry(planned, { machineDir: root, campaign: 't', packWriter: writeCarriedPack });
    assert.deepEqual(Object.keys(done.backups).sort(), ['pack', 'yaml']);
    assert.ok(done.lines.length > 0);
    assert.equal(backupsIn(root).length, 2);
  });
});

test('applyCarry that rewrites the pack, given no packWriter, throws and writes nothing', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault);
    assert.throws(() => applyCarry(planned, { machineDir: root, campaign: 't' }), /needs a packWriter \(programming error\)/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.deepEqual(backupsIn(root), []);
    discardCarry(planned);
  });
});

test('a backup failure leaves everything unchanged', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault);
    // The machine folder is a file, so no backup folder can be made inside it.
    const notAFolder = path.join(root, 'a-file');
    fs.writeFileSync(notAFolder, 'x');
    assert.throws(() => applyCarry(planned, { machineDir: notAFolder, campaign: 't', packWriter: writeCarriedPack }), /could not back up/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
  });
});

test('the pin\'s "already on the new settings file" line is printed once, not once for the plan and again for the result', () => {
  withScratch((root) => {
    setup(root);
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    const line = 'This vault is already on the new settings file (_meta/vault-config.yaml).';
    assert.equal(res.out.split('\n').filter((l) => l === line).length, 1, res.out);
  });
});
