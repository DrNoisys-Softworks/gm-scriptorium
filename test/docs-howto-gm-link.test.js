'use strict';

/*
 * Doc-vs-code facts for the two how-tos on GM-only material. The pages are prose, so these tests
 * pin only what the code can check: the [gm_link] example on the Game master link page parses
 * cleanly, the address the page states for the link is what the code builds, a path in the address
 * is refused, and the usage guide links to the hiding how-to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePackToml } = require('../src/build/packtoml');
const { gmAccessHref } = require('../src/build/gmaccess');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TOML_PATH = path.join(os.tmpdir(), 'pack.toml');

function firstTomlBlock(text) {
  const lines = text.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => line === '```toml');
  assert.ok(start !== -1, 'the page has no toml block');
  const end = lines.indexOf('```', start + 1);
  assert.ok(end !== -1, 'the toml block is not closed');
  return lines.slice(start + 1, end).join('\n') + '\n';
}

test('the example on the Game master link page parses with no warnings and the stated address', () => {
  const block = firstTomlBlock(read('docs/how-to/add-a-game-master-link.md'));
  const parsed = parsePackToml(block, { tomlPath: TOML_PATH, campaign: 'lease' });
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.gmLink, { url: 'https://scriptorium.home.arpa' });
});

test('the link the page describes is the address, a slash and the campaign hint', () => {
  assert.equal(
    gmAccessHref('https://scriptorium.home.arpa', 'lease'),
    'https://scriptorium.home.arpa/?campaign=lease'
  );
});

test('control: an address with a path is refused', () => {
  const bad = '[gm_link]\nurl = "https://scriptorium.home.arpa/game"\n';
  assert.throws(() => parsePackToml(bad, { tomlPath: TOML_PATH, campaign: 'lease' }));
});

test('the usage guide links to the hiding how-to', () => {
  const text = read('docs/using.md');
  const targets = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) targets.push(m[1]);
  assert.ok(targets.some((target) => target === 'how-to/hide-gm-content.md'));
});
