'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  EMBEDDED_HOUSE_STYLE_PATH,
  HOUSE_STYLE_FILENAME,
  MARKER_ATTR,
  writeHouseStyle,
  injectHouseStyleLinks,
} = require('../src/build/housestyle');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-housestyle-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// A base.js-shaped page (lib/templates/base.js:56-102): style.css -> [genre] -> theme.css ->
// [overrides], all relative, depth-many '../' prefixes.
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

// A four-oh-four.js-shaped page (lib/templates/four-oh-four.js:29-93): absolute basePath
// hrefs, style.css -> theme.css -> [genre] -> [overrides], then a page-local <style> block.
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

// -- 1. anchored on overrides.css: relative href at depth, absolute href on a 404-shaped page --

test('injectHouseStyleLinks: base.js page at depth 0 with overrides.css gets a relative link before it', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: true }));
    const linked = injectHouseStyleLinks(dir);
    assert.equal(linked, 1);

    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const ourIdx = html.indexOf(MARKER_ATTR);
    const overridesIdx = html.indexOf('css/overrides.css');
    const themeIdx = html.indexOf('css/theme.css');
    assert.notEqual(ourIdx, -1);
    assert.ok(themeIdx < ourIdx, 'our link must come after theme.css');
    assert.ok(ourIdx < overridesIdx, 'our link must come before overrides.css');
    assert.match(html, /<link rel="stylesheet" href="css\/scriptorium\.css" data-scriptorium-housestyle>/);
  });
});

test('injectHouseStyleLinks: base.js page nested two deep with overrides.css derives the same relative depth', () => {
  withTmpDir((dir) => {
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'page.html'), basePage({ depth: 2, overridesCss: true }));
    injectHouseStyleLinks(dir);

    const html = fs.readFileSync(path.join(nested, 'page.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/css\/scriptorium\.css" data-scriptorium-housestyle>/);
  });
});

test('injectHouseStyleLinks: 404-shaped page with overrides.css gets the correct ABSOLUTE href, no depth arithmetic', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: true }));
    injectHouseStyleLinks(dir);

    const html = fs.readFileSync(path.join(dir, '404.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/css\/scriptorium\.css" data-scriptorium-housestyle>/);

    const ourIdx = html.indexOf(MARKER_ATTR);
    const overridesIdx = html.indexOf('/css/overrides.css');
    const styleBlockIdx = html.indexOf('<style>');
    assert.ok(ourIdx < overridesIdx, 'our link must come before overrides.css');
    assert.ok(ourIdx < styleBlockIdx, 'our link must still come before the page-local <style> block');
  });
});

// -- 2. SD-3 fallback: no overrides.css anywhere on the page (AC-21) --

test('injectHouseStyleLinks: base.js page with no overrides.css still gets the link, before </head>', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: false }));
    const linked = injectHouseStyleLinks(dir);
    assert.equal(linked, 1);

    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="css\/scriptorium\.css" data-scriptorium-housestyle>/);
    const themeIdx = html.indexOf('css/theme.css');
    const ourIdx = html.indexOf(MARKER_ATTR);
    const headCloseIdx = html.indexOf('</head>');
    assert.ok(themeIdx < ourIdx, 'our link must come after theme.css');
    assert.ok(ourIdx < headCloseIdx, 'our link must land inside <head>');
  });
});

test('injectHouseStyleLinks: 404-shaped page with no overrides.css lands after theme, before the page-local <style>', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: false }));
    injectHouseStyleLinks(dir);

    const html = fs.readFileSync(path.join(dir, '404.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/css\/scriptorium\.css" data-scriptorium-housestyle>/);

    const themeIdx = html.indexOf('/css/theme.css');
    const ourIdx = html.indexOf(MARKER_ATTR);
    const styleBlockIdx = html.indexOf('<style>');
    assert.ok(themeIdx < ourIdx, 'our link must come after theme.css');
    assert.ok(
      ourIdx < styleBlockIdx,
      'the fallback must not outrank the page-local <style> block (four-oh-four.js:19-20)',
    );
  });
});

// -- 3. idempotency (AC-18) --

test('injectHouseStyleLinks is idempotent: a second run links 0 pages, one marker per page', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: true }));
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage({ basePath: '/', overridesCss: false }));

    const first = injectHouseStyleLinks(dir);
    assert.equal(first, 2);

    const second = injectHouseStyleLinks(dir);
    assert.equal(second, 0);

    for (const name of ['index.html', '404.html']) {
      const html = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.equal((html.match(new RegExp(MARKER_ATTR, 'g')) || []).length, 1, `${name} must carry exactly one marker`);
    }
  });
});

