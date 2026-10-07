'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  THEME_STYLE_FILENAME,
  THEME_MARKER_ATTR,
  composeThemeCss,
  linkThemeStyle,
  injectThemeStyleLinks,
  writeThemeStyle,
} = require('../src/build/themestyle');
const { findLinkTag, deriveHref, MARKER_ATTR: HOUSESTYLE_MARKER_ATTR, injectHouseStyleLinks } = require('../src/build/housestyle');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-style-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fixtures reproduced from test/build-housestyle.test.js (a base.js-shaped page and a
// four-oh-four.js-shaped page), since S2/S7 exercise the theme pass running AFTER the real
// housestyle pass on these same page shapes.
function basePage({ depth, overridesCss }) {
  const prefix = '../'.repeat(depth);
  const overridesTag = overridesCss ? `\n  <link rel="stylesheet" href="${prefix}css/overrides.css">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${prefix}css/style.css">
  <link rel="stylesheet" href="${prefix}css/theme.css">${overridesTag}
</head>
<body>
<main class="content">hi</main>
</body>
</html>`;
}

function fourOhFourPage({ basePath, overridesCss }) {
  const href = (p) => `${basePath}${p}`;
  const overridesTag = overridesCss ? `\n  <link rel="stylesheet" href="${href('css/overrides.css')}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${href('css/style.css')}">
  <link rel="stylesheet" href="${href('css/theme.css')}">${overridesTag}
  <style>
    .four-oh-four-hero { text-align: center; }
  </style>
</head>
<body>
<main class="content">not found</main>
</body>
</html>`;
}

// --- S1: findLinkTag/deriveHref exported from housestyle.js -------------

test('S1: findLinkTag and deriveHref are exported, and deriveHref gives the documented results', () => {
  assert.equal(typeof findLinkTag, 'function');
  assert.equal(typeof deriveHref, 'function');
  assert.equal(deriveHref('css/overrides.css'), 'css/scriptorium.css');
  assert.equal(deriveHref('../../css/theme.css'), '../../css/scriptorium.css');
  assert.equal(deriveHref('/css/overrides.css', 'scriptorium-theme.css'), '/css/scriptorium-theme.css');
});

// --- S2/S7: exact hand-written HTML, after the real housestyle pass -----

test('S2/S7: base page at depth 0, after housestyle: housestyle, then theme, then overrides.css', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: true }));
    injectHouseStyleLinks(dir);
    const afterHousestyle = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

    const expectedAfterHousestyle = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="css/style.css">
  <link rel="stylesheet" href="css/theme.css">
  <link rel="stylesheet" href="css/scriptorium.css" data-scriptorium-housestyle>
  <link rel="stylesheet" href="css/overrides.css">
</head>
<body>
<main class="content">hi</main>
</body>
</html>`;
    assert.equal(afterHousestyle, expectedAfterHousestyle);

    const patched = linkThemeStyle(afterHousestyle);
    const expected = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="css/style.css">
  <link rel="stylesheet" href="css/theme.css">
  <link rel="stylesheet" href="css/scriptorium.css" data-scriptorium-housestyle>
  <link rel="stylesheet" href="css/scriptorium-theme.css" data-scriptorium-theme>
  <link rel="stylesheet" href="css/overrides.css">
</head>
<body>
<main class="content">hi</main>
</body>
</html>`;
    assert.equal(patched, expected);
  });
});

