'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planThemeAssets, writeThemeAssets } = require('../src/build/themeassets');
const { ScriptoriumError } = require('../src/util/errors');
const { THEME_MARKER_ATTR } = require('../src/build/themestyle');
const { MARKER_ATTR: HOUSESTYLE_MARKER_ATTR } = require('../src/build/housestyle');
const readModule = require('../src/vault/read');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-assets-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function emptyPackToml(siteDir) {
  return { path: path.join(siteDir, 'pack.toml'), present: false, theme: 'plain', images: [], warnings: [] };
}

function presentPackToml(siteDir, images, theme = 'plain') {
  return { path: path.join(siteDir, 'pack.toml'), present: true, theme, images, warnings: [] };
}

test('A1: no pack.toml plus an images/a.png gives an empty plan, with 0 readBytes calls', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'images', 'a.png'), 'x');

    const spy = mock.method(readModule, 'readBytes');
    try {
      const plan = planThemeAssets({
        vaultPath,
        jsonConfig: { vaultPath, excludeDirs: [] },
        siteDir,
        packToml: emptyPackToml(siteDir),
        campaign: 'alpha',
      });
      assert.deepEqual(plan, { campaign: 'alpha', tomlPath: path.join(siteDir, 'pack.toml'), theme: 'plain', files: [], css: null, warnings: [] });
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});

test('A2: a vault: ground slot gives the exact file and CSS', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    const sourceBytes = Buffer.from([0x01, 0x02, 0x03]);
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'x.webp'), sourceBytes);

    const packToml = presentPackToml(siteDir, [{ slot: 'ground', raw: 'vault:_attachments/x.webp', kind: 'vault', rel: '_attachments/x.webp' }]);
    const plan = planThemeAssets({ vaultPath, jsonConfig: { vaultPath, excludeDirs: [] }, siteDir, packToml, campaign: 'alpha' });

    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].outRel, 'scriptorium/slots/ground.webp');
    assert.deepEqual(plan.files[0].bytes, sourceBytes);
    assert.equal(plan.css, ':root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n');
  });
});

test('A3: a pack slot plus pack images, sorted, with the exact W-NONIMAGE warning', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'images', 'Hero.JPG'), 'hero-bytes');
    fs.writeFileSync(path.join(siteDir, 'images', 'a.png'), 'a-bytes');
    fs.writeFileSync(path.join(siteDir, 'images', 'notes.txt'), 'not an image');

    const packToml = presentPackToml(siteDir, [{ slot: 'hero', raw: 'images/Hero.JPG', kind: 'pack', rel: 'images/Hero.JPG' }]);
    const plan = planThemeAssets({ vaultPath, jsonConfig: { vaultPath, excludeDirs: [] }, siteDir, packToml, campaign: 'alpha' });

    assert.deepEqual(
      plan.files.map((f) => f.outRel),
      ['scriptorium/campaign/Hero.JPG', 'scriptorium/campaign/a.png', 'scriptorium/slots/hero.jpg'],
    );
    assert.deepEqual(plan.warnings, [`${path.join(siteDir, 'images', 'notes.txt')}: not an allowed image type; not copied`]);
  });
});

test('A4: convention-pack images under _meta/scriptorium/images are copied; a pack-relative slot there is exempt from exclusion', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'images', 'mark.svg'), '<svg></svg>');

    const packToml = presentPackToml(siteDir, [{ slot: 'hero', raw: 'images/mark.svg', kind: 'pack', rel: 'images/mark.svg' }]);
    const plan = planThemeAssets({ vaultPath, jsonConfig: { vaultPath, excludeDirs: [] }, siteDir, packToml, campaign: 'alpha' });

    assert.deepEqual(
      plan.files.map((f) => f.outRel),
      ['scriptorium/campaign/mark.svg', 'scriptorium/slots/hero.svg'],
    );
  });
});

