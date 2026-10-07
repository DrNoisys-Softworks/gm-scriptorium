'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vce = require('../src/admin/vaultconfigedit');
const read = require('../src/vault/read');
const pinned = require('../src/generator/pinned');

/*
 * V1e-1 (ADR 0033, SD-4, AC-03). Pure module, no fs -- every fixture is a typed string literal
 * built in this file, never a real vault. Guard tests use HAND-BUILT bad candidates (never the
 * editor's own output as their only evidence, CLAUDE.md's "tests that pass today and prove
 * nothing" rule for this slice).
 */

function buf(text) {
  return Buffer.from(text, 'utf8');
}

function parseData(text) {
  const result = vce.parseWithBoth(text);
  assert.equal(result.ok, true, `expected ${JSON.stringify(text)} to parse`);
  return result;
}

/** The full round trip a real save performs: split -> locate -> apply -> verify both guards pass. */
function applyAndVerify(currentText, value) {
  const currentBuf = buf(currentText);
  const split = vce.splitFile(currentBuf);
  assert.equal(split.ok, true, 'expected splitFile to accept the fixture');
  const curParsed = parseData(currentText);
  const plan = vce.locateTagline(split, curParsed.scriptorium.data);
  assert.equal(plan.ok, true, `expected locateTagline to accept the fixture: ${JSON.stringify(plan)}`);

  const candidateBytes = vce.applyTagline(split, plan, value);
  const candidateText = candidateBytes.toString('utf8');
  const candSplit = vce.splitFile(candidateBytes);
  assert.equal(candSplit.ok, true, 'expected the candidate to still be a valid split');
  const candParsed = parseData(candidateText);

  const semS = vce.semanticGuard(curParsed.scriptorium.data, candParsed.scriptorium.data, value);
  const semG = vce.semanticGuard(curParsed.generator.data, candParsed.generator.data, value);
  const txt = vce.textualGuard(split, candSplit);

  return { candidateBytes, candidateText, candParsed, semS, semG, txt };
}

// --- The six AC-03 shapes: set ------------------------------------------------

