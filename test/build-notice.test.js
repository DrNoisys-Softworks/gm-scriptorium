'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSiteNotice, buildNoticeText, injectFooterLinks } = require('../src/build/notice');

test('buildNoticeText includes lunr only when search is enabled', () => {
  const withSearch = buildNoticeText({ searchEnabled: true });
  const withoutSearch = buildNoticeText({ searchEnabled: false });
  assert.match(withSearch, /lunr\.js/);
  assert.match(withSearch, /Oliver Nightingale/);
  assert.doesNotMatch(withoutSearch, /lunr\.js/);
});

test('buildNoticeText always includes the generator CSS/JS notice', () => {
  const text = buildNoticeText({ searchEnabled: false });
  assert.match(text, /AntTheLimey/);
  assert.match(text, /Permission is hereby granted/);
});

test('injectFooterLinks links every page at the correct relative depth, idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notice-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'page.html'), '<html><body>nested</body></html>');
    fs.writeFileSync(path.join(dir, 'not-html.txt'), 'ignore me');

    const first = injectFooterLinks(dir);
    assert.equal(first, 2);

    const root = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(root, /href="NOTICE\.txt"/);
    assert.doesNotMatch(root, /style=/);
    assert.match(root, /<div class="content scriptorium-notice">/);
    const nested = fs.readFileSync(path.join(dir, 'a', 'b', 'page.html'), 'utf8');
    assert.match(nested, /href="\.\.\/\.\.\/NOTICE\.txt"/);
    assert.doesNotMatch(nested, /style=/);

    // idempotent: a second pass must not double-inject
    const second = injectFooterLinks(dir);
    assert.equal(second, 0);
    const rootAfter = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal((rootAfter.match(/scriptorium-notice-link/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSiteNotice writes NOTICE.txt and links every page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notice-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>');
    const result = writeSiteNotice(dir, { searchEnabled: true });
    assert.equal(result.noticeWritten, true);
    assert.equal(result.pagesLinked, 1);
    assert.ok(fs.existsSync(path.join(dir, 'NOTICE.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-05 (S3, SD-6): the NOTICE credit line points at the public repository
// ---------------------------------------------------------------------------

test('S3/SD-6: buildNoticeText() credits GM-Scriptorium and the public repository, on the same line', () => {
  const text = buildNoticeText({ searchEnabled: false });
  const firstLine = text.split('\n')[0];
  assert.equal(
    firstLine,
    'This site was built with GM-Scriptorium (https://github.com/DrNoisys-Softworks/gm-scriptorium),',
  );
});

// ---------------------------------------------------------------------------
// AC-03 / SD-4 (S3): the frozen notices-file header is still what discardNoticesBesideExecutable
// recognises, even after the public rename. This is the cross-version contract: a future
// binary's `update` must still be able to clear a notices file written by an older one.
// ---------------------------------------------------------------------------

test('S3/SD-4: a freshly generated THIRD-PARTY-NOTICES.txt is still recognised and discarded beside the executable', (t) => {
  const { buildNoticesText } = require('../scripts/generate-notices');
  const { NOTICES_FILENAME } = require('../src/util/notices');
  const { discardNoticesBesideExecutable } = require('../src/update/replace');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notice-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, NOTICES_FILENAME), buildNoticesText());

  assert.equal(discardNoticesBesideExecutable(dir), true, 'the frozen header must still be recognised as ours');
  assert.equal(fs.existsSync(path.join(dir, NOTICES_FILENAME)), false);
});