test('A5: read.readBytes is called exactly once per accepted image, with its real path', () => {
  withScratchDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_attachments', 'x.webp'), 'bytes');
    fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'images', 'a.png'), 'a-bytes');

    const packToml = presentPackToml(siteDir, [{ slot: 'ground', raw: 'vault:_attachments/x.webp', kind: 'vault', rel: '_attachments/x.webp' }]);

    const spy = mock.method(readModule, 'readBytes');
    try {
      const plan = planThemeAssets({ vaultPath, jsonConfig: { vaultPath, excludeDirs: [] }, siteDir, packToml, campaign: 'alpha' });
      assert.equal(plan.files.length, 2);
      assert.equal(spy.mock.calls.length, 2);
      const calledPaths = spy.mock.calls.map((c) => c.arguments[0]).sort();
      assert.deepEqual(calledPaths, [fs.realpathSync(path.join(siteDir, 'images', 'a.png')), fs.realpathSync(path.join(vaultPath, '_attachments', 'x.webp'))].sort());
    } finally {
      spy.mock.restore();
    }
  });
});

// --- writeThemeAssets --------------------------------------------------

test('W1: the empty plan touches nothing', () => {
  withScratchDir((dir) => {
    const stagingOut = path.join(dir, 'staging-out');
    const result = writeThemeAssets(stagingOut, null);
    assert.deepEqual(result, { written: false, files: 0, pagesLinked: 0 });
    assert.equal(fs.existsSync(stagingOut), false);

    const emptyPlan = { campaign: 'alpha', tomlPath: path.join(dir, 'pack.toml'), theme: 'plain', files: [], css: null, warnings: [] };
    const result2 = writeThemeAssets(stagingOut, emptyPlan);
    assert.deepEqual(result2, { written: false, files: 0, pagesLinked: 0 });
    assert.equal(fs.existsSync(stagingOut), false);
  });
});

test('W2: the files, the CSS and the links are written, and the counts are returned', () => {
  withScratchDir((dir) => {
    const stagingOut = path.join(dir, 'staging-out');
    fs.mkdirSync(stagingOut, { recursive: true });
    const pageHtml =
      '<html><head><link rel="stylesheet" href="css/scriptorium.css" ' +
      HOUSESTYLE_MARKER_ATTR +
      '><link rel="stylesheet" href="css/overrides.css"></head><body></body></html>';
    fs.writeFileSync(path.join(stagingOut, 'index.html'), pageHtml);

    const plan = {
      campaign: 'alpha',
      tomlPath: path.join(dir, 'pack.toml'),
      theme: 'plain',
      files: [{ outRel: 'scriptorium/slots/ground.webp', bytes: Buffer.from([1, 2, 3]) }],
      css: ':root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n',
      warnings: [],
    };
    const result = writeThemeAssets(stagingOut, plan);
    assert.deepEqual(result, { written: true, files: 1, pagesLinked: 1 });

    assert.deepEqual(fs.readFileSync(path.join(stagingOut, 'scriptorium', 'slots', 'ground.webp')), Buffer.from([1, 2, 3]));
    assert.equal(fs.readFileSync(path.join(stagingOut, 'css', 'scriptorium-theme.css'), 'utf8'), plan.css);
    const patched = fs.readFileSync(path.join(stagingOut, 'index.html'), 'utf8');
    assert.ok(patched.includes(THEME_MARKER_ATTR));
  });
});

test('W3: a plan outRel outside scriptorium/ throws ScriptoriumError, and no path under images/ is ever created', () => {
  withScratchDir((dir) => {
    const stagingOut = path.join(dir, 'staging-out');
    fs.mkdirSync(stagingOut, { recursive: true });
    const plan = {
      campaign: 'alpha',
      tomlPath: path.join(dir, 'pack.toml'),
      theme: 'plain',
      files: [{ outRel: 'images/evil.webp', bytes: Buffer.from('x') }],
      css: null,
      warnings: [],
    };
    assert.throws(() => writeThemeAssets(stagingOut, plan), ScriptoriumError);
    assert.equal(fs.existsSync(path.join(stagingOut, 'images')), false);
  });
});

// -- ADR 0032, Structural decision 5: theme fonts go through planThemeAssets too --------------

function writeFixtureFontTheme(dir, { fonts, extraJson } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'theme.json'),
    JSON.stringify({ name: 'fixture', scheme: 'dark', slots: [], ...extraJson }),
  );
  fs.writeFileSync(path.join(dir, 'theme.css'), 'body { color: red; }\n');
  if (fonts) {
    const fontsDir = path.join(dir, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    for (const [rel, content] of Object.entries(fonts)) {
      fs.writeFileSync(path.join(fontsDir, rel), content);
    }
  }
}

function fixtureRegistry(dir) {
  return Object.freeze({ fixture: Object.freeze({ name: 'fixture', dir }) });
}

