'use strict';

// ADR 0032, Structural decision 1/2/5: the theme loader's composition ("extends"), ownership
// ("owns") and fonts/ walk. Fixture registries throughout (S1b cast convention: synthetic names
// only). Helpers below are COPIED from test/theme-registry.test.js, not imported, per that
// file's own convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { THEMES, loadTheme } = require('../src/build/themes');
const { ScriptoriumError } = require('../src/util/errors');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-extends-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixtureTheme(dir, { json, css = '@import url("x");\nbody { color: red; }\n', images, fonts, notice } = {}) {
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
  if (fonts) {
    const fontsDir = path.join(dir, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    for (const [rel, content] of Object.entries(fonts)) {
      const full = path.join(fontsDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  if (notice !== undefined) {
    fs.writeFileSync(path.join(dir, 'NOTICE.txt'), notice);
  }
}

function registryFrom(entries) {
  const out = {};
  for (const [key, dir] of Object.entries(entries)) {
    out[key] = Object.freeze({ name: key, dir });
  }
  return Object.freeze(out);
}

function assertBroken(fn, messageSubstring) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ScriptoriumError, `expected a ScriptoriumError, got ${err}`);
    assert.match(err.message, /^theme "[^"]*" is broken: /);
    assert.ok(err.message.includes(messageSubstring), `expected message to include "${messageSubstring}", got: ${err.message}`);
    return true;
  });
}

// ==== The composition oracle ====================================================================

test('T-EXT-1: a parent with a header comment, two @imports (one with a ; inside its url()) and a body composes correctly', () => {
  withScratchDir((dir) => {
    const parentDir = path.join(dir, 'parent');
    const parentCss =
      '/*\n * Header comment.\n */\n' +
      "@import url('https://fonts.example.invalid/css2?family=Foo:ital@0;1&display=swap');\n" +
      '@import url("https://fonts.example.invalid/bar.css");\n' +
      '/* ==== Tokens ==== */\n' +
      ':root {\n  --parent-token: #112233;\n}\n' +
      'body { color: var(--parent-token); }\n';
    writeFixtureTheme(parentDir, { json: { name: 'parent', scheme: 'dark', slots: [] }, css: parentCss });

    const childDir = path.join(dir, 'child');
    const childCss = '.child { color: red; }\n';
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' }, css: childCss });

    const registry = registryFrom({ parent: parentDir, child: childDir });
    const theme = loadTheme('child', registry);

    const expectedParentBody = parentCss.slice(parentCss.indexOf('/* ==== Tokens ==== */'));
    assert.equal(theme.css, `${expectedParentBody}\n${childCss}`);
  });
});

test('T-EXT-2: a parent with no @import at all composes as the whole parent file', () => {
  withScratchDir((dir) => {
    const parentDir = path.join(dir, 'parent');
    const parentCss = '/* no imports here */\n:root {\n  --p: #010203;\n}\n';
    writeFixtureTheme(parentDir, { json: { name: 'parent', scheme: 'dark', slots: [] }, css: parentCss });

    const childDir = path.join(dir, 'child');
    const childCss = '.child { color: blue; }\n';
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' }, css: childCss });

    const registry = registryFrom({ parent: parentDir, child: childDir });
    const theme = loadTheme('child', registry);
    assert.equal(theme.css, `${parentCss}\n${childCss}`);
  });
});

test('T-EXT-3: a theme with no extends composes as its own file only (unchanged behaviour)', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'solo');
    const css = 'body { color: green; }\n';
    writeFixtureTheme(themeDir, { json: { name: 'solo', scheme: 'dark', slots: [] }, css });
    const theme = loadTheme('solo', registryFrom({ solo: themeDir }));
    assert.equal(theme.css, css);
  });
});

// ==== SD-1 refusals =============================================================================

test('R-EXT-1: extends is not a string', () => {
  withScratchDir((dir) => {
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 5 } });
    assertBroken(() => loadTheme('child', registryFrom({ child: childDir })), 'extends must be a string');
  });
});

test('R-EXT-2: extends names a theme not present as an own key of the registry ("haz", "hazel", "toString")', () => {
  withScratchDir((dir) => {
    const parentDir = path.join(dir, 'haze');
    writeFixtureTheme(parentDir, { json: { name: 'haze', scheme: 'dark', slots: [] }, css: 'body {}\n' });
    for (const bad of ['haz', 'hazel', 'toString']) {
      const childDir = path.join(dir, `child-${bad}`);
      writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: bad } });
      assertBroken(
        () => loadTheme('child', registryFrom({ haze: parentDir, child: childDir })),
        `extends names unknown theme "${bad}"`,
      );
    }
  });
});

