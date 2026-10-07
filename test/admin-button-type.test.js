'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ADMIN_ASSET_ROUTES, ADMIN_ASSETS_DIR } = require('../src/admin/assets');

/*
 * admin-fix-1, item 2 (MEDIUM): every "Confirm save" button was created with no explicit `type`
 * inside a <form>, defaulting to `type=submit`; its click handler also called
 * form.requestSubmit() without preventDefault(), so a click both native-submitted the form AND
 * issued a second, explicit POST -- the second one always got refused with 409 (the base sha had
 * already advanced). Source scan, in the style of test/admin-assets.test.js's own forbidden-token
 * test: a button created with `el('button')` in assets/admin/*.js must set its own `.type` within
 * the next few lines, so a future button can never silently default to `type=submit` again.
 */

function findButtonVarsMissingType(src) {
  const lines = src.split('\n');
  const re = /var\s+(\w+)\s*=\s*el\('button'\);/;
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const varName = m[1];
    // The next few lines: every already-correct button in this codebase sets `.type` on the very
    // next line (e.g. `saveBtn.type = 'submit';`); a window of 4 lines is generous headroom
    // without being so wide it could pick up an unrelated variable of the same name reused later.
    const window = lines.slice(i, i + 4).join('\n');
    const typedRe = new RegExp(`\\b${varName}\\.type\\s*=`);
    if (!typedRe.test(window)) {
      offenders.push(`line ${i + 1} (${varName})`);
    }
  }
  return offenders;
}

test('every el(\'button\') in assets/admin/*.js sets an explicit .type (no button may default to type=submit)', () => {
  const jsNames = Object.keys(ADMIN_ASSET_ROUTES).filter((name) => name.endsWith('.js'));
  assert.ok(jsNames.length > 0, 'expected at least one admin JS asset');

  const report = [];
  for (const name of jsNames) {
    const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name), 'utf8');
    for (const offender of findButtonVarsMissingType(src)) {
      report.push(`${name}: ${offender}`);
    }
  }
  assert.deepEqual(report, [], `button(s) created with no explicit .type:\n${report.join('\n')}`);
});