test('A-FONT-1: a fixture theme\'s fonts are planned under scriptorium/theme/fonts/, with the exact bytes', () => {
  withScratchDir((dir) => {
    const themeDir = path.join(dir, 'theme');
    const fontBytes = Buffer.from('a fake but plausible ttf payload');
    writeFixtureFontTheme(themeDir, { fonts: { 'A.ttf': fontBytes } });

    const siteDir = path.join(dir, 'site');
    const packToml = presentPackToml(siteDir, [], 'fixture');
    const plan = planThemeAssets({
      vaultPath: path.join(dir, 'vault'),
      jsonConfig: { vaultPath: path.join(dir, 'vault'), excludeDirs: [] },
      siteDir,
      packToml,
      campaign: 'alpha',
      registry: fixtureRegistry(themeDir),
    });

    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].outRel, 'scriptorium/theme/fonts/A.ttf');
    assert.deepEqual(plan.files[0].bytes, fontBytes);
  });
});

test('A-FONT-2: an over-limit font throws the size ConfigError; exactly 10485760 bytes is accepted', () => {
  withScratchDir((dir) => {
    const bigThemeDir = path.join(dir, 'theme-big');
    writeFixtureFontTheme(bigThemeDir, { fonts: { 'Big.ttf': Buffer.alloc(10485761) } });
    const siteDir = path.join(dir, 'site');
    const packToml = presentPackToml(siteDir, [], 'fixture');
    assert.throws(
      () =>
        planThemeAssets({
          vaultPath: path.join(dir, 'vault'),
          jsonConfig: { vaultPath: path.join(dir, 'vault'), excludeDirs: [] },
          siteDir,
          packToml,
          campaign: 'alpha',
          registry: fixtureRegistry(bigThemeDir),
        }),
      (err) => {
        assert.ok(err.message.includes('10485761 bytes, over the 10 MiB (10485760-byte) limit'));
        return true;
      },
    );

    const okThemeDir = path.join(dir, 'theme-ok');
    writeFixtureFontTheme(okThemeDir, { fonts: { 'Ok.ttf': Buffer.alloc(10485760) } });
    const plan = planThemeAssets({
      vaultPath: path.join(dir, 'vault'),
      jsonConfig: { vaultPath: path.join(dir, 'vault'), excludeDirs: [] },
      siteDir,
      packToml,
      campaign: 'alpha',
      registry: fixtureRegistry(okThemeDir),
    });
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].bytes.length, 10485760);
  });
});

test('A-FONT-3: the loader\'s font refusals (symlink, disallowed extension) propagate through planThemeAssets', { skip: process.platform === 'win32' }, (t) => {
  withScratchDir((dir) => {
    // extension
    const extThemeDir = path.join(dir, 'theme-ext');
    writeFixtureFontTheme(extThemeDir, { fonts: { 'a.bin': 'x' } });
    const siteDir = path.join(dir, 'site');
    const packToml = presentPackToml(siteDir, [], 'fixture');
    assert.throws(
      () =>
        planThemeAssets({
          vaultPath: path.join(dir, 'vault'),
          jsonConfig: { vaultPath: path.join(dir, 'vault'), excludeDirs: [] },
          siteDir,
          packToml,
          campaign: 'alpha',
          registry: fixtureRegistry(extThemeDir),
        }),
      (err) => {
        assert.ok(err.message.includes('is not an allowed font type (woff2, woff, ttf, otf)'));
        return true;
      },
    );

    // symlink
    const linkThemeDir = path.join(dir, 'theme-link');
    writeFixtureFontTheme(linkThemeDir, { fonts: { 'real.ttf': 'real' } });
    try {
      fs.symlinkSync(path.join(linkThemeDir, 'fonts', 'real.ttf'), path.join(linkThemeDir, 'fonts', 'link.ttf'));
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlink creation not permitted in this sandbox');
        return;
      }
      throw err;
    }
    assert.throws(
      () =>
        planThemeAssets({
          vaultPath: path.join(dir, 'vault'),
          jsonConfig: { vaultPath: path.join(dir, 'vault'), excludeDirs: [] },
          siteDir,
          packToml,
          campaign: 'alpha',
          registry: fixtureRegistry(linkThemeDir),
        }),
      (err) => {
        assert.ok(err.message.includes("symlinks are not allowed in a theme's fonts/"));
        return true;
      },
    );
  });
});