test('injectHouseStyleLinks skips a page that already carries the marker even if the marker text is elsewhere', () => {
  withTmpDir((dir) => {
    // A page that already mentions the marker attribute in, say, a hand-authored comment must
    // not be treated as unlinked (SD-4: guard on the marker, not the href).
    const html = `<!DOCTYPE html><html><head><!-- ${MARKER_ATTR} mentioned in prose --><link rel="stylesheet" href="css/theme.css"></head><body></body></html>`;
    fs.writeFileSync(path.join(dir, 'weird.html'), html);
    const linked = injectHouseStyleLinks(dir);
    assert.equal(linked, 0);
  });
});

// -- 4. non-HTML files and files with no recognised stylesheet links are left alone --

test('injectHouseStyleLinks ignores non-.html files and pages with no stylesheet link to anchor on', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'not html');
    fs.writeFileSync(path.join(dir, 'bare.html'), '<html><head></head><body>no stylesheet links at all</body></html>');
    const linked = injectHouseStyleLinks(dir);
    assert.equal(linked, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'NOTICE.txt'), 'utf8'), 'not html');
  });
});

// -- 5. writeHouseStyle: writes the embedded asset byte-identical, links pages, creates css/ --

test('writeHouseStyle writes css/scriptorium.css byte-identical to the embedded asset and links pages', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ depth: 0, overridesCss: false }));
    const result = writeHouseStyle(dir);

    assert.equal(result.written, true);
    assert.equal(result.pagesLinked, 1);

    const writtenPath = path.join(dir, 'css', HOUSE_STYLE_FILENAME);
    assert.ok(fs.existsSync(writtenPath));
    assert.equal(sha256(writtenPath), sha256(EMBEDDED_HOUSE_STYLE_PATH));
  });
});

test('writeHouseStyle creates css/ if the staging tree somehow lacks it', () => {
  withTmpDir((dir) => {
    // Defensive: in a real build css/ always exists by this point (the pin's own copyCSS runs
    // first), but the write must not assume it.
    const result = writeHouseStyle(dir);
    assert.equal(result.written, true);
    assert.ok(fs.existsSync(path.join(dir, 'css', HOUSE_STYLE_FILENAME)));
  });
});

// -- 6. real end-to-end build (SD-5 wiring): run.js actually calls this in the right place --

test('runAtomicBuild (real pinned generator build): every page gets the link, css/scriptorium.css is byte-identical, houseStyle is in the return', () => {
  const { runAtomicBuild } = require('../src/build/run');
  const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
  const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-housestyle-build-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT };
    const finalOut = path.join(scratch, 'out');

    // This fixture vault deliberately carries withheld-name leaks (see
    // test/publish-equivalence.test.js's identical comment); force: true is the loud,
    // greppable statement that this build is expected to be leaky. This test is about the
    // house-style pass, not the leak scan.
    const result = runAtomicBuild({
      vaultPath: PIN_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'housestyle-e2e',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));

    assert.equal(result.houseStyle.written, true);
    assert.ok(result.houseStyle.pagesLinked > 0);

    const shippedCss = path.join(finalOut, 'css', HOUSE_STYLE_FILENAME);
    assert.ok(fs.existsSync(shippedCss));
    assert.equal(sha256(shippedCss), sha256(EMBEDDED_HOUSE_STYLE_PATH), 'shipped css/scriptorium.css must be byte-identical to the embedded asset');

    // Every produced .html page must carry the marker exactly once (this fixture's site
    // config has no css/overrides.css, so every page exercises SD-3's fallback for real).
    const htmlFiles = [];
    (function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html')) htmlFiles.push(full);
      }
    })(finalOut);
    assert.ok(htmlFiles.length > 0);
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      assert.equal((html.match(new RegExp(MARKER_ATTR, 'g')) || []).length, 1, `${file} must carry exactly one marker`);
    }

    // AC-17 (source half): on the real generated 404.html, after the pin's sheets, before
    // where overrides.css would have gone (fallback: before the page-local <style>).
    const four04 = fs.readFileSync(path.join(finalOut, '404.html'), 'utf8');
    const themeIdx = four04.indexOf('theme.css');
    const ourIdx = four04.indexOf(MARKER_ATTR);
    const styleBlockIdx = four04.indexOf('<style>');
    assert.ok(themeIdx !== -1 && ourIdx !== -1 && styleBlockIdx !== -1);
    assert.ok(themeIdx < ourIdx && ourIdx < styleBlockIdx);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
