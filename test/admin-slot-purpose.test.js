'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { IM, SLOT_NAMES } = require(path.join(__dirname, '..', 'assets', 'admin', 'images.js'));

/*
 * Owner feedback (2026-09-30, mid-V1d-2): the Images screen's slot rows needed to say what each
 * slot is for, not just its size. IM.SLOT_PURPOSE/purposeFor, above the node module.exports guard
 * (the VB pattern), loaded via require(). Independent literals throughout.
 */

test('IM.purposeFor: every one of the six SLOT_NAMES has a purpose entry', () => {
  SLOT_NAMES.forEach((slot) => {
    const purpose = IM.purposeFor(slot);
    assert.ok(purpose, `expected a purpose entry for "${slot}"`);
    assert.equal(typeof purpose.text, 'string');
    assert.ok(purpose.text.length > 0, `${slot}: purpose text must not be empty`);
    assert.equal(typeof purpose.diagram, 'string');
  });
});

test('IM.purposeFor: an unknown slot gives null (no string-prefix sibling match)', () => {
  assert.equal(IM.purposeFor('heroic'), null);
  assert.equal(IM.purposeFor('groundx'), null);
  assert.equal(IM.purposeFor(''), null);
  assert.equal(IM.purposeFor('constructor'), null);
});

test('IM.SLOT_PURPOSE: every diagram value is distinct (one schematic per slot)', () => {
  const diagrams = SLOT_NAMES.map((slot) => IM.purposeFor(slot).diagram);
  assert.equal(new Set(diagrams).size, diagrams.length);
});

// V1e-5 (SD-58): the three text-content assertions above (the ADR 0019 citation, the "landing
// banner" cross-reference and the "transparency" wording) are replaced by one deep-equal of all
// six purpose texts against independently typed literals (SD-54's own truthful descriptions).
test('IM.purposeFor: every text equals the independently typed SD-54 literal', () => {
  assert.deepEqual(
    Object.fromEntries(SLOT_NAMES.map((slot) => [slot, IM.purposeFor(slot).text])),
    {
      hero: 'A wide picture meant for the top of your landing page.',
      ground: 'A picture fixed behind your pages, showing around the edges of the text.',
      paper: 'A small image repeated behind text and cards, like paper grain.',
      'crest-frame': 'A decorative border for faction crests and emblems.',
      portrait: 'An upright character portrait.',
      '404': 'The picture on the page players land on when a link goes nowhere.',
    },
  );
});

// ADR 0032 (base theme slice): the truth is derived independently by reading every registry
// theme's own theme.json with `fs`, never through images.js and never through loadTheme() --
// so a theme.json edit that adds or drops a slot is caught here without this test changing.
const THEMES_DIR = path.join(__dirname, '..', 'assets', 'themes');

function registryThemeSlots() {
  const out = {};
  for (const name of fs.readdirSync(THEMES_DIR)) {
    const jsonPath = path.join(THEMES_DIR, name, 'theme.json');
    if (!fs.existsSync(jsonPath)) continue;
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    out[meta.name] = meta.slots;
  }
  return out;
}

test('IM.drawersFor: every slot\'s drawer list equals the themes whose own theme.json names that slot (derived from disk, not images.js)', () => {
  const slotsByTheme = registryThemeSlots();
  for (const slot of SLOT_NAMES) {
    const expectedDrawers = Object.keys(slotsByTheme)
      .filter((name) => slotsByTheme[name].includes(slot))
      .sort();
    assert.deepEqual(IM.drawersFor(slot).slice().sort(), expectedDrawers, `slot "${slot}"`);
  }
});

test('IM.drawersFor: an unknown or inherited slot name gives [] (no string-prefix or `in` match, GM8)', () => {
  assert.deepEqual(IM.drawersFor('groundx'), []);
  assert.deepEqual(IM.drawersFor('constructor'), []);
  assert.deepEqual(IM.drawersFor(''), []);
});

test('IM.BUILT_IN_SLOT_DRAWERS: at least one slot has a real drawer today (positive control against a vacuous derived-truth pass)', () => {
  const anyDrawn = SLOT_NAMES.some((slot) => IM.drawersFor(slot).length > 0);
  assert.ok(anyDrawn);
});
