'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { REDACTIONS, applyRedactions, redactionReport } = require('../src/generator/redactions');
const { MARKERS, PIN_SCAN_BASELINE, scanPinTree, scanBuffer, assertNoRulesContent } = require('../scripts/content-markers');
const { buildNoticesText } = require('../scripts/generate-notices');
const { ScriptoriumError } = require('../src/util/errors');

const PIN = require('../vendor/gm-apprentice-publish/PIN.json');
const GENERATOR_DIR = path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// -- AC-R2: registry entries are anchored to the pin and to their markers --

test('every REDACTIONS entry names a pinPath that is a key of PIN.json.files', () => {
  for (const entry of REDACTIONS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PIN.files, entry.pinPath),
      `${entry.id}: pinPath "${entry.pinPath}" is not a key of PIN.json.files`,
    );
  }
});

test('every REDACTIONS entry\'s expectedSha256 equals PIN.files[pinPath]', () => {
  for (const entry of REDACTIONS) {
    assert.equal(
      entry.expectedSha256,
      PIN.files[entry.pinPath],
      `${entry.id}: expectedSha256 drifted from PIN.json.files["${entry.pinPath}"]; re-read the file`,
    );
  }
});

test('every REDACTIONS entry\'s expectedSha256 matches the file actually installed on disk', () => {
  for (const entry of REDACTIONS) {
    const installed = path.join(GENERATOR_DIR, ...entry.pinPath.split('/'));
    assert.equal(sha256(installed), entry.expectedSha256, `${entry.id}: installed file hash mismatch`);
  }
});

test('positive control: the installed file for every REDACTIONS entry still contains every one of its markers', () => {
  for (const entry of REDACTIONS) {
    const markerEntry = MARKERS.find((m) => m.id === entry.id);
    assert.ok(markerEntry, `${entry.id}: no matching entry in scripts/content-markers.js MARKERS`);
    assert.equal(markerEntry.pinPath, entry.pinPath, `${entry.id}: MARKERS pinPath does not match REDACTIONS pinPath`);
    const installed = path.join(GENERATOR_DIR, ...entry.pinPath.split('/'));
    const text = fs.readFileSync(installed, 'utf8');
    for (const marker of markerEntry.strings) {
      assert.ok(
        text.includes(marker),
        `${entry.id}: installed ${entry.pinPath} no longer contains marker "${marker}" — the redaction may be targeting the wrong file`,
      );
    }
  }
});

test('every REDACTIONS entry\'s stub export key set equals the real module\'s export key set', () => {
  for (const entry of REDACTIONS) {
    // test-only require of the pinned generator's own module, per the brief's interface spec
    // (this test file, not src/, is allowed to require a generator module directly).
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const real = require(path.join(GENERATOR_DIR, ...entry.pinPath.split('/')));
    const stub = entry.stub();
    assert.deepEqual(
      Object.keys(stub).sort(),
      Object.keys(real).sort(),
      `${entry.id}: stub export keys diverge from the real module's export keys`,
    );
  }
});

// -- AC-R11: notices cannot drift from the registry --

test('buildNoticesText() contains every shipping REDACTIONS entry\'s noticeClaim', () => {
  const text = buildNoticesText();
  for (const entry of REDACTIONS) {
    assert.ok(typeof entry.noticeClaim === 'string' && entry.noticeClaim.length > 0, `${entry.id}: missing noticeClaim`);
    assert.ok(
      text.includes(entry.noticeClaim),
      `${entry.id}: THIRD-PARTY-NOTICES.txt is missing its noticeClaim — deleting a redaction without deleting its notices paragraph`,
    );
  }
});

// -- Structural decision D4: no marker string anywhere in the src/ registry --

test('no REDACTIONS field (reason, noticeClaim, pinPath, specifier, id) contains a marker string', () => {
  for (const entry of REDACTIONS) {
    const haystack = [entry.id, entry.pinPath, entry.specifier, entry.reason, entry.noticeClaim].join('\n');
    for (const markerEntry of MARKERS) {
      for (const marker of markerEntry.strings) {
        assert.ok(!haystack.includes(marker), `${entry.id}: field text contains marker string "${marker}"`);
      }
    }
  }
});

