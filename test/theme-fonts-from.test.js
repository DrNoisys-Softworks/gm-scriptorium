'use strict';

// Issue #84 follow-up: theme.json `fontsFrom` shares another theme's fonts/ and NOTICE.txt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTheme } = require('../src/build/themes');

function mk(root, name, json, { fonts, notice } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name, scheme: 'dark', slots: [], ...json }));
  fs.writeFileSync(path.join(dir, 'theme.css'), 'body { color: red; }\n');
  if (fonts) {
    fs.mkdirSync(path.join(dir, 'fonts'));
    for (const [k, v] of Object.entries(fonts)) fs.writeFileSync(path.join(dir, 'fonts', k), v);
  }
  if (notice) fs.writeFileSync(path.join(dir, 'NOTICE.txt'), notice);
  return dir;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fonts-from-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('fontsFrom: the sharing theme gets the source theme fonts and notice', (t) => {
  const root = fixture(t);
  const src = mk(root, 'src', {}, { fonts: { 'a.woff2': 'x' }, notice: 'OFL text\n' });
  const user = mk(root, 'user', { fontsFrom: 'src' });
  const reg = { src: { name: 'src', dir: src }, user: { name: 'user', dir: user } };
  const t1 = loadTheme('user', reg);
  assert.deepEqual(t1.fonts, [{ rel: 'a.woff2', abs: path.join(src, 'fonts', 'a.woff2') }]);
  assert.equal(t1.notice, 'OFL text\n');
});

test('fontsFrom: rejects unknown, self, plain, chained, and a theme that also owns fonts/NOTICE', (t) => {
  const root = fixture(t);
  const src = mk(root, 'src', {}, { fonts: { 'a.woff2': 'x' }, notice: 'n' });
  const chain = mk(root, 'chain', { fontsFrom: 'src' });
  const unknown = mk(root, 'unknown', { fontsFrom: 'nope' });
  const self = mk(root, 'self', { fontsFrom: 'self' });
  const bad = mk(root, 'bad', { fontsFrom: 7 });
  const onPlain = mk(root, 'onplain', { fontsFrom: 'plain' });
  const both = mk(root, 'both', { fontsFrom: 'src' }, { fonts: { 'b.woff2': 'y' } });
  const second = mk(root, 'second', { fontsFrom: 'chain' });
  const reg = {
    src: { name: 'src', dir: src },
    chain: { name: 'chain', dir: chain },
    unknown: { name: 'unknown', dir: unknown },
    self: { name: 'self', dir: self },
    bad: { name: 'bad', dir: bad },
    onplain: { name: 'onplain', dir: onPlain },
    plain: { name: 'plain', dir: null },
    both: { name: 'both', dir: both },
    second: { name: 'second', dir: second },
  };
  assert.throws(() => loadTheme('unknown', reg), /fontsFrom must name a known theme/);
  assert.throws(() => loadTheme('self', reg), /must not name itself/);
  assert.throws(() => loadTheme('bad', reg), /fontsFrom must name a known theme/);
  assert.throws(() => loadTheme('onplain', reg), /has no theme files/);
  assert.throws(() => loadTheme('both', reg), /must not also carry its own/);
  assert.throws(() => loadTheme('second', reg), /only one level/);
});