test('R-EXT-3: extends names the theme itself', () => {
  withScratchDir((dir) => {
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'child' } });
    assertBroken(() => loadTheme('child', registryFrom({ child: childDir })), 'extends must not name itself');
  });
});

test('R-EXT-4: the parent has dir: null', () => {
  withScratchDir((dir) => {
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'plain' } });
    const registry = Object.freeze({ plain: Object.freeze({ name: 'plain', dir: null }), child: Object.freeze({ name: 'child', dir: childDir }) });
    assertBroken(() => loadTheme('child', registry), 'extends "plain", which has no theme files');
  });
});

test('R-EXT-5: the parent has its own extends (depth 1 only)', () => {
  withScratchDir((dir) => {
    const grandparentDir = path.join(dir, 'grandparent');
    writeFixtureTheme(grandparentDir, { json: { name: 'grandparent', scheme: 'dark', slots: [] }, css: 'body {}\n' });
    const parentDir = path.join(dir, 'parent');
    writeFixtureTheme(parentDir, { json: { name: 'parent', scheme: 'dark', slots: [], extends: 'grandparent' }, css: '.p {}\n' });
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' } });
    const registry = registryFrom({ grandparent: grandparentDir, parent: parentDir, child: childDir });
    assertBroken(() => loadTheme('child', registry), 'extends "parent", which itself has extends');
  });
});

test('R-EXT-6: the parent has its own images/, fonts/ or NOTICE.txt', () => {
  withScratchDir((dir) => {
    for (const kind of ['images', 'fonts', 'notice']) {
      const parentDir = path.join(dir, `parent-${kind}`);
      writeFixtureTheme(parentDir, {
        json: { name: 'parent', scheme: 'dark', slots: [] },
        css: 'body {}\n',
        images: kind === 'images' ? { 'a.svg': '<svg/>' } : undefined,
        fonts: kind === 'fonts' ? { 'a.ttf': 'ttf-bytes' } : undefined,
        notice: kind === 'notice' ? 'a notice\n' : undefined,
      });
      const childDir = path.join(dir, `child-${kind}`);
      writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' } });
      const registry = registryFrom({ parent: parentDir, child: childDir });
      const expected = kind === 'notice' ? 'which has its own NOTICE.txt' : `which has its own ${kind}/`;
      assertBroken(() => loadTheme('child', registry), expected);
    }
  });
});

test('R-EXT-7: the child\'s own CSS (comments stripped) contains @import', () => {
  withScratchDir((dir) => {
    const parentDir = path.join(dir, 'parent');
    writeFixtureTheme(parentDir, { json: { name: 'parent', scheme: 'dark', slots: [] }, css: 'body {}\n' });
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, {
      json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' },
      css: '/* not */ @import url("https://x.example.invalid/x.css");\n.child {}\n',
    });
    assertBroken(
      () => loadTheme('child', registryFrom({ parent: parentDir, child: childDir })),
      'a theme with extends may not add its own imports',
    );
  });
});

test('R-EXT-8: parentBody (comments stripped) contains an @import outside the leading run', () => {
  withScratchDir((dir) => {
    const parentDir = path.join(dir, 'parent');
    // The leading run ends at the rule `body {}`; the @import after it is NOT part of the
    // leading run and so lands inside parentBody, which must refuse.
    writeFixtureTheme(parentDir, {
      json: { name: 'parent', scheme: 'dark', slots: [] },
      css: 'body {}\n@import url("https://x.example.invalid/late.css");\n',
    });
    const childDir = path.join(dir, 'child');
    writeFixtureTheme(childDir, { json: { name: 'child', scheme: 'dark', slots: [], extends: 'parent' }, css: '.child {}\n' });
    assertBroken(
      () => loadTheme('child', registryFrom({ parent: parentDir, child: childDir })),
      'has an @import outside its leading import run',
    );
  });
});

// ==== SD-2 owns ==================================================================================

test('O-1: owns absent defaults to []', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] } });
    assert.deepEqual(loadTheme('fixture', registryFrom({ fixture: themeDir })).owns, []);
  });
});

test('O-2: owns valid single and double members', () => {
  withScratchDir((dir) => {
    for (const owns of [['fonts'], ['palette'], ['fonts', 'palette']]) {
      const themeDir = path.join(dir, `fixture-${owns.join('-')}`);
      writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [], owns } });
      assert.deepEqual(loadTheme('fixture', registryFrom({ fixture: themeDir })).owns, owns);
    }
  });
});