// -- Reviewer red line: no rules-content trademark/citation substring, not just the exact
// MARKERS strings, may appear anywhere under src/ or bin/ (the brief's own verification step 7). --

test('no rules-content trademark/citation substring appears anywhere under src/ or bin/', () => {
  const FORBIDDEN = ['GURPS Basic Set', 'Humanoid Hit Location', 'Cthulhu Mythos', 'Spot Hidden'];
  const offenders = [];
  for (const dirName of ['src', 'bin']) {
    const root = path.join(__dirname, '..', dirName);
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const text = fs.readFileSync(full, 'utf8');
        for (const needle of FORBIDDEN) {
          if (text.includes(needle)) offenders.push(`${path.relative(path.join(__dirname, '..'), full)}: "${needle}"`);
        }
      }
    })(root);
  }
  assert.deepEqual(offenders, []);
});

// -- AC-R1 / ordering trap: applyRedactions() throws rather than no-ops --

test('applyRedactions() seeds require.cache for every entry\'s specifier and reports zero calls before any use', () => {
  for (const entry of REDACTIONS) {
    delete require.cache[require.resolve(entry.specifier)];
  }
  const applied = applyRedactions();
  assert.deepEqual(
    applied,
    REDACTIONS.map((e) => ({ id: e.id, applied: true })),
  );
  assert.deepEqual(
    redactionReport(),
    REDACTIONS.map((e) => ({ id: e.id, calls: 0 })),
  );
  for (const entry of REDACTIONS) {
    assert.ok(require.cache[require.resolve(entry.specifier)], `${entry.id}: not seeded into require.cache`);
  }
});

test('applyRedactions() throws ScriptoriumError, not a warning, when the target is already cached by something else', () => {
  const entry = REDACTIONS[0];
  const resolvedId = require.resolve(entry.specifier);
  delete require.cache[resolvedId];
  // Simulate the ordering trap: something else (not applyRedactions) loaded the real module first.
  require(entry.specifier); // eslint-disable-line global-require, import/no-dynamic-require
  assert.throws(
    () => applyRedactions(),
    (err) => {
      assert.ok(err instanceof ScriptoriumError, 'must throw ScriptoriumError, not a plain Error');
      assert.match(err.message, /already in require\.cache/);
      return true;
    },
  );
  delete require.cache[resolvedId];
});

test('applyRedactions() is idempotent across repeated calls in the same process (re-seeds its own earlier stub)', () => {
  for (const entry of REDACTIONS) {
    delete require.cache[require.resolve(entry.specifier)];
  }
  assert.doesNotThrow(() => applyRedactions());
  assert.doesNotThrow(() => applyRedactions());
});

test('applyRedactions() throws ScriptoriumError when a specifier cannot resolve', () => {
  const entry = REDACTIONS[0];
  const originalSpecifier = entry.specifier;
  entry.specifier = 'gm-apprentice-publish/lib/templates/does-not-exist.js';
  try {
    assert.throws(
      () => applyRedactions(),
      (err) => {
        assert.ok(err instanceof ScriptoriumError, 'must throw ScriptoriumError, not a plain Error');
        assert.match(err.message, /could not resolve/);
        return true;
      },
    );
  } finally {
    entry.specifier = originalSpecifier;
    delete require.cache[require.resolve(entry.specifier)];
  }
});

// -- D6a: the redacted files' sha256 pin in scripts/content-markers.js MARKERS lines up with the pin --

test('MARKERS entries name exactly the same two pinPaths as REDACTIONS, in the same order', () => {
  assert.deepEqual(
    MARKERS.map((m) => m.pinPath),
    REDACTIONS.map((e) => e.pinPath),
  );
});

// -- AC-R8 (unit level): scanBuffer/assertNoRulesContent's own logic, exercised against small
// temp files rather than a real pkg build. The real ship gate (scripts/package.js) is proven
// against a real packaged binary by the AC-R6/AC-R7/AC-R8 spike recorded in the Engineer report
// and docs/decisions/0007-rules-content-redaction.md; that spike is not repeated on every
// `npm test` run because it invokes @yao-pkg/pkg and takes seconds, not milliseconds. --

