'use strict';

/*
 * `init` against a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (ADR 0071).
 * Every case starts from a copy of the sample vault that the pin's own move has already run on,
 * with its campaign pack removed (a new GM's vault). The command runs as the real bin in a scratch
 * root. Expected values are typed by hand from the sample vault, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { runInitCommand } = require('../src/cli/init');
const pinned = require('../src/generator/pinned');
const { VaultUnreachableError } = require('../src/util/errors');
const { stripEntriesForMovedVault } = require('../src/setup/scaffold');
const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');

const yamlOf = (vault) => path.join(vault, '_meta', 'vault-config.yaml');
const packJsonOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
const backupsIn = (root) => {
  const dir = path.join(root, 'backups', 'campaign-x');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const reports = (out, id) => new RegExp(`^(?:ERROR|WARN|INFO) ${id}`, 'm').test(out);

/** A moved copy of the sample whose yaml sets no title and no folder map, with no pack. */
function movedNoPack(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  assertMovedLayout(vaultPath);
  fs.rmSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true, force: true });
  const yaml = fs.readFileSync(yamlOf(vaultPath), 'utf8');
  assert.ok(!/^ {2}title:/m.test(yaml), 'the fixture yaml must set no title');
  assert.ok(!/folder_map:/.test(yaml), 'the fixture yaml must set no folder map');
  return vaultPath;
}

const initArgs = (vault, root, extra = []) => ['init', '--yes', '--name', 'x', '--vault', vault, '--out', path.join(root, 'site'), ...extra];

test('a moved vault with no title: the pack holds none of the moved keys and the yaml gets the title and the folder map', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const pack = JSON.parse(fs.readFileSync(packJsonOf(vault), 'utf8'));
    for (const key of ['siteTitle', 'folderMap', 'excludeDirs', 'excludeSections', 'landingTagline', 'attachmentsDir']) {
      assert.ok(!(key in pack), `the pack must not hold ${key}`);
    }
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(yaml, /^ {2}title: "?The Long Lease"?$/m);
    assert.match(yaml, /folder_map:/);
    assert.match(yaml, /Characters\/NPCs/);
    assert.match(yaml, /"?_resources"?/, 'the hide list holds the folder init hides');
    const names = backupsIn(root);
    assert.equal(names.length, 1, names.join(','));
    assert.match(names[0], /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak$/);
    assert.match(res.out, /carry|vault-config\.yaml/i);
  });
});

