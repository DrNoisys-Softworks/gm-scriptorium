'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

/*
 * The pieces `init` and browser setup share live in src/setup/scaffold.js. `init.js` re-exports the
 * identical objects (the src/setup/validate.js precedent), so its own export block and every
 * test/init-* file are unaffected. Expected texts below are written out by hand from init's
 * behaviour, never read back from the module under test.
 */

const init = require('../src/cli/init');
const scaffold = require('../src/setup/scaffold');

test('init.js re-exports the identical objects scaffold.js defines (wiring only: this proves nothing about behaviour)', () => {
  assert.equal(init.SCAFFOLD, scaffold.SCAFFOLD);
  assert.equal(init.defaultOutputFor, scaffold.defaultOutputFor);
  assert.equal(init.defaultTitleFor, scaffold.defaultTitleFor);
  assert.equal(init.composeVaultConfigJson, scaffold.composeVaultConfigJson);
});

test('SCAFFOLD is the four pack entries, in write order', () => {
  assert.deepEqual(
    scaffold.SCAFFOLD.map((e) => `${e.kind}:${e.rel}`),
    ['dir:css', 'dir:images', 'file:pack.toml', 'file:vault.config.json'],
  );
  assert.ok(Object.isFrozen(scaffold.SCAFFOLD));
});

test('defaultOutputFor is a sibling of the vault named <name>-site', () => {
  assert.equal(scaffold.defaultOutputFor(path.join(path.sep, 'a', 'b', 'vault'), 'lease'), path.join(path.sep, 'a', 'b', 'lease-site'));
});

test('scaffoldEntries builds the four entries init writes, in order, with the theme and title applied', () => {
  const entries = scaffold.scaffoldEntries(require('./helpers/setup-fixtures').SAMPLE, scaffold.SCAFFOLD, { title: 'My Title', theme: 'haze' });
  assert.deepEqual(
    entries.map((e) => `${e.kind}:${e.rel}`),
    ['dir:css', 'dir:images', 'file:pack.toml', 'file:vault.config.json'],
  );
  assert.equal(entries[2].data, 'theme = "haze"\n');
  const json = JSON.parse(entries[3].data);
  assert.equal(json.siteTitle, 'My Title');
  assert.equal(json.landingTagline, '');
  assert.equal(json.attachmentsDir, '_attachments');
  assert.equal(json.folderMap.Locations, 'locations');
  assert.deepEqual(json.excludeDirs, ['_meta', '_Templates', '_resources']);
  assert.ok(entries[3].data.endsWith('\n'));
});

test('scaffoldEntries writes only the entries it is given (existing pack files are never rebuilt)', () => {
  const only = scaffold.SCAFFOLD.filter((e) => e.rel === 'pack.toml');
  const entries = scaffold.scaffoldEntries(require('./helpers/setup-fixtures').SAMPLE, only, { title: 'T', theme: 'plain' });
  assert.deepEqual(entries, [{ rel: 'pack.toml', kind: 'file', data: 'theme = "plain"\n' }]);
});

test('nonEmptyOutputWarning is the exact text init prints before asking to continue', () => {
  assert.equal(
    scaffold.nonEmptyOutputWarning('/x/out'),
    'warning: /x/out exists and is not empty; the first build will replace its contents',
  );
});

test('nonEmptyOutputRefusal is the exact text init --yes throws', () => {
  assert.equal(
    scaffold.nonEmptyOutputRefusal('/x/out'),
    'refusing to use /x/out as the output folder: it exists and is not empty and does not look like a ' +
      'previous build; choose an empty or new folder',
  );
});

test('isNonEmptyForeignOutput: absent and empty folders are fine, a folder with other files is foreign, an earlier build is not', (t) => {
  const { scratchRoot } = require('./helpers/setup-fixtures');
  const fs = require('fs');
  const root = scratchRoot(t);
  assert.equal(scaffold.isNonEmptyForeignOutput(path.join(root, 'nope')), false);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.equal(scaffold.isNonEmptyForeignOutput(empty), false);
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x');
  assert.equal(scaffold.isNonEmptyForeignOutput(foreign), true);
  const build = path.join(root, 'build');
  fs.mkdirSync(path.join(build, 'css'), { recursive: true });
  fs.writeFileSync(path.join(build, 'index.html'), 'x');
  fs.writeFileSync(path.join(build, 'css', 'scriptorium.css'), 'x');
  assert.equal(scaffold.isNonEmptyForeignOutput(build), false);
});
