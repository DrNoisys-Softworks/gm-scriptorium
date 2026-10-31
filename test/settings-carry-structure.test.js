'use strict';

/*
 * Structural pins for the carry (ADR 0071). The pin's move code can write the settings files, so:
 *
 *   1. only src/generator/pinned.js names planMove or applyMove (the facade);
 *   2. only src/vault/settingscarry.js names applySettingsCarry or applySettingsChanges (the writers);
 *   3. settingscarry is required only by the carry command, init and the panel's carry handler
 *      (src/admin/handlers/carry.js, which arrives with the panel slice).
 *
 * Each scan has a positive control, so a scan that matches nothing cannot pass for a clean tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

function filesNaming(root, dirs, re) {
  const found = [];
  for (const d of dirs) {
    for (const f of listJs(path.join(root, d))) if (re.test(fs.readFileSync(f, 'utf8'))) found.push(rel(root, f));
  }
  return found.sort();
}

const MOVE_RE = /\b(?:applyMove|planMove)\b/;
const APPLY_CARRY_RE = /\bapplySettingsCarry\b/;
// The facade's writer of the vault's settings file: check and build must never reach it.
const WRITER_RE = /\bapplySettingsChanges\b/;
const REQUIRE_CARRY_RE = /require\(\s*(['"`])[^'"`]*\bsettingscarry\1\s*\)/;
const DIRS = ['src', 'bin', 'scripts'];

test('only the facade names applyMove or planMove', () => {
  const found = filesNaming(ROOT, DIRS, MOVE_RE);
  assert.deepEqual(found, ['src/generator/pinned.js']);
});

test('only src/vault/settingscarry.js names applySettingsCarry, apart from its definition in the facade', () => {
  const found = filesNaming(ROOT, DIRS, APPLY_CARRY_RE);
  assert.deepEqual(found, ['src/generator/pinned.js', 'src/vault/settingscarry.js']);
});

test('only src/vault/settingscarry.js calls applySettingsChanges, apart from its definition in the facade', () => {
  const found = filesNaming(ROOT, DIRS, WRITER_RE);
  assert.deepEqual(found, ['src/generator/pinned.js', 'src/vault/settingscarry.js']);
});

test('settingscarry is required only by the carry command, init and the panel carry handler', () => {
  const found = filesNaming(ROOT, DIRS, REQUIRE_CARRY_RE);
  const allowed = new Set(['src/cli/carry.js', 'src/cli/init.js', 'src/admin/handlers/carry.js']);
  const extra = found.filter((f) => !allowed.has(f));
  assert.deepEqual(extra, []);
  assert.ok(found.includes('src/cli/carry.js'), 'the carry command must require it');
});

test('positive control: a planted tree is caught by each scan', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-structure-ctl-'));
  try {
    fs.mkdirSync(path.join(scratch, 'src', 'x'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'src', 'x', 'a.js'), "const m = require('p');\nm.applyMove(plan);\nm.planMove({});\n");
    fs.writeFileSync(path.join(scratch, 'src', 'x', 'b.js'), 'pinned.applySettingsCarry(plan);\n');
    fs.writeFileSync(path.join(scratch, 'src', 'x', 'c.js'), "const c = require('../vault/settingscarry');\n");
    fs.writeFileSync(path.join(scratch, 'src', 'x', 'd.js'), "const ok = require('./other');\n");
    assert.deepEqual(filesNaming(scratch, ['src'], MOVE_RE), ['src/x/a.js']);
    assert.deepEqual(filesNaming(scratch, ['src'], APPLY_CARRY_RE), ['src/x/b.js']);
    assert.deepEqual(filesNaming(scratch, ['src'], REQUIRE_CARRY_RE), ['src/x/c.js']);
    fs.writeFileSync(path.join(scratch, 'src', 'x', 'e.js'), 'pinned.applySettingsChanges(v, c);\n');
    assert.deepEqual(filesNaming(scratch, ['src'], WRITER_RE), ['src/x/e.js']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