test('scanBuffer finds a marker written in latin1 bytes', () => {
  const buf = Buffer.from(`noise before ${MARKERS[0].strings[0]} noise after`, 'latin1');
  assert.deepEqual(scanBuffer(buf), [MARKERS[0].strings[0]]);
});

test('scanBuffer finds a marker written in utf16le bytes', () => {
  const buf = Buffer.from(MARKERS[1].strings[0], 'utf16le');
  assert.deepEqual(scanBuffer(buf), [MARKERS[1].strings[0]]);
});

test('scanBuffer finds nothing in a buffer with no marker text', () => {
  const buf = Buffer.from('nothing to see here', 'latin1');
  assert.deepEqual(scanBuffer(buf), []);
});

test('assertNoRulesContent reports ok:false with file+marker hits, and ok:true when clean', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-marker-scan-'));
  try {
    const dirty = path.join(dir, 'dirty.bin');
    const clean = path.join(dir, 'clean.bin');
    fs.writeFileSync(dirty, Buffer.from(`x${MARKERS[0].strings[0]}x`, 'latin1'));
    fs.writeFileSync(clean, Buffer.from('nothing here', 'latin1'));

    const dirtyResult = assertNoRulesContent([dirty]);
    assert.equal(dirtyResult.ok, false);
    assert.deepEqual(dirtyResult.hits, [{ file: dirty, marker: MARKERS[0].strings[0] }]);

    const cleanResult = assertNoRulesContent([clean]);
    assert.equal(cleanResult.ok, true);
    assert.deepEqual(cleanResult.hits, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -- D6b: the heuristic pin-tree scanner reproduces the committed baseline exactly --

test('scanPinTree() over the installed pin reproduces PIN_SCAN_BASELINE exactly', () => {
  const actual = scanPinTree(GENERATOR_DIR);
  const expected = PIN_SCAN_BASELINE.map(({ pinPath, line }) => ({ pinPath, line }));
  assert.deepEqual(
    actual,
    expected,
    'scanPinTree() drifted from the committed PIN_SCAN_BASELINE — re-derive it (do not pad the baseline) ' +
      'and read every new/changed entry by hand before committing it',
  );
});

test('every PIN_SCAN_BASELINE entry has a non-empty note', () => {
  for (const entry of PIN_SCAN_BASELINE) {
    assert.ok(
      typeof entry.note === 'string' && entry.note.length > 0,
      `${entry.pinPath}:${entry.line} has no judgement note`,
    );
  }
});

// -- AC-R9: a D&D build (no GURPS or CoC page anywhere in the vault) reports zero calls for
// every redaction and prints no extra line, even though the generator's fully-eager require
// graph loads both stub modules regardless of which system(s) a vault actually uses. --

test('a D&D-only build reports zero calls for every redaction and prints no extra human line', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-redaction-dnd-'));
  try {
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const siteConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mini-vault-site-config.json'), 'utf8'));
    delete siteConfig.vaultPath;
    delete siteConfig.outputDir;
    fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(siteConfig, null, 2));

    const outDir = path.join(dir, 'out');
    const configPath = path.join(dir, 'config.toml');
    const toml = [
      'config_version = 1',
      'default_campaign = "fixture"',
      '',
      '[campaigns.fixture]',
      `vault = '${path.join(__dirname, 'fixtures', 'mini-vault')}'`,
      `site_config = '${path.join(siteDir, 'vault.config.json')}'`,
      `output = '${outDir}'`,
    ].join('\n');
    fs.writeFileSync(configPath, toml);

    delete require.cache[require.resolve('../src/cli/build')];
    // eslint-disable-next-line global-require
    const { runBuildCommand } = require('../src/cli/build');
    const result = runBuildCommand({ config: configPath, force: true }, 'fixture');

    assert.equal(result.envelope.ok, true, result.human);
    assert.doesNotMatch(result.human, /rules-content redaction/, 'a D&D build must print nothing extra');
    assert.deepEqual(
      result.envelope.redactions,
      REDACTIONS.map((e) => ({ id: e.id, calls: 0 })),
      'every redaction must report zero calls on a vault with no GURPS or CoC page',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
