'use strict';

/*
 * Keeps the documentation pictures, the SHOTS list and the user pages in step:
 * every image on a user page has alt text and lives under docs/images, the pictures in
 * docs/images/how-to are exactly the ones the pages show and the harness lists, and no
 * screenshot marker is left behind. T-I7 (test/public-guard.test.js) ties the same pictures
 * to their residual rows and PROVENANCE.md.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { userDocFiles } = require('./helpers/doc-criteria');
const { SHOTS } = require('../scripts/docs-screenshots');

const ROOT = path.join(__dirname, '..');
const IMAGES_ROOT = ['docs', 'images'];
const HOWTO_IMAGES = ['docs', 'images', 'how-to'];

/** Every `![alt](target)` in the text, as `{ alt, target }`. */
function imagesIn(text) {
  return [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ alt: m[1], target: m[2] }));
}

/** True when `target`, resolved from the page, lies under `rootSegments`. Compared by segment. */
function underRoot(pageRel, target, rootSegments) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), target));
  const segments = resolved.split('/');
  if (segments.length <= rootSegments.length) return false;
  return rootSegments.every((seg, i) => segments[i] === seg);
}

function resolved(pageRel, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(pageRel), target));
}

function howToPngs(root) {
  return fs.readdirSync(path.join(root, ...HOWTO_IMAGES)).filter((n) => path.extname(n) === '.png').sort();
}

test('controls: an empty alt is caught, a sibling folder is not under docs/images', () => {
  assert.deepEqual(imagesIn('![](a.png) and ![ok](b.png)').map((i) => i.alt), ['', 'ok']);
  assert.equal(underRoot('docs/how-to/x.md', '../images-x/a.png', IMAGES_ROOT), false);
  assert.equal(underRoot('docs/how-to/x.md', '../images/how-to/a.png', IMAGES_ROOT), true);
  assert.equal(underRoot('docs/how-to/x.md', '../images', IMAGES_ROOT), false);
  assert.equal(underRoot('docs/x.md', 'images/how-to/a.png', IMAGES_ROOT), true);
});

test('every image on a user page has alt text and lies under docs/images', () => {
  for (const page of userDocFiles(ROOT)) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const { alt, target } of imagesIn(text)) {
      assert.notEqual(alt.trim(), '', `${page}: image ${target} has no alt text`);
      assert.ok(underRoot(page, target, IMAGES_ROOT), `${page}: ${target} is not under docs/images`);
    }
  }
});

test('the PNGs, the SHOTS list and the images on user pages are the same set', () => {
  const onDisk = howToPngs(ROOT);
  const listed = SHOTS.map((s) => s.file).sort();
  assert.deepEqual(onDisk.map((n) => `how-to/${n}`), listed);

  const shown = new Set();
  for (const page of userDocFiles(ROOT)) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const { target } of imagesIn(text)) {
      if (!underRoot(page, target, HOWTO_IMAGES)) continue;
      shown.add(resolved(page, target).split('/').slice(HOWTO_IMAGES.length).join('/'));
    }
  }
  assert.deepEqual([...shown].sort(), onDisk);
});

test('no user page keeps a screenshot marker', () => {
  for (const page of userDocFiles(ROOT)) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.equal(text.split('<!-- screenshot:').length - 1, 0, `${page} still has a screenshot marker`);
  }
});

test('control: an unreferenced PNG would make the sets differ', () => {
  const onDisk = howToPngs(ROOT).concat(['unreferenced.png']).sort();
  const listed = SHOTS.map((s) => path.posix.basename(s.file)).sort();
  assert.notDeepEqual(onDisk, listed);
});
