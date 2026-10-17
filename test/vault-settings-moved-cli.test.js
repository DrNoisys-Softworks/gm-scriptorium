'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');

/*
 * Issue #171, the output gate. `build` and `check` on a vault whose settings moved to
 * _meta/vault-config.yaml (moved), or that holds both files (mixed), must exit 3 with the one
 * refusal message and leave no output behind. The sample vault has a GM-only section and a pack,
 * so a build that got through would write real site files. SCRIPTORIUM_TEST_BIN runs this same
 * file against the packaged binary.
 */

const ISSUE = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/171';

function movedMessage(vault) {
  return (
    `campaign "t": ${vault} keeps its settings in _meta/vault-config.yaml, the file the gm-apprentice plugin's update moves a vault's settings to. ` +
    'This version of GM-Scriptorium reads only _meta/vault-config.md, so it won\'t check, build or serve this campaign. ' +
    'Nothing in the vault was read or changed. ' +
    'Don\'t create, copy or edit a vault-config.md to get round this. ' +
    `Support comes in a later GM-Scriptorium release; to follow it, see ${ISSUE}`
  );
}

function mixedMessage(vault) {
  return (
    `campaign "t": ${vault} keeps its settings in _meta/vault-config.yaml, the file the gm-apprentice plugin's update moves a vault's settings to. ` +
    'Its _meta/vault-config.md is a leftover that gm-apprentice ignores. ' +
    'This version of GM-Scriptorium reads only _meta/vault-config.md, so it won\'t check, build or serve this campaign. ' +
    'Nothing in the vault was read or changed. ' +
    'Don\'t create, copy or edit a vault-config.md to get round this. ' +
    `Support comes in a later GM-Scriptorium release; to follow it, see ${ISSUE}`
  );
}

/** A copy of the sample vault (GM-only section and pack present), registered as campaign "t". */
function setup(root, state) {
  const vault = path.join(root, 'v');
  fs.cpSync(SAMPLE, vault, { recursive: true });
  const md = path.join(vault, '_meta', 'vault-config.md');
  const yaml = path.join(vault, '_meta', 'vault-config.yaml');
  if (state === 'moved') fs.renameSync(md, yaml);
  if (state === 'mixed') fs.copyFileSync(md, yaml);
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\noutput = '${path.join(root, 'site')}'\n`);
  return vault;
}

/** Sorted "relative path : sha256" lines for every file under dir (folders as "path/"). */
function snapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else {
        out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  })(dir, '');
  return out.sort();
}

test('sample vault holds a GM-only section and a pack (so a leak would be real)', () => {
  assert.match(fs.readFileSync(path.join(SAMPLE, 'Locations', 'The Tally Cliffs.md'), 'utf8'), /<!-- gm-only -->/);
  assert.ok(fs.existsSync(path.join(SAMPLE, '_meta', 'scriptorium', 'pack.toml')));
});

test('build on a moved vault exits 3 with the refusal and the output folder is never created', () => {
  withScratch((root) => {
    const vault = setup(root, 'moved');
    const res = run(root, ['build']);
    assert.equal(res.code, 3, res.all);
    assert.ok(res.all.includes(movedMessage(vault)), res.all);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.scriptorium-')), []);
  });
});

test('build on a moved vault leaves an existing output folder byte-unchanged, with no staging folder beside it', () => {
  withScratch((root) => {
    const vault = setup(root, 'moved');
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'index.html'), '<p>kept</p>');
    const before = snapshot(root);
    const res = run(root, ['build']);
    assert.equal(res.code, 3, res.all);
    assert.ok(res.all.includes(movedMessage(vault)), res.all);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.scriptorium-')), []);
  });
});

test('build on a mixed vault exits 3 with the mixed refusal and writes nothing', () => {
  withScratch((root) => {
    const vault = setup(root, 'mixed');
    const before = snapshot(vault);
    const res = run(root, ['build']);
    assert.equal(res.code, 3, res.all);
    assert.ok(res.all.includes(mixedMessage(vault)), res.all);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
    assert.deepEqual(snapshot(vault), before, 'the vault is untouched');
  });
});

test('check on a mixed vault whose leftover vault-config.md has malformed frontmatter still exits 3 with the mixed refusal (settings are never read)', () => {
  withScratch((root) => {
    const vault = setup(root, 'mixed');
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\npublish: [unclosed\n  : : :\n---\n');
    const res = run(root, ['check']);
    assert.equal(res.code, 3, res.all);
    assert.ok(res.all.includes(mixedMessage(vault)), res.all);
  });
});
