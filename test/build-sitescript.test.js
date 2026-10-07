'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SITE_SCRIPT_MARKER,
  SITE_SCRIPT_FILENAME,
  EMBEDDED_SITE_SCRIPT_PATH,
  linkSiteScript,
  writeSiteScript,
  serializeDataIsland,
} = require('../src/build/sitescript');
const { scanOutputTree } = require('../src/checks/leak/outputscan');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sitescript-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pageWithNav(root) {
  return `<html><body>\n<script src="${root}nav.js"></script>\n</body></html>`;
}

// -- T-S1: src derived at various depths --------------------------------------------------------

test('linkSiteScript: derives the src from the nav.js tag at depths 0, 1, 2, including "./" (T-S1)', () => {
  assert.match(linkSiteScript(pageWithNav('js/')), /src="js\/scriptorium\.js"/);
  assert.match(linkSiteScript(pageWithNav('../js/')), /src="\.\.\/js\/scriptorium\.js"/);
  assert.match(linkSiteScript(pageWithNav('../../js/')), /src="\.\.\/\.\.\/js\/scriptorium\.js"/);
  assert.match(linkSiteScript(`<html><body>\n<script src="./js/nav.js"></script>\n</body></html>`), /src="\.\/js\/scriptorium\.js"/);
});

// -- T-S2: no nav.js -> null --------------------------------------------------------------------

test('linkSiteScript: no nav.js tag gives null (T-S2)', () => {
  assert.equal(linkSiteScript('<html><body></body></html>'), null);
});

// -- T-S3: tag linked once, before the last </body> ----------------------------------------------

test('linkSiteScript: links the tag once, before the last </body> (T-S3)', () => {
  const html = `<html><body>\n<script src="js/nav.js"></script>\n<!-- a comment with </body> inside -->\n</body></html>`;
  const patched = linkSiteScript(html);
  assert.equal((patched.match(new RegExp(SITE_SCRIPT_MARKER, 'g')) || []).length, 1);
  const lastBodyIdx = patched.lastIndexOf('</body>');
  const scriptIdx = patched.indexOf(`${SITE_SCRIPT_FILENAME}" ${SITE_SCRIPT_MARKER}`);
  assert.ok(scriptIdx < lastBodyIdx);
  assert.equal(linkSiteScript(patched), null); // idempotent
});

// -- T-S4: writeSiteScript writes nothing when linkedPages is 0 ---------------------------------

test('writeSiteScript: writes nothing when linkedPages is 0 (T-S4)', () => {
  withTmpDir((dir) => {
    const result = writeSiteScript(dir, { linkedPages: 0 });
    assert.equal(result.written, false);
    assert.ok(!fs.existsSync(path.join(dir, 'js', SITE_SCRIPT_FILENAME)));
  });
});

test('writeSiteScript: copies the embedded asset when linkedPages > 0', () => {
  withTmpDir((dir) => {
    const result = writeSiteScript(dir, { linkedPages: 2 });
    assert.equal(result.written, true);
    const written = fs.readFileSync(path.join(dir, 'js', SITE_SCRIPT_FILENAME));
    const embedded = fs.readFileSync(EMBEDDED_SITE_SCRIPT_PATH);
    assert.ok(written.equals(embedded));
  });
});

// -- T-S5: no \u escapes except <, leak scan catches a planted withheld name --------------------

test('serializeDataIsland: a non-ASCII name stays literal UTF-8, only "<" is escaped as \\u003c (T-S5)', () => {
  const json = serializeDataIsland({ name: 'Zo\u00eb Vantablack', ok: '<script>' });
  assert.ok(json.includes('Zo\u00eb Vantablack'));
  assert.doesNotMatch(json, /\\u(?!003c)[0-9a-fA-F]{4}/);
  assert.match(json, /\\u003c/);
});

test('serializeDataIsland: leak scan catches a planted withheld name inside the island (T-S5)', () => {
  withTmpDir((dir) => {
    const island = serializeDataIsland({ items: [{ name: 'Zo\u00eb Vantablack' }] });
    const html = `<html><body><script type="application/json">${island}</script></body></html>`;
    fs.writeFileSync(path.join(dir, 'x.html'), html);
    const findings = scanOutputTree({
      outDir: dir,
      campaign: 't',
      withheld: [{ entity: { relPath: 'x.md' }, hiddenNames: ['Zo\u00eb Vantablack'] }],
    });
    const l4 = findings.filter((f) => f.id === 'leak/l4-output-name');
    assert.equal(l4.length, 1);
  });
});

// -- T-S6: </script> inside a value cannot close the island ---------------------------------------

test('serializeDataIsland: a literal "</script>" inside a value cannot close the island (T-S6)', () => {
  const json = serializeDataIsland({ x: 'end it here </script><script>alert(1)</script>' });
  assert.ok(!json.includes('</script>'));
  assert.ok(json.includes('\\u003c/script>'));
});
