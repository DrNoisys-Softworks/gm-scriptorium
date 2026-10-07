'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PIN = require('../vendor/gm-apprentice-publish/PIN.json');

/*
 * Every `lib/<path>.js:<line>[-<line>]` citation in src/ must name a real
 * file in the pin's own shipped tree, at a line range that actually exists
 * in that file (verified against the INSTALLED node_modules copy, which
 * npm/verify-generator already guarantee matches PIN.json byte for byte).
 * No bare `scanner.js:12`-style legacy citation (no `lib/` prefix) may
 * remain in src/checks or src/vault — every one of those must have been
 * replaced by a `lib/<file>.js:<line>` citation against the pin, or removed.
 */

const SRC_DIR = path.join(__dirname, '..', 'src');
const GENERATOR_LIB_DIR = path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish', 'lib');

const CITATION_RE = /lib\/[\w/.-]+\.js:\d+(?:-\d+)?/g;
const BARE_LEGACY_RE = /(?<![\w/])(scanner|processor|build|config|manifest|publish-decision)\.js:\d+/g;

function walkJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function lineCountOf(libRelPath) {
  const full = path.join(GENERATOR_LIB_DIR, libRelPath.replace(/^lib\//, ''));
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8').split('\n').length;
}

test('pin-citations: every lib/<file>.js:<line> citation in src/ names a real pin file, at an in-range line', () => {
  const problems = [];
  for (const file of walkJsFiles(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), file);
    let m;
    CITATION_RE.lastIndex = 0;
    while ((m = CITATION_RE.exec(text))) {
      const citation = m[0];
      const [libPart, rangePart] = citation.split(/:(\d+(?:-\d+)?)$/).filter(Boolean);
      // PIN.json.files is keyed by the package-relative POSIX path INCLUDING
      // the "lib/" prefix (e.g. "lib/processor.js"), matching a citation verbatim.
      if (!Object.prototype.hasOwnProperty.call(PIN.files, libPart)) {
        problems.push(`${rel}: "${citation}" names a file not in PIN.json.files`);
        continue;
      }
      const lines = rangePart.split('-').map(Number);
      const maxLine = Math.max(...lines);
      const totalLines = lineCountOf(libPart);
      if (totalLines == null) {
        problems.push(`${rel}: "${citation}" — ${libPart} not found under node_modules/gm-apprentice-publish`);
        continue;
      }
      if (maxLine > totalLines) {
        problems.push(`${rel}: "${citation}" — line ${maxLine} is past ${libPart}'s ${totalLines} lines`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('pin-citations: no bare legacy citation (no lib/ prefix) remains in src/checks or src/vault', () => {
  const problems = [];
  for (const dirName of ['checks', 'vault']) {
    for (const file of walkJsFiles(path.join(SRC_DIR, dirName))) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(path.join(__dirname, '..'), file);
      let m;
      BARE_LEGACY_RE.lastIndex = 0;
      while ((m = BARE_LEGACY_RE.exec(text))) {
        problems.push(`${rel}: bare legacy citation "${m[0]}" (no lib/ prefix)`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
