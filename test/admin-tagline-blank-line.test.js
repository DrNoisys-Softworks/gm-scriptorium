'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vce = require('../src/admin/vaultconfigedit');

/* Issue #87: blank line(s) after the tagline must not make a tagline-only save refuse. */

function roundTrip(currentText, value) {
  const split = vce.splitFile(Buffer.from(currentText, 'utf8'));
  assert.equal(split.ok, true);
  const cur = vce.parseWithBoth(currentText);
  assert.equal(cur.ok, true);
  const plan = vce.locateTagline(split, cur.scriptorium.data);
  assert.equal(plan.ok, true);
  const bytes = vce.applyTagline(split, plan, value);
  const text = bytes.toString('utf8');
  const candSplit = vce.splitFile(bytes);
  const cand = vce.parseWithBoth(text);
  return {
    text,
    guards: vce.semanticGuard(cur.scriptorium.data, cand.scriptorium.data, value) &&
      vce.semanticGuard(cur.generator.data, cand.generator.data, value) &&
      vce.textualGuard(split, candSplit),
  };
}

for (const [name, blanks] of [['one blank line', '\n'], ['two blank lines', '\n\n'], ['a whitespace-only line', '  \n']]) {
  test(`set with ${name} after the tagline: guards pass, blank line preserved`, () => {
    const cur = `---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n${blanks}  other: 1\n---\n\n# vault config\n`;
    const r = roundTrip(cur, 'New words');
    assert.equal(r.guards, true);
    assert.equal(r.text, `---\ntype: meta\npublish:\n  theme:\n    tagline: "New words"\n${blanks}  other: 1\n---\n\n# vault config\n`);
  });
}

test('set with a blank line after the tagline at end of the frontmatter', () => {
  const cur = '---\npublish:\n  theme:\n    tagline: Old\n\n---\n';
  const r = roundTrip(cur, 'New');
  assert.equal(r.guards, true);
  assert.equal(r.text, '---\npublish:\n  theme:\n    tagline: "New"\n\n---\n');
});

test('clear with a blank line after the tagline passes the guards', () => {
  const cur = '---\npublish:\n  theme:\n    tagline: Old\n    accent: red\n\n---\n';
  const r = roundTrip(cur, '');
  assert.equal(r.guards, true);
  assert.equal(r.text, '---\npublish:\n  theme:\n    accent: red\n\n---\n');
});