test('O-3: owns rejects a duplicate member', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [], owns: ['fonts', 'fonts'] } });
    assertBroken(() => loadTheme('fixture', registryFrom({ fixture: themeDir })), 'owns must be an array of distinct members');
  });
});

test('O-4: owns rejects an unknown member ("palettes")', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [], owns: ['palettes'] } });
    assertBroken(() => loadTheme('fixture', registryFrom({ fixture: themeDir })), 'owns must be an array of distinct members');
  });
});

test('O-5: owns rejects a non-array', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [], owns: 'fonts' } });
    assertBroken(() => loadTheme('fixture', registryFrom({ fixture: themeDir })), 'owns must be an array of distinct members');
  });
});

// ==== SD-5 fonts walk ============================================================================

test('F-1: fonts are collected sorted by rel, code-unit order, including a nested folder', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, {
      json: { name: 'fixture', scheme: 'dark', slots: [] },
      fonts: { 'z.ttf': 'z', 'a.ttf': 'a', 'nested/m.ttf': 'm' },
    });
    const theme = loadTheme('fixture', registryFrom({ fixture: themeDir }));
    assert.deepEqual(theme.fonts.map((f) => f.rel), ['a.ttf', 'nested/m.ttf', 'z.ttf']);
    for (const f of theme.fonts) assert.equal(fs.readFileSync(f.abs, 'utf8'), path.basename(f.rel, '.ttf'));
  });
});

test('F-2: no fonts/ folder at all gives fonts: []', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] } });
    assert.deepEqual(loadTheme('fixture', registryFrom({ fixture: themeDir })).fonts, []);
  });
});

test('F-3: a symlink inside fonts/ is refused', { skip: process.platform === 'win32' }, (t) => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] } });
    const fontsDir = path.join(themeDir, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.writeFileSync(path.join(fontsDir, 'real.ttf'), 'real');
    try {
      fs.symlinkSync(path.join(fontsDir, 'real.ttf'), path.join(fontsDir, 'link.ttf'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlink creation not permitted in this sandbox');
        return;
      }
      throw err;
    }
    assertBroken(() => loadTheme('fixture', registryFrom({ fixture: themeDir })), "symlinks are not allowed in a theme's fonts/");
  });
});

test('F-4: an unrecognised extension is refused, including a string-prefix sibling ("x.ttfx", "x.ttf.txt")', () => {
  withScratchDir((dir) => {
    for (const bad of ['x.ttfx', 'x.ttf.txt', 'x.bin']) {
      const themeDir = path.join(dir, `fixture-${bad.replace(/[^a-z0-9]/gi, '')}`);
      writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] }, fonts: { [bad]: 'x' } });
      assertBroken(
        () => loadTheme('fixture', registryFrom({ fixture: themeDir })),
        'is not an allowed font type (woff2, woff, ttf, otf)',
      );
    }
  });
});

test('F-5: an uppercase extension (.TTF) is accepted, case-insensitively', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] }, fonts: { 'X.TTF': 'bytes' } });
    const theme = loadTheme('fixture', registryFrom({ fixture: themeDir }));
    assert.deepEqual(theme.fonts.map((f) => f.rel), ['X.TTF']);
  });
});

// ==== notice =====================================================================================

test('N-1: a NOTICE.txt is read verbatim', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] }, notice: 'line one\nline two\n' });
    assert.equal(loadTheme('fixture', registryFrom({ fixture: themeDir })).notice, 'line one\nline two\n');
  });
});

test('N-2: no NOTICE.txt gives notice: null', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'fixture');
    writeFixtureTheme(themeDir, { json: { name: 'fixture', scheme: 'dark', slots: [] } });
    assert.equal(loadTheme('fixture', registryFrom({ fixture: themeDir })).notice, null);
  });
});

// ==== real haze, real registry ===================================================================

test('H-EXT (issue #84): loadTheme("haze") on the real registry gives owns [], the 5 self-hosted woff2 files and the OFL notice', () => {
  const theme = loadTheme('haze', THEMES);
  assert.deepEqual(theme.owns, []);
  assert.deepEqual(
    theme.fonts.map((f) => f.rel),
    ['CormorantGaramond-Italic-wght.woff2', 'CormorantGaramond-wght.woff2', 'IMFeENit28P.woff2', 'IMFeENrm28P.woff2', 'IMFeENsc28P.woff2'],
  );
  assert.match(theme.notice, /SIL OPEN FONT LICENSE Version 1\.1/);
});
