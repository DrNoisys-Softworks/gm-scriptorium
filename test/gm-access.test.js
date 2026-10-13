'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gmaccess = require('../src/build/gmaccess');
const { injectFooterLinks } = require('../src/build/notice');
const { findGmLinkMarker } = require('../src/build/gmmarker');

const { GM_ACCESS_MARKER, gmAccessHref, gmAccessSnippet, injectGmAccessLink } = gmaccess;

/*
 * The published GM link's writer. Expected strings are written out by hand. The visible markup
 * follows the approved mock (frame G1), and these tests pin it: one anchor reading Game master, exact rel, href shape, no script, no icon.
 */

const HREF_RE = /^https:\/\/[^/?#@]+\/(\?campaign=[a-z0-9][a-z0-9-]{0,62})?$/;

/**
 * A page exactly as the real notice pass leaves it at a given folder depth. Goes through the
 * exported injectFooterLinks (which calls notice.js's footerSnippet) so the markup is never
 * a copy of the one under test.
 */
function pageWithNotice(depth = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gma-notice-'));
  try {
    const folder = depth > 0 ? path.join(dir, ...Array.from({ length: depth }, (_, i) => `d${i}`)) : dir;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'p.html'), '<html><body><main>hi</main></body></html>');
    assert.equal(injectFooterLinks(dir), 1);
    return fs.readFileSync(path.join(folder, 'p.html'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gma-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('marker is the literal data-scriptorium-gm-access and never overlaps the preview marker', () => {
  assert.equal(GM_ACCESS_MARKER, 'data-scriptorium-gm-access');
  assert.ok(!GM_ACCESS_MARKER.includes('data-scriptorium-gm-link'));
  assert.ok(!'data-scriptorium-gm-link'.includes(GM_ACCESS_MARKER));
});

test('gmAccessHref: origin root plus the campaign hint', () => {
  assert.equal(gmAccessHref('https://gm.example.net', 'alpha'), 'https://gm.example.net/?campaign=alpha');
  assert.equal(gmAccessHref('https://gm.example.net:8443', 'the-long-lease'), 'https://gm.example.net:8443/?campaign=the-long-lease');
});

test('gmAccessHref: the hint is omitted when the name fails the campaign-name rule', () => {
  for (const bad of ['Alpha', 'a b', 'a&x=1', '-a', '', 'a/b', '../a', 'x'.repeat(64), null, undefined, 5]) {
    assert.equal(gmAccessHref('https://gm.example.net', bad), 'https://gm.example.net/', `campaign ${JSON.stringify(bad)}`);
  }
  assert.equal(gmAccessHref('https://gm.example.net', 'x'.repeat(63)), `https://gm.example.net/?campaign=${'x'.repeat(63)}`);
});

test('gmAccessHref: re-validates the origin and throws on anything the validator refuses', () => {
  for (const bad of ['http://gm.example.net', 'https://127.0.0.1', 'https://u:p@gm.example.net', 'https://gm.example.net/x', 'nope', '', null, 'https://a&b.example.net']) {
    assert.throws(() => gmAccessHref(bad, 'alpha'), (e) => e.name === 'ScriptoriumError' || /Scriptorium/.test(e.constructor.name), `origin ${JSON.stringify(bad)}`);
  }
});

test('markup contract: one anchor, exact rel, marker, href shape, nothing else active', () => {
  const href = gmAccessHref('https://gm.example.net', 'alpha');
  const html = gmAccessSnippet(href);
  assert.equal((html.match(/<a\b/g) || []).length, 1);
  assert.ok(html.includes(` ${GM_ACCESS_MARKER} `) || html.includes(` ${GM_ACCESS_MARKER}>`));
  assert.ok(html.includes('rel="noopener noreferrer nofollow"'));
  const m = html.match(/href="([^"]*)"/);
  assert.ok(m && HREF_RE.test(m[1]), `href ${m && m[1]}`);
  assert.ok(!/<script/i.test(html), 'no script');
  assert.ok(!/\btarget\s*=/i.test(html), 'no target');
  assert.ok(!/src\s*=/i.test(html), 'no src');
  assert.ok(!/url\(/i.test(html), 'no url(');
  assert.ok(!/\bon[a-z]+\s*=/i.test(html), 'no event handler');
  assert.ok(!/style\s*=/i.test(html), 'no inline style');
  assert.equal((html.match(/https?:\/\//g) || []).length, 1, 'no address other than the href');
  assert.ok(html.endsWith('>Game master</a>'), 'the link reads Game master');
  assert.ok(!/<svg/i.test(html), 'no icon');
  assert.ok(!/aria-label/i.test(html), 'the visible text names the link');
});

test('injectGmAccessLink: one link per page, inline after "Third-party notices", at every depth', () => {
  withTree((dir) => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), pageWithNotice(0));
    fs.writeFileSync(path.join(dir, 'a', 'b', 'page.html'), pageWithNotice(2));
    fs.writeFileSync(path.join(dir, 'data.json'), '{"x":1}');

    const result = injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
    assert.deepEqual(result, { pagesLinked: 2, pagesSkipped: 0 });

    for (const rel of ['index.html', path.join('a', 'b', 'page.html')]) {
      const html = fs.readFileSync(path.join(dir, rel), 'utf8');
      assert.equal(html.split(GM_ACCESS_MARKER).length - 1, 1, rel);
      const para = html.match(/<p class="scriptorium-notice-link">([\s\S]*?)<\/p>/)[1];
      assert.match(para, /^<a href="[^"]*NOTICE\.txt">Third-party notices<\/a>/, 'the notice link is first and intact');
      assert.ok(para.includes(GM_ACCESS_MARKER), 'the GM link sits in the same paragraph');
      assert.equal((para.match(/<a\b/g) || []).length, 2, 'two sibling anchors, never nested');
      assert.ok(html.includes('href="https://gm.example.net/?campaign=alpha"'));
    }
    assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), '{"x":1}');
  });
});

test('injectGmAccessLink: idempotent, the second run links nothing', () => {
  withTree((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), pageWithNotice(0));
    injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
    const once = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const second = injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
    assert.equal(second.pagesLinked, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), once);
  });
});

