'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildNoticesText, main } = require('../scripts/generate-notices');

/*
 * #29: generate-notices.js's own `wrote <path> (<n> bytes)` line under-reported
 * the file's real size by 6 bytes -- it measured the JS string's UTF-16
 * code-unit length (`text.length`) instead of the UTF-8 byte count actually
 * written to disk. The real, committed notices text already contains enough
 * multi-byte characters (an em dash, at minimum) for the two numbers to
 * diverge, so main() is exercised here against its REAL buildNoticesText()
 * output, with writeFileSync/statSync redirected to a scratch file so this
 * test never touches the committed THIRD-PARTY-NOTICES.txt.
 */

function withScratchMain(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-notices-main-'));
  const scratchPath = path.join(dir, 'NOTICES.txt');
  try {
    const logs = [];
    main({
      writeFileSync: (_targetPath, data) => fs.writeFileSync(scratchPath, data),
      statSync: (_targetPath) => fs.statSync(scratchPath),
      log: (line) => logs.push(line),
    });
    fn({ scratchPath, logs });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the real notices text has at least one multi-byte UTF-8 character, so this defect is actually reachable', () => {
  // Independent ground truth, not read from generate-notices.js's own byte-count
  // logic: Buffer.byteLength (UTF-8) vs JS string.length (UTF-16 code units).
  const text = buildNoticesText();
  assert.ok(
    Buffer.byteLength(text, 'utf8') > text.length,
    'expected the notices text to contain at least one multi-byte UTF-8 character',
  );
});

test('main() logs the byte count read back from disk (fs.statSync), not text.length', () => {
  withScratchMain(({ scratchPath, logs }) => {
    const actualBytesOnDisk = fs.statSync(scratchPath).size; // independent ground truth
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`\\(${actualBytesOnDisk} bytes\\)$`));
  });
});

test('main() logged byte count does NOT equal the JS string length (proves it is not measuring text.length)', () => {
  const text = buildNoticesText();
  withScratchMain(({ logs }) => {
    assert.ok(!logs[0].includes(`(${text.length} bytes)`), `logged count must not be the UTF-16 length ${text.length}`);
  });
});

test('main() writes the exact same text buildNoticesText() produces', () => {
  // buildNoticesText() stamps a fresh `Generated: <ISO timestamp>` line on
  // every call (scripts/notices-freshness.js's own GENERATED_LINE_RE strips
  // this same line for the identical reason), so the "expected" call here
  // and the one main() makes internally can differ by milliseconds on that
  // one line alone. Normalize only that line before comparing.
  const stripGenerated = (text) => text.replace(/^Generated: .*$/m, 'Generated: <ignored-for-comparison>');
  const expected = stripGenerated(buildNoticesText());
  withScratchMain(({ scratchPath }) => {
    assert.equal(stripGenerated(fs.readFileSync(scratchPath, 'utf8')), expected);
  });
});
