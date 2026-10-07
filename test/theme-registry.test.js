'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DEFAULT_THEME, INIT_DEFAULT_THEME, SLOT_NAMES, THEMES, loadTheme } = require('../src/build/themes');
const { ScriptoriumError } = require('../src/util/errors');

/*
 * ADR 0019, Structural decision 8: the theme registry. Every function takes
 * registry = THEMES, so a test fixture never lives inside the product
 * registry -- these tests build a throwaway registry pointing at a scratch
 * directory instead. Synthetic names only (NFR-08).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-registry-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixtureTheme(dir, { json, css = '@import url("x");\nbody { color: red; }\n', images } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (json !== null) {
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(json ?? { name: 'fixture', scheme: 'dark', slots: ['hero'] }));
  }
  if (css !== null) {
    fs.writeFileSync(path.join(dir, 'theme.css'), css);
  }
  if (images) {
    const imagesDir = path.join(dir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    for (const [rel, content] of Object.entries(images)) {
      fs.writeFileSync(path.join(imagesDir, rel), content);
    }
  }
}

function registryFor(dir) {
  return Object.freeze({ fixture: Object.freeze({ name: 'fixture', dir }) });
}

test('G1: THEMES holds exactly plain, haze then gloam, DEFAULT_THEME is plain, and the registry is frozen', () => {
  assert.deepEqual(Object.keys(THEMES), ['plain', 'haze', 'gloam']);
  assert.equal(DEFAULT_THEME, 'plain');
  assert.ok(Object.isFrozen(THEMES));
  assert.ok(Object.isFrozen(THEMES.plain));
  assert.ok(Object.isFrozen(THEMES.haze));
  assert.ok(Object.isFrozen(THEMES.gloam));
});

test('G2: SLOT_NAMES equals the literal list', () => {
  assert.deepEqual(SLOT_NAMES, ['hero', 'ground', 'paper', 'crest-frame', 'portrait', '404']);
  assert.ok(Object.isFrozen(SLOT_NAMES));
});

test('G3: loadTheme("plain") returns the exact file-less shape', () => {
  const theme = loadTheme('plain');
  assert.deepEqual(theme, {
    name: 'plain',
    dir: null,
    scheme: null,
    slots: [],
    css: null,
    images: [],
    fonts: [],
    owns: [],
    notice: null,
  });
});

test('G4: a tmp fixture theme loads, and its CSS equals the written bytes', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture-theme');
    const css = '@import url("x");\nbody { color: red; }\n';
    writeFixtureTheme(themeDir, {
      json: { name: 'fixture', scheme: 'dark', slots: ['hero'] },
      css,
      images: { 'mark.svg': '<svg></svg>' },
    });

    const theme = loadTheme('fixture', registryFor(themeDir));
    assert.equal(theme.name, 'fixture');
    assert.equal(theme.dir, themeDir);
    assert.equal(theme.scheme, 'dark');
    assert.deepEqual(theme.slots, ['hero']);
    assert.equal(theme.css, css);
    assert.deepEqual(theme.images, [{ rel: 'mark.svg', abs: path.join(themeDir, 'images', 'mark.svg') }]);
  });
});

test('G5: a broken fixture theme throws ScriptoriumError with the prefix theme "fixture" is broken: ', (t) => {
  const rows = [
    ['name mismatch', (dir) => writeFixtureTheme(dir, { json: { name: 'not-fixture', scheme: 'dark', slots: ['hero'] } })],
    ['scheme: "grey"', (dir) => writeFixtureTheme(dir, { json: { name: 'fixture', scheme: 'grey', slots: ['hero'] } })],
    ['slots: ["banner"]', (dir) => writeFixtureTheme(dir, { json: { name: 'fixture', scheme: 'dark', slots: ['banner'] } })],
    ['missing theme.css', (dir) => writeFixtureTheme(dir, { json: { name: 'fixture', scheme: 'dark', slots: ['hero'] }, css: null })],
  ];

  for (const [label, setup] of rows) {
    withScratchDir((dir) => {
      const themeDir = path.join(dir, 'fixture-theme');
      setup(themeDir);
      assert.throws(
        () => loadTheme('fixture', registryFor(themeDir)),
        (err) => err instanceof ScriptoriumError && err.message.startsWith('theme "fixture" is broken: '),
        `row failed: ${label}`,
      );
    });
  }

  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture-theme');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: ['hero'] }, images: { 'mark.svg': 'x' } });
    const linkPath = path.join(themeDir, 'images', 'linked.svg');
    try {
      fs.symlinkSync(path.join(themeDir, 'images', 'mark.svg'), linkPath);
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    assert.throws(
      () => loadTheme('fixture', registryFor(themeDir)),
      (err) => err instanceof ScriptoriumError && err.message.startsWith('theme "fixture" is broken: '),
      'row failed: a symlink in images/',
    );
  });
});

// -- ADR 0032, Structural decision 6: the defaults split -----------------------------------------

test('INIT_DEFAULT_THEME is "gloam", an own key of THEMES, distinct from the resolution default', () => {
  assert.equal(INIT_DEFAULT_THEME, 'gloam');
  assert.ok(Object.prototype.hasOwnProperty.call(THEMES, INIT_DEFAULT_THEME));
  assert.equal(DEFAULT_THEME, 'plain');
  assert.notEqual(INIT_DEFAULT_THEME, DEFAULT_THEME);
});