test('injectGmAccessLink: a page with no notice paragraph or no </body> is skipped and counted', () => {
  withTree((dir) => {
    fs.writeFileSync(path.join(dir, 'a.html'), '<html><body>no notice</body></html>');
    fs.writeFileSync(path.join(dir, 'b.html'), '<html><meta http-equiv="refresh" content="0;url=a.html"></html>');
    fs.writeFileSync(path.join(dir, 'c.html'), '<html><body><p class="scriptorium-notice-link">no anchor</p></body></html>');
    const before = ['a.html', 'b.html', 'c.html'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const result = injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
    assert.deepEqual(result, { pagesLinked: 0, pagesSkipped: 3 });
    assert.deepEqual(['a.html', 'b.html', 'c.html'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before);
  });
});

test('injectGmAccessLink: symlinks are never followed or written, in either direction', () => {
  withTree((dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gma-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'target.html'), pageWithNotice(0));
      fs.mkdirSync(path.join(outside, 'sub'));
      fs.writeFileSync(path.join(outside, 'sub', 'deep.html'), pageWithNotice(0));
      fs.writeFileSync(path.join(dir, 'real.html'), pageWithNotice(0));
      fs.symlinkSync(path.join(outside, 'target.html'), path.join(dir, 'file-link.html'));
      fs.symlinkSync(path.join(outside, 'sub'), path.join(dir, 'dir-link'));

      const result = injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
      assert.equal(result.pagesLinked, 1);
      assert.ok(!fs.readFileSync(path.join(outside, 'target.html'), 'utf8').includes(GM_ACCESS_MARKER));
      assert.ok(!fs.readFileSync(path.join(outside, 'sub', 'deep.html'), 'utf8').includes(GM_ACCESS_MARKER));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('injectGmAccessLink: gmLink null or undefined links nothing and returns { pagesLinked: 0 }', () => {
  withTree((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), pageWithNotice(0));
    const before = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.deepEqual(injectGmAccessLink(dir, null, 'alpha'), { pagesLinked: 0 });
    assert.deepEqual(injectGmAccessLink(dir, undefined, 'alpha'), { pagesLinked: 0 });
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), before);
  });
});

test('anchor parity: the pass anchors on the exact notice markup the notice pass (footerSnippet(0)) emits', () => {
  const notice = pageWithNotice(0);
  assert.ok(notice.includes(gmaccess.NOTICE_PARAGRAPH_OPEN), 'paragraph opener drifted from notice.js');
  const afterOpen = notice.slice(notice.indexOf(gmaccess.NOTICE_PARAGRAPH_OPEN) + gmaccess.NOTICE_PARAGRAPH_OPEN.length);
  assert.ok(afterOpen.includes(gmaccess.NOTICE_ANCHOR_CLOSE), 'anchor closer drifted from notice.js');
  assert.ok(afterOpen.startsWith('<a '), 'the first thing in the paragraph is the notice anchor');
});

test('a page the pass links is invisible to the preview marker scan', () => {
  withTree((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), pageWithNotice(0));
    injectGmAccessLink(dir, { url: 'https://gm.example.net' }, 'alpha');
    assert.deepEqual(findGmLinkMarker(dir), []);
  });
});
