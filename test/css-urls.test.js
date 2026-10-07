'use strict';

// A CSS url() resolver, used by test/example-build.test.js (E6) to prove every url() in a built
// site resolves. This file is its own control suite (S5 Engineering Brief, "The URL helper").
// test/css-urls.js is a helper, not a test: it is named *.js, not *.test.js, so npm test's
// test/**/*.test.js glob never runs it directly (precedent: test/fm-harness.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cssUrls, classifyUrl, unresolvedCssUrls } = require('./css-urls');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-css-urls-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- cssUrls: extraction -----------------------------------------------------------------------

test('cssUrls: a single unquoted url()', () => {
  assert.deepEqual(cssUrls('.a { background: url(foo.png); }'), ['foo.png']);
});

test('cssUrls: a single quoted url(), quotes removed', () => {
  assert.deepEqual(cssUrls('.a { background: url("foo.png"); }'), ['foo.png']);
  assert.deepEqual(cssUrls(".a { background: url('foo.png'); }"), ['foo.png']);
});

test('cssUrls: multiple url() calls, returned in source order', () => {
  const css = '.a { background: url(a.png); } .b { background: url(b.png); }';
  assert.deepEqual(cssUrls(css), ['a.png', 'b.png']);
});

test('cssUrls: /*...*/ comments are stripped first, so a commented-out url() is never returned', () => {
  const css = '/* url(missing.png) */ .a { background: url(real.png); }';
  assert.deepEqual(cssUrls(css), ['real.png']);
});

test('cssUrls: a quoted data: URI containing a literal "url(...)" substring is returned whole', () => {
  // Shape of assets/site/scriptorium.css:792 -- a data: URI whose own content embeds
  // "url(%23n)". A naive non-greedy url\(([^)]*)\) extraction splits this into two entries;
  // the correct extraction treats the quoted string as one unit and returns it whole (U5).
  const css = '.a { --sc-grain: url("data:image/svg+xml,%3Csvg%3E%3Crect filter=\'url(%23n)\'/%3E%3C/svg%3E"); }';
  const urls = cssUrls(css);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('data:'));
  assert.ok(urls[0].includes('url(%23n)'));
});

test('cssUrls: a real product file (assets/site/scriptorium.css) extracts exactly one url(), not two', () => {
  // Independent, literal expected value (CLAUDE.md testing standards): grep -oiE 'url\(' on this
  // file finds two literal occurrences of the text "url(" (the outer one, and the inner
  // "url(%23n)" inside its own data: URI payload). The correct resolver returns ONE entry.
  const cssPath = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
  const text = fs.readFileSync(cssPath, 'utf8');
  const urls = cssUrls(text);
  assert.equal(urls.length, 1);
  assert.equal(classifyUrl(urls[0]), 'data');
});

// -- classifyUrl -------------------------------------------------------------------------------

test('classifyUrl: data: is matched with its colon', () => {
  assert.equal(classifyUrl('data:image/png;base64,abc'), 'data');
});

test('classifyUrl: http:, https: and // are absolute', () => {
  assert.equal(classifyUrl('http://example.invalid/a.png'), 'absolute');
  assert.equal(classifyUrl('https://example.invalid/a.png'), 'absolute');
  assert.equal(classifyUrl('//example.invalid/a.png'), 'absolute');
});

test('classifyUrl: a leading # is a fragment', () => {
  assert.equal(classifyUrl('#filter-id'), 'fragment');
});

test('classifyUrl: anything else is relative', () => {
  assert.equal(classifyUrl('images/a.png'), 'relative');
  assert.equal(classifyUrl('../images/a.png'), 'relative');
});

test('classifyUrl: a relative path starting with the letters "data" but no colon is not data:', () => {
  // U3: a string-prefix sibling (startsWith('data') instead of startsWith('data:')) would
  // misclassify this as a data: URI.
  assert.equal(classifyUrl('data-strip.svg'), 'relative');
});