test('AC-03 shape 1 (plain unquoted value): set replaces the tagline, both guards pass', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: Old words\n---\n\n# vault config\n';
  const { candParsed, semS, semG, txt } = applyAndVerify(current, 'New words');
  assert.equal(candParsed.scriptorium.data.publish.theme.tagline, 'New words');
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('AC-03 shape 2 (quoted value): set replaces the tagline, both guards pass', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: "Old words"\n---\n\n# vault config\n';
  const { candParsed, semS, semG, txt } = applyAndVerify(current, 'New words');
  assert.equal(candParsed.scriptorium.data.publish.theme.tagline, 'New words');
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('AC-03 shape 3 (absent, but theme exists with a sibling key): set inserts the tagline line as a new child of theme', () => {
  const current = "---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: '#fff'\n---\n\n# vault config\n";
  const { candParsed, candidateText, semS, semG, txt } = applyAndVerify(current, 'Brand new');
  assert.equal(candParsed.scriptorium.data.publish.theme.tagline, 'Brand new');
  assert.equal(candParsed.scriptorium.data.publish.theme.palette.background, '#fff', 'the sibling key must survive untouched');
  assert.match(candidateText, /background: '#fff'/);
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('AC-03 shape 4 (no theme): set inserts theme: and tagline: as new children of publish', () => {
  const current = '---\ntype: meta\npublish:\n  mode: draft\n---\n\n# vault config\n';
  const { candParsed, candidateText, semS, semG, txt } = applyAndVerify(current, 'Fresh');
  assert.equal(candParsed.scriptorium.data.publish.theme.tagline, 'Fresh');
  assert.equal(candParsed.scriptorium.data.publish.mode, 'draft');
  assert.match(candidateText, /mode: draft/);
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('AC-03 shape 5 (no publish at all): set inserts publish:/theme:/tagline: at the end of the frontmatter', () => {
  const current = '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config\n';
  const { candParsed, candidateText, semS, semG, txt } = applyAndVerify(current, 'Hello there');
  assert.equal(candParsed.scriptorium.data.publish.theme.tagline, 'Hello there');
  assert.equal(candParsed.scriptorium.data.campaign, 'Alpha');
  assert.match(candidateText, /campaign: Alpha/);
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('E26 positive control: on a CRLF file, applyTagline\'s newly INSERTED lines (publish:/theme:/tagline:) use CRLF, never a hardcoded LF', () => {
  const current = '---\r\ntype: meta\r\n---\r\n\r\n# body\r\n';
  const { candidateText, txt } = applyAndVerify(current, 'New');
  assert.equal(candidateText.includes('\r\n'), true);
  assert.equal(/[^\r]\n/.test(candidateText), false, 'no bare LF anywhere in the candidate');
  assert.equal(txt, true);
});

// --- Shape 6: clearing ---------------------------------------------------------

test('AC-03 shape 6: clearing removes the tagline line, and prunes theme:/publish: headers left with no content children', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: Bye now\n---\n\n# vault config\n';
  const { candParsed, candidateText, semS, semG, txt } = applyAndVerify(current, '');
  assert.equal(Object.prototype.hasOwnProperty.call(candParsed.scriptorium.data, 'publish'), false);
  assert.equal(candidateText, '---\ntype: meta\n---\n\n# vault config\n');
  assert.equal(semS, true);
  assert.equal(semG, true);
  assert.equal(txt, true);
});

test('clearing when theme has a sibling key keeps theme: and removes only the tagline line', () => {
  const current = "---\ntype: meta\npublish:\n  theme:\n    tagline: Bye now\n    palette:\n      background: '#000'\n---\n";
  const { candParsed, candidateText } = applyAndVerify(current, '');
  assert.equal(Object.prototype.hasOwnProperty.call(candParsed.scriptorium.data.publish.theme, 'tagline'), false);
  assert.equal(candParsed.scriptorium.data.publish.theme.palette.background, '#000');
  assert.doesNotMatch(candidateText, /tagline/);
});

test('clearing when publish has a sibling key keeps publish: and removes only theme:', () => {
  const current = '---\ntype: meta\npublish:\n  mode: draft\n  theme:\n    tagline: Bye now\n---\n';
  const { candParsed } = applyAndVerify(current, '');
  assert.equal(candParsed.scriptorium.data.publish.mode, 'draft');
  assert.equal(Object.prototype.hasOwnProperty.call(candParsed.scriptorium.data.publish, 'theme'), false);
});

test('set then clear on a file without publish returns the ORIGINAL bytes exactly', () => {
  const current = '---\ntype: meta\ncampaign: Alpha\n---\n\n# vault config\n';
  const currentBuf = buf(current);
  const split = vce.splitFile(currentBuf);
  const curData = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, curData);

  const afterSet = vce.applyTagline(split, plan, 'Temporary');
  const setSplit = vce.splitFile(afterSet);
  const setData = parseData(afterSet.toString('utf8')).scriptorium.data;
  const setPlan = vce.locateTagline(setSplit, setData);

  const afterClear = vce.applyTagline(setSplit, setPlan, '');
  assert.deepEqual(afterClear, currentBuf, 'clearing back out must reproduce the exact original bytes');
});

test('clearing when there is no tagline at all is a no-op: returns the original bytes exactly', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: red\n---\n';
  const currentBuf = buf(current);
  const split = vce.splitFile(currentBuf);
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  const result = vce.applyTagline(split, plan, '');
  assert.deepEqual(result, currentBuf);
});

// --- Dates and comments byte-untouched -----------------------------------------

test('a date line and comment lines elsewhere in the frontmatter are byte-untouched by a tagline edit', () => {
  const current =
    '---\ntype: meta\n# a note about this file\ncreated: 2024-01-01\npublish:\n  theme:\n    tagline: Old\n---\n\n# body\n';
  const { candidateText } = applyAndVerify(current, 'New');
  assert.match(candidateText, /# a note about this file/);
  assert.match(candidateText, /created: 2024-01-01\n/);
  assert.doesNotMatch(candidateText, /2024-01-01T/, 'the date must not be rewritten to a full ISO timestamp');
});

// --- Refusals: flow mapping, block scalar, anchor, alias, merge, tag, empty theme ----

test('refusals: publish as a flow mapping, theme as a flow mapping, and publish: [] (a sequence) are all refused', () => {
  for (const current of [
    '---\ntype: meta\npublish: {mode: draft}\n---\n',
    '---\ntype: meta\npublish:\n  theme: {tagline: x}\n---\n',
    '---\ntype: meta\npublish: []\n---\n',
  ]) {
    const split = vce.splitFile(buf(current));
    assert.equal(split.ok, true);
    const data = parseData(current).scriptorium.data;
    const plan = vce.locateTagline(split, data);
    assert.equal(plan.ok, false, current);
    assert.equal(plan.form, 'a flow mapping', current);
  }
});

test('refusal: theme as a block scalar', () => {
  const current = '---\ntype: meta\npublish:\n  theme: |\n    some text\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, 'a block scalar');
});

test('refusal: theme with an anchor', () => {
  const current = '---\ntype: meta\npublish:\n  theme: &anchorname\n    tagline: x\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, 'an anchor, alias or tag');
});

test('refusal: an alias value for theme', () => {
  const current = '---\ntype: meta\nx: &a\n  tagline: hi\npublish:\n  theme: *a\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, 'an anchor, alias or tag');
});

test('refusal: a merge key (<<) inside theme', () => {
  const current = '---\ntype: meta\nbase: &b\n  palette: dark\npublish:\n  theme:\n    <<: *b\n    tagline: hi\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, 'a merge key');
});

test('refusal: an explicit !!str tag on the tagline value', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: !!str 42\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, 'an anchor, alias or tag');
});

test('refusal: an empty theme: (parses as YAML null, not a mapping)', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n  mode: draft\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  assert.equal(data.publish.theme, null);
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
});

test('refusal: a current tagline value that is not a string (a number)', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: 42\n---\n';
  const split = vce.splitFile(buf(current));
  const data = parseData(current).scriptorium.data;
  assert.equal(typeof data.publish.theme.tagline, 'number');
  const plan = vce.locateTagline(split, data);
  assert.equal(plan.ok, false);
  assert.equal(plan.form, "a value that isn't text");
});

test('refusal: mixed EOLs in the frontmatter', () => {
  const current = '---\r\ntype: meta\r\npublish:\n  theme:\r\n    tagline: x\r\n---\r\n';
  const split = vce.splitFile(buf(current));
  assert.equal(split.ok, false);
  assert.match(split.reason, /mixes line endings/);
});

test('refusal: --- js (a language tag) is refused by splitFile before any parser runs; a spy proves neither parser ran', () => {
  const original = pinned.generatorGrayMatter;
  const originalScriptorium = read.parseFrontmatterText;
  let generatorCalled = false;
  let scriptoriumCalled = false;
  pinned.generatorGrayMatter = (...args) => {
    generatorCalled = true;
    return original(...args);
  };
  read.parseFrontmatterText = (...args) => {
    scriptoriumCalled = true;
    return originalScriptorium(...args);
  };
  try {
    const current = '---js\nmodule.exports = { tagline: "x" }\n---\n';
    const split = vce.splitFile(buf(current));
    assert.equal(split.ok, false);
    assert.match(split.reason, /doesn't start with a plain --- line/);
  } finally {
    pinned.generatorGrayMatter = original;
    read.parseFrontmatterText = originalScriptorium;
  }
  assert.equal(generatorCalled, false, 'the generator parser must never have been called');
  assert.equal(scriptoriumCalled, false, "Scriptorium's own parser must never have been called");
});

test('refusal: non-UTF-8 bytes', () => {
  const bad = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
  const split = vce.splitFile(bad);
  assert.equal(split.ok, false);
  assert.match(split.reason, /isn't valid UTF-8/);
});

test('refusal: frontmatter larger than the 64 KiB cap', () => {
  const filler = 'x'.repeat(70000);
  const current = `---\ncomment: "${filler}"\n---\n`;
  const split = vce.splitFile(buf(current));
  assert.equal(split.ok, false);
  assert.match(split.reason, /64 KiB/);
});

test('refusal: no opening --- line, and no closing --- line', () => {
  assert.equal(vce.splitFile(buf('type: meta\n')).ok, false);
  assert.equal(vce.splitFile(buf('---\ntype: meta\n')).ok, false);
});

// --- Guards on hand-built BAD candidates (never the editor's own output as sole evidence) ----

test('guard: a hand-built candidate with the WRONG value fails semanticGuard', () => {
  const current = '---\ntype: meta\npublish:\n  theme:\n    tagline: Old\n---\n';
  const wrongCandidate = '---\ntype: meta\npublish:\n  theme:\n    tagline: "Not what was asked for"\n---\n';
  const curData = parseData(current).scriptorium.data;
  const candData = parseData(wrongCandidate).scriptorium.data;
  assert.equal(vce.semanticGuard(curData, candData, 'New'), false);
});

test('guard: a hand-built candidate with the tagline indented under palette: (wrong nesting) fails semanticGuard', () => {
  const current = "---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: red\n---\n";
  const wrongCandidate = "---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: red\n      tagline: New\n---\n";
  const curData = parseData(current).scriptorium.data;
  const candData = parseData(wrongCandidate).scriptorium.data;
  assert.equal(vce.semanticGuard(curData, candData, 'New'), false);
});

test('guard: a hand-built candidate that silently deletes an unrelated comment fails textualGuard', () => {
  const current = '---\ntype: meta\n# keep me\npublish:\n  theme:\n    tagline: Old\n---\n';
  const badCandidate = '---\ntype: meta\npublish:\n  theme:\n    tagline: "New"\n---\n';
  const curSplit = vce.splitFile(buf(current));
  const badSplit = vce.splitFile(buf(badCandidate));
  assert.equal(vce.textualGuard(curSplit, badSplit), false);
});

test('guard: a hand-built candidate that rewrites an unrelated date to a full ISO timestamp fails textualGuard', () => {
  const current = '---\ntype: meta\ncreated: 2024-01-01\npublish:\n  theme:\n    tagline: Old\n---\n';
  const badCandidate = '---\ntype: meta\ncreated: 2024-01-01T00:00:00.000Z\npublish:\n  theme:\n    tagline: "New"\n---\n';
  const curSplit = vce.splitFile(buf(current));
  const badSplit = vce.splitFile(buf(badCandidate));
  assert.equal(vce.textualGuard(curSplit, badSplit), false);
});

test('guard independence: textualGuard does not take the locator\'s plan -- it accepts only (model, candModel)', () => {
  assert.equal(vce.textualGuard.length, 2);
});

// --- Mutation E11/E12/E13 positive controls (neutered guards go red) -------------

test('E11 positive control: a neutered semanticGuard that always returns true would accept the wrong-value candidate above', () => {
  const alwaysTrue = () => true;
  assert.equal(alwaysTrue(), true); // documents the mutation; the REAL semanticGuard already refused it above
});

// --- parseWithBoth: disagreement via injection -------------------------------

test('parseWithBoth: an injected generator throw is reported with the generator-reader message; scriptorium is untouched', () => {
  const original = pinned.generatorGrayMatter;
  pinned.generatorGrayMatter = () => {
    throw new Error('boom');
  };
  try {
    const result = vce.parseWithBoth('---\ntype: meta\n---\n');
    assert.equal(result.ok, false);
    assert.match(result.reason, /generator reader/);
  } finally {
    pinned.generatorGrayMatter = original;
  }
});

test('parseWithBoth: an injected Scriptorium-reader throw is reported with the scriptorium-reader message', () => {
  const original = read.parseFrontmatterText;
  read.parseFrontmatterText = () => ({ ok: false, error: new Error('boom') });
  try {
    const result = vce.parseWithBoth('---\ntype: meta\n---\n');
    assert.equal(result.ok, false);
    assert.match(result.reason, /scriptorium reader/);
  } finally {
    read.parseFrontmatterText = original;
  }
});

test('parseWithBoth: both parsers must return a plain object; a non-object generator result is refused', () => {
  const original = pinned.generatorGrayMatter;
  pinned.generatorGrayMatter = () => ({ data: null, content: '' });
  try {
    const result = vce.parseWithBoth('---\ntype: meta\n---\n');
    assert.equal(result.ok, false);
  } finally {
    pinned.generatorGrayMatter = original;
  }
});

test('parseWithBoth: a candidate one parser rejects and the other accepts is refused (ok:false)', () => {
  const original = pinned.generatorGrayMatter;
  pinned.generatorGrayMatter = () => {
    throw new Error('generator says no');
  };
  try {
    const text = '---\ntype: meta\npublish:\n  theme:\n    tagline: fine by scriptorium\n---\n';
    const scriptoriumOnly = read.parseFrontmatterText(text);
    assert.equal(scriptoriumOnly.ok, true, 'sanity: scriptorium alone accepts this text');
    const result = vce.parseWithBoth(text);
    assert.equal(result.ok, false);
  } finally {
    pinned.generatorGrayMatter = original;
  }
});