test('after init on a moved vault with no title, check does not report the folder map as left in the pack, and a build publishes a mapped entity page', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const out = path.join(root, 'site');
    assert.equal(run(root, initArgs(vault, root)).code, 0);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.x]\nvault = '${vault}'\noutput = '${out}'\n`);
    const check = run(root, ['check', 'x']);
    assert.ok(!reports(check.all, 'config/folder-map-not-carried'), check.all);
    const build = run(root, ['build', 'x']);
    assert.equal(build.code, 0, build.all);
    // The generator always writes a section's index.html; an entity page is there only when the folder is mapped.
    assert.ok(fs.existsSync(path.join(out, 'characters', 'npcs', 'clemency-vare.html')), `characters/npcs holds: ${fs.readdirSync(path.join(out, 'characters', 'npcs'))}`);
  });
});

test('a moved vault that already holds everything init would carry: the yaml is byte-identical and no backup is made', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    // The fixture is typed by hand: init's folders, its callouts rule, and a title and a folder map.
    let yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    yaml = replaceChecked(yaml, 'player_site:\n', 'player_site:\n  title: "Typed Title"\n  folder_map:\n    "Characters/NPCs": "characters/npcs"\n');
    yaml = replaceChecked(yaml, 'folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates", "_resources"]');
    yaml = replaceChecked(yaml, '"reliability"]\n', '"reliability"]\n    callouts: true\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const before = fs.readFileSync(yamlOf(vault));
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    assert.ok(Buffer.compare(before, fs.readFileSync(yamlOf(vault))) === 0, 'the yaml must not change');
    assert.deepEqual(backupsIn(root), []);
    const pack = JSON.parse(fs.readFileSync(packJsonOf(vault), 'utf8'));
    assert.ok(!('siteTitle' in pack));
  });
});

test('a moved vault whose hide lists already match init but sets no title or folder map: both are added', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    let yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    yaml = replaceChecked(yaml, 'folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates", "_resources"]');
    yaml = replaceChecked(yaml, '"reliability"]\n', '"reliability"]\n    callouts: true\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const after = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(after, /^ {2}title: "?The Long Lease"?$/m);
    assert.match(after, /Characters\/NPCs/);
    assert.equal(backupsIn(root).length, 1);
  });
});

test('a moved vault whose yaml has only a title: the title is kept and the folder map is added', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const yaml = replaceChecked(fs.readFileSync(yamlOf(vault), 'utf8'), 'player_site:\n', 'player_site:\n  title: "Typed Title"\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const after = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(after, /^ {2}title: "?Typed Title"?$/m);
    assert.ok(!/The Long Lease"?$/m.test(after.split('\n').filter((l) => /^ {2}title:/.test(l)).join('\n')));
    assert.match(after, /folder_map:/);
    assert.match(after, /Characters\/NPCs/);
  });
});

test('a moved vault with a title: --title that differs exits 1 and writes nothing', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const yaml = replaceChecked(fs.readFileSync(yamlOf(vault), 'utf8'), 'player_site:\n', 'player_site:\n  title: "Typed Title"\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root, ['--title', 'Other Title']));
    assert.equal(res.code, 1);
    assert.match(res.err, /this vault's title is set in _meta\/vault-config\.yaml; change it there/);
    assert.equal(fs.readFileSync(yamlOf(vault), 'utf8'), yaml);
    assert.ok(!fs.existsSync(path.join(vault, '_meta', 'scriptorium')));
  });
});

test('--title on a moved vault with no title sets that title in the yaml', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const res = run(root, initArgs(vault, root, ['--title', 'Chosen Name']));
    assert.equal(res.code, 0, res.all);
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /^ {2}title: "?Chosen Name"?$/m);
  });
});

test('re-running init on the same moved vault changes nothing and makes no second backup', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    assert.equal(run(root, initArgs(vault, root)).code, 0);
    const yaml = fs.readFileSync(yamlOf(vault));
    const pack = fs.readFileSync(packJsonOf(vault));
    const again = run(root, initArgs(vault, root));
    assert.equal(again.code, 0, again.all);
    assert.ok(Buffer.compare(yaml, fs.readFileSync(yamlOf(vault))) === 0);
    assert.ok(Buffer.compare(pack, fs.readFileSync(packJsonOf(vault))) === 0);
    assert.equal(backupsIn(root).length, 1);
  });
});

test('without --yes, init asks once, in the scaffold question, and a no writes nothing', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const before = fs.readFileSync(yamlOf(vault));
    const args = ['init', '--name', 'x', '--vault', vault, '--out', path.join(root, 'site'), '--title', 'Chosen Name', '--theme', 'gloam'];
    const no = run(root, args, { input: 'n\n' });
    assert.equal(no.code, 1, no.all);
    assert.equal((no.out.match(/\[Y\/n\]/g) || []).length, 1, no.out);
    assert.match(no.out, /vault-config\.yaml/);
    assert.ok(Buffer.compare(before, fs.readFileSync(yamlOf(vault))) === 0);
    assert.ok(!fs.existsSync(packJsonOf(vault)));
    const yes = run(root, args, { input: 'y\n' });
    assert.equal(yes.code, 0, yes.all);
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /^ {2}title: "?Chosen Name"?$/m);
  });
});

test('init --new-vault still makes the old layout', (t) => {
  withScratch((root) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fresh-'));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    const dest = path.join(elsewhere, 'fresh');
    const res = run(root, ['init', '--yes', '--name', 'x', '--new-vault', dest, '--system', 'none', '--title', 'Fresh Tale', '--out', path.join(root, 'site')]);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.existsSync(path.join(dest, '_meta', 'vault-config.md')));
    assert.ok(!fs.existsSync(path.join(dest, '_meta', 'vault-config.yaml')));
    assert.ok(fs.existsSync(path.join(dest, '_meta', 'scriptorium', 'vault.config.json')));
  });
});

test('init prints what it will set in the vault settings, before it asks and with --yes', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    assert.ok(res.out.includes('  player_site.title: set to "The Long Lease".'), res.out);
    assert.ok(res.out.includes('  player_site.hide.folders: adds "_resources".'), res.out);
    assert.ok(res.out.includes('Hide lists only gain entries; a title or folder map the file already sets is kept.'), res.out);
    assert.ok(!res.out.includes('vault.config.json: siteTitle'), 'no line about taking settings out of a pack that does not exist');
  });
});

test('without --yes the lines come before the question', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const args = ['init', '--name', 'x', '--vault', vault, '--out', path.join(root, 'site'), '--title', 'Chosen Name', '--theme', 'gloam'];
    const res = run(root, args, { input: 'n\n' });
    const at = res.out.indexOf('  player_site.title: set to "Chosen Name".');
    assert.ok(at >= 0 && at < res.out.indexOf('[Y/n]'), res.out);
  });
});

test('a yaml folder map differing from init\'s is kept, and the output says so', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const yaml = replaceChecked(
      fs.readFileSync(yamlOf(vault), 'utf8'),
      'player_site:\n',
      'player_site:\n  folder_map:\n    "Characters/NPCs": "characters/npcs"\n',
    );
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    assert.ok(
      res.out.includes('but the vault\'s settings set player_site.folder_map to {"Characters/NPCs":"characters/npcs"}; the vault\'s value is kept.'),
      res.out,
    );
    assert.ok(!/Locations/.test(fs.readFileSync(yamlOf(vault), 'utf8').split('folder_map:')[1].split('not_found')[0]), 'the yaml map was not extended');
  });
});

test('a yaml with a title and folder map but weaker hide lists gains init\'s hide lists', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    let yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    yaml = replaceChecked(yaml, 'player_site:\n', 'player_site:\n  title: "Typed Title"\n  folder_map:\n    "Characters/NPCs": "characters/npcs"\n');
    yaml = replaceChecked(yaml, 'folders: ["_meta", "_Templates"]', 'folders: ["_meta"]');
    yaml = replaceChecked(yaml, 'sections: ["GM Notes", "DM Notes", "Player Notes", "Source References", "Reconciliation Context", "Handoff to Reconcile"]', 'sections: ["GM Notes"]');
    yaml = replaceChecked(yaml, '"reliability"]\n', '"reliability"]\n    callouts: false\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const after = fs.readFileSync(yamlOf(vault), 'utf8');
    for (const f of ['_meta', '_Templates', '_resources']) assert.match(after, new RegExp(`folders: \\[[^\\]]*\\b${f}\\b`), `hide.folders must hold ${f}:\n${after}`);
    assert.match(after, /sections: \[[^\]]*Handoff to Reconcile/);
    assert.match(after, /callouts: true/);
    assert.match(after, /^ {2}title: "?Typed Title"?$/m);
  });
});

test('an invalid settings file makes init exit 3 with one plain line and no stack', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    fs.appendFileSync(yamlOf(vault), '\nbroken: [\n');
    const before = fs.readFileSync(yamlOf(vault));
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 3, res.all);
    assert.equal(res.err.trim().split('\n').length, 1, res.err);
    assert.ok(!/\n\s+at /.test(res.err), res.err);
    assert.match(res.err, /could not be read/);
    assert.ok(Buffer.compare(before, fs.readFileSync(yamlOf(vault))) === 0);
    assert.ok(!fs.existsSync(path.join(vault, '_meta', 'scriptorium')));
  });
});

test('a setting the vault cannot take stays in the pack when the pack is made', () => {
  const entries = [{ rel: 'vault.config.json', kind: 'file', data: JSON.stringify({ siteTitle: 'T', folderMap: { A: 'a' }, footer: 'Pack footer', backend: { inbox: false } }) }];
  const plain = JSON.parse(stripEntriesForMovedVault(entries).entries[0].data);
  assert.ok(!('siteTitle' in plain) && !('folderMap' in plain), JSON.stringify(plain));
  const kept = JSON.parse(stripEntriesForMovedVault(entries, ['siteTitle', 'backend.inbox']).entries[0].data);
  assert.equal(kept.siteTitle, 'T');
  assert.deepEqual(kept.backend, { inbox: false });
  assert.ok(!('folderMap' in kept));
});

/** init in this process, on a moved vault, with answers given by --yes. */
async function initInProcess(root, vault) {
  const configPath = path.join(root, 'config.toml');
  const output = { isTTY: false, write: () => true };
  try {
    const result = await runInitCommand(
      { config: configPath, name: 'x', vault, out: path.join(root, 'site'), yes: true },
      [],
      { input: new PassThrough(), output },
    );
    return { code: result.exitCode };
  } catch (err) {
    if (err instanceof VaultUnreachableError) return { code: 3, err };
    throw err;
  }
}

test('when the vault settings cannot be written, init exits 3, says to run the command again, and writes no pack', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-initfail-'));
  const real = pinned.applySettingsChanges;
  try {
    const vault = movedNoPack(root);
    pinned.applySettingsChanges = () => {
      throw new Error('EACCES: permission denied');
    };
    const res = await initInProcess(root, vault);
    pinned.applySettingsChanges = real;
    assert.equal(res.code, 3);
    assert.match(res.err.message, /^The site title and folder map could not be set in the vault's settings file \(EACCES: permission denied\)\. Nothing else was written\. Run the command again once the file can be written\./);
    assert.ok(!/gm-scriptorium carry|still in/.test(res.err.message), res.err.message);
    assert.ok(!fs.existsSync(path.join(vault, '_meta', 'scriptorium')));
  } finally {
    pinned.applySettingsChanges = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a setting the vault settings cannot take stays in the pack init makes, with its value', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-initkeep-'));
  const real = pinned.readVaultConfigTemplate;
  try {
    const vault = movedNoPack(root);
    // A stand-in template that carries one setting the pin cannot move into the vault's settings.
    pinned.readVaultConfigTemplate = () => JSON.stringify({ ...JSON.parse(real()), footer: 'Typed footer' });
    const res = await initInProcess(root, vault);
    pinned.readVaultConfigTemplate = real;
    assert.equal(res.code, 0);
    const pack = JSON.parse(fs.readFileSync(packJsonOf(vault), 'utf8'));
    assert.equal(pack.footer, 'Typed footer');
    assert.ok(!('siteTitle' in pack) && !('folderMap' in pack));
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /^ {2}title: "?The Long Lease"?$/m);
  } finally {
    pinned.readVaultConfigTemplate = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