test('S2/S7: base page nested two deep, after housestyle', () => {
  withTmpDir((dir) => {
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'page.html'), basePage({ depth: 2, overridesCss: true }));
    injectHouseStyleLinks(dir);
    const afterHousestyle = fs.readFileSync(path.join(nested, 'page.html'), 'utf8');

    const patched = linkThemeStyle(afterHousestyle);
    const expected = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="../../css/style.css">
  <link rel="stylesheet" href="../../css/theme.css">
  <link rel="stylesheet" href="../../css/scriptorium.css" data-scriptorium-housestyle>
  <link rel="stylesheet" href="../../css/scriptorium-theme.css" data-scriptorium-theme>
  <link rel="stylesheet" href="../../css/overrides.css">
</head>
<body>
<main class="content">hi</main>
</body>
</html>`;
    assert.equal(patched, expected);
  });
});

test('S2/S7: 404-shaped page with overrides.css, after housestyle', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: true }));
    injectHouseStyleLinks(dir);
    const afterHousestyle = fs.readFileSync(path.join(dir, '404.html'), 'utf8');

    const patched = linkThemeStyle(afterHousestyle);
    const expected = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/theme.css">
  <link rel="stylesheet" href="/css/scriptorium.css" data-scriptorium-housestyle>
  <link rel="stylesheet" href="/css/scriptorium-theme.css" data-scriptorium-theme>
  <link rel="stylesheet" href="/css/overrides.css">
  <style>
    .four-oh-four-hero { text-align: center; }
  </style>
</head>
<body>
<main class="content">not found</main>
</body>
</html>`;
    assert.equal(patched, expected);
  });
});

test('S2/S7: 404-shaped page without overrides.css, after housestyle: theme link lands before <style>', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: false }));
    injectHouseStyleLinks(dir);
    const afterHousestyle = fs.readFileSync(path.join(dir, '404.html'), 'utf8');

    const patched = linkThemeStyle(afterHousestyle);
    const expected = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/theme.css">
  <link rel="stylesheet" href="/css/scriptorium.css" data-scriptorium-housestyle>
  <link rel="stylesheet" href="/css/scriptorium-theme.css" data-scriptorium-theme>
  <style>
    .four-oh-four-hero { text-align: center; }
  </style>
</head>
<body>
<main class="content">not found</main>
</body>
</html>`;
    assert.equal(patched, expected);
  });
});

// --- S3: idempotency -------------------------------------------------------

test('S3: a second pass links 0 pages, and each page carries exactly one marker', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: true }));
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: false }));
    injectHouseStyleLinks(dir);

    const first = injectThemeStyleLinks(dir);
    assert.equal(first, 2);
    const second = injectThemeStyleLinks(dir);
    assert.equal(second, 0);

    for (const name of ['index.html', '404.html']) {
      const html = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.equal((html.match(new RegExp(THEME_MARKER_ATTR, 'g')) || []).length, 1, `${name} must carry exactly one marker`);
    }
  });
});

// --- S4: null cases ----------------------------------------------------------

test('S4: no housestyle tag gives null; a page with the marker in prose gives null', () => {
  assert.equal(linkThemeStyle('<html><head><link rel="stylesheet" href="css/overrides.css"></head><body></body></html>'), null);

  const withMarkerInProse = `<!DOCTYPE html><html><head><!-- ${THEME_MARKER_ATTR} mentioned in prose --><link rel="stylesheet" href="css/scriptorium.css" ${HOUSESTYLE_MARKER_ATTR}></head><body></body></html>`;
  assert.equal(linkThemeStyle(withMarkerInProse), null);
});

// --- S5: composeThemeCss -----------------------------------------------------

test('S5: composeThemeCss', () => {
  assert.equal(composeThemeCss(null, []), null);
  assert.equal(
    composeThemeCss(null, [{ slot: 'ground', href: '../scriptorium/slots/ground.webp' }]),
    ':root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n',
  );
  assert.equal(
    composeThemeCss('@import url("x");\nbody{}', [{ slot: 'hero', href: '../scriptorium/slots/hero.png' }]),
    '@import url("x");\nbody{}\n\n:root {\n  --sc-img-hero: url("../scriptorium/slots/hero.png");\n}\n',
  );
});

// --- S6: writeThemeStyle(root, null) touches nothing -------------------------

test('S6: writeThemeStyle(root, null) creates no css/ directory', () => {
  withTmpDir((dir) => {
    const result = writeThemeStyle(dir, null);
    assert.deepEqual(result, { written: false, pagesLinked: 0 });
    assert.equal(fs.existsSync(path.join(dir, 'css')), false);
  });
});

test('THEME_STYLE_FILENAME is scriptorium-theme.css', () => {
  assert.equal(THEME_STYLE_FILENAME, 'scriptorium-theme.css');
  assert.equal(THEME_MARKER_ATTR, 'data-scriptorium-theme');
});