// -- unresolvedCssUrls: real filesystem walks -----------------------------------------------

test('unresolvedCssUrls: a relative url() that resolves is not reported', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.mkdirSync(path.join(root, 'img'));
    fs.writeFileSync(path.join(root, 'img', 'x.png'), 'x');
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("../img/x.png"); }');
    assert.deepEqual(unresolvedCssUrls(root), []);
  });
});

test('unresolvedCssUrls: a missing relative target is reported with reason "missing"', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("missing.png"); }');
    const result = unresolvedCssUrls(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, 'missing');
    assert.equal(result[0].file, path.join('css', 'a.css'));
  });
});

test('unresolvedCssUrls: an absolute url() is reported with reason "absolute"', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("https://example.invalid/a.png"); }');
    const result = unresolvedCssUrls(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, 'absolute');
  });
});

test('unresolvedCssUrls: an @import is reported with reason "import"', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '@import url("other.css");\n.a { color: red; }');
    const result = unresolvedCssUrls(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, 'import');
  });
});

test('unresolvedCssUrls: a data: URI and a #fragment are never reported', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(
      path.join(root, 'css', 'a.css'),
      '.a { background: url("data:image/png;base64,abc"); } .b { filter: url(#f); }',
    );
    assert.deepEqual(unresolvedCssUrls(root), []);
  });
});

test('unresolvedCssUrls: query and fragment suffixes are stripped and percent-decoding is applied before resolving', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.mkdirSync(path.join(root, 'img dir'));
    fs.writeFileSync(path.join(root, 'img dir', 'x.png'), 'x');
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("../img%20dir/x.png?v=2#frag"); }');
    assert.deepEqual(unresolvedCssUrls(root), []);
  });
});

test('unresolvedCssUrls: resolution is relative to the CSS file\'s own directory, not the site root (U1)', () => {
  // css/a.css + url("../img/x.png"), with img/x.png present at the site root, resolves
  // correctly (one directory up from css/ lands at the site root). A resolver that instead
  // resolves relative URLs from the site root would compute "../img/x.png" from the root
  // itself, escaping it, and wrongly report "escapes-site" for a file that exists.
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.mkdirSync(path.join(root, 'img'));
    fs.writeFileSync(path.join(root, 'img', 'x.png'), 'x');
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("../img/x.png"); }');
    assert.deepEqual(unresolvedCssUrls(root), []);
  });
});

test('unresolvedCssUrls: a relative url() that escapes the site root is reported with reason "escapes-site"', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("../../outside.png"); }');
    const result = unresolvedCssUrls(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, 'escapes-site');
  });
});

test('unresolvedCssUrls: results are sorted by file, then url', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.mkdirSync(path.join(root, 'zcss'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("zm.png"), url("am.png"); }');
    fs.writeFileSync(path.join(root, 'zcss', 'b.css'), '.a { background: url("m.png"); }');
    const result = unresolvedCssUrls(root);
    assert.deepEqual(
      result.map((r) => [r.file, r.url]),
      [
        [path.join('css', 'a.css'), 'am.png'],
        [path.join('css', 'a.css'), 'zm.png'],
        [path.join('zcss', 'b.css'), 'm.png'],
      ],
    );
  });
});

// -- Mutation controls (U1-U5), each must go red against the corresponding bug ------------------
// Run manually against a mutated copy of css-urls.js per the Engineering Brief's mutation table;
// these tests are the oracle. No mutation is applied to the committed file.

test('U2 control: a missing relative target must be reported, never silently dropped', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '.a { background: url("gone.png"); }');
    const result = unresolvedCssUrls(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, 'missing');
  });
});

test('U4 control: a commented-out url() for a missing file is never reported', () => {
  withScratchDir((root) => {
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), '/* url(missing.png) */\n.a { color: red; }');
    assert.deepEqual(unresolvedCssUrls(root), []);
  });
});
