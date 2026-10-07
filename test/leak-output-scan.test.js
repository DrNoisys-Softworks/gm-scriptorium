'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normaliseEmitted,
  needleFormsFor,
  scanOutputTree,
  runOutputName,
} = require('../src/checks/leak/outputscan');

// --- AC-D2-01: normaliseEmitted -------------------------------------------

test('AC-D2-01: decodes named HTML entities', () => {
  assert.equal(normaliseEmitted('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(normaliseEmitted('a &lt; b'), 'a < b');
  assert.equal(normaliseEmitted('a &gt; b'), 'a > b');
  assert.equal(normaliseEmitted('&quot;quoted&quot;'), '"quoted"');
  assert.equal(normaliseEmitted('&#39;curly-ish&#39;'), "'curly-ish'");
  assert.equal(normaliseEmitted('&#x27;hex apostrophe&#x27;'), "'hex apostrophe'");
});

test('AC-D2-01: single-pass decode — "&amp;lt;" must never become "<"', () => {
  // A naive two-pass (decode, then decode again) would turn the entity form
  // "&amp;lt;" into "&lt;" on pass one, then "<" on a second pass. One
  // regex.replace call decodes "&amp;" to "&" and leaves the adjacent "lt;"
  // as plain text — the whole match is consumed in a single pass, so the
  // result must be the literal string "&lt;", not "<".
  assert.equal(normaliseEmitted('&amp;lt;'), '&lt;');
  assert.notEqual(normaliseEmitted('&amp;lt;'), '<');
});

test('AC-D2-01: folds markdown-it typographer substitutions back to source characters', () => {
  assert.equal(normaliseEmitted('D’Arcy'), "D'Arcy"); // ’ -> '
  assert.equal(normaliseEmitted('‘quoted’'), "'quoted'"); // ‘ ’ -> '
  assert.equal(normaliseEmitted('“quoted”'), '"quoted"'); // “ ” -> "
  assert.equal(normaliseEmitted('en–dash'), 'en--dash'); // – -> --
  assert.equal(normaliseEmitted('em—dash'), 'em---dash'); // — -> ---
  assert.equal(normaliseEmitted('wait…'), 'wait...'); // … -> ...
});

test('AC-D2-01: a name with \' rendered as ’ in prose but left as \' in an escaped field on the same page', () => {
  const page = 'Prose says D’Arcy Mallow. A field says D\'Arcy Mallow.';
  const normalised = normaliseEmitted(page);
  assert.equal((normalised.match(/D'Arcy Mallow/g) || []).length, 2, 'both forms must normalise to the same literal needle');
});

test('AC-D2-01: NFD source form appearing NFC in output still normalises to one form', () => {
  const nfd = 'González'; // "González" as base + combining acute
  const nfc = 'González';
  assert.equal(normaliseEmitted(nfd), normaliseEmitted(nfc));
});

test('AC-D2-01: mixed escaped + typographer forms on one page all normalise identically', () => {
  const variants = ['D&#39;Arcy Mallow', 'D’Arcy Mallow', "D'Arcy Mallow", 'D&apos;Arcy Mallow'];
  const normalisedForms = new Set(variants.map((v) => normaliseEmitted(v)));
  assert.equal(normalisedForms.size, 1, `all forms must normalise identically: ${[...normalisedForms].join(' | ')}`);
});

// --- AC-D2-02: needleFormsFor ---------------------------------------------

test('AC-D2-02: a name over 15 graphemes gets a truncated-label form matching truncateGraphemes(name, 15, 13)', () => {
  const pinned = require('../src/generator/pinned');
  const name = 'Evangelista-Thornwood'; // 21 graphemes
  const forms = needleFormsFor(name);
  const truncated = forms.find((f) => f.form === 'truncated-label');
  assert.ok(truncated, 'expected a truncated-label form for a name over 15 graphemes');
  // The needle is the truncated form folded the same way normaliseEmitted
  // folds a haystack's typographer "…" — see outputscan.js's needleFormsFor
  // comment for why the pin's own truncateGraphemes ellipsis must agree
  // with normaliseEmitted's ellipsis fold, not the raw truncateGraphemes output.
  assert.equal(pinned.truncateGraphemes(name, 15, 13), 'Evangelista-T…');
  assert.equal(truncated.needle, 'Evangelista-T...');
});

test('AC-D2-02: a name at or under 15 graphemes gets no truncated-label form', () => {
  const forms = needleFormsFor('Short Name');
  assert.ok(!forms.some((f) => f.form === 'truncated-label'));
});

test('AC-D2-02: a name containing "_" gets an underscored form, de-underscored to a space', () => {
  const forms = needleFormsFor('Rurik_Hollow');
  const underscored = forms.find((f) => f.form === 'underscored');
  assert.ok(underscored);
  assert.equal(underscored.needle, 'Rurik Hollow');
});

test('AC-D2-02: a name with no "_" gets no underscored form', () => {
  const forms = needleFormsFor('Plain Name');
  assert.ok(!forms.some((f) => f.form === 'underscored'));
});

// --- Traversal + fixture helpers ------------------------------------------

function withScratchOutDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-outputscan-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (Buffer.isBuffer(content)) fs.writeFileSync(full, content);
      else fs.writeFileSync(full, content, 'utf8');
    }
    // build() always writes index.html last; scanOutputTree itself does not
    // care, but keep the fixture honest about what a real build looks like.
    if (!files['index.html']) fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mkRow(relPath, hiddenNames) {
  return { entity: { relPath }, candidateNames: hiddenNames, hiddenNames, collisions: [] };
}

// --- AC-D2-03: word boundaries reused from l4.js --------------------------

test('AC-D2-03: a substring hit inside a longer word gives no finding (whole-word semantics, not reimplemented)', () => {
  withScratchOutDir(
    {
      'page.html': '<p>Tanmoratown is not Tanmora.</p>', // "Tanmora" is a real whole-word hit; "Tanmoratown" must not be
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Tanmora.md', ['Tanmora'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1, 'exactly one whole-word hit, not two');
      assert.equal(findings[0].outputPath, 'page.html');
    },
  );
});

// --- AC-D2-04: binary skipped, text extensions scanned, deterministic order ---

test('AC-D2-04: binary extensions are skipped entirely for the content arms', () => {
  withScratchOutDir(
    {
      'images/hidden.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), // not valid utf8 text
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret'])];
      // Must not throw trying to read/interpret binary bytes as utf8 text,
      // and must produce no text/href finding (no textual "Secret" anywhere).
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.deepEqual(findings, []);
    },
  );
});

test('AC-D2-04: a binary attachment\'s own filename still fires the path arm (binary skips content, not the path)', () => {
  withScratchOutDir(
    {
      'images/secret-portrait.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret-Portrait.md', ['Secret-Portrait'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].outputPath, 'images/secret-portrait.png');
      assert.equal(findings[0].data.arm, 'path');
    },
  );
});

test('AC-D2-04: .svg, .json, .js, .css and .txt are all scanned as text', () => {
  withScratchOutDir(
    {
      'graph.svg': '<svg><text>Secret Name</text></svg>',
      'data.json': '{"note":"Secret Name"}',
      'js/app.js': '// Secret Name appears here too',
      'css/style.css': '/* Secret Name in a comment, still text */',
      'notes.txt': 'Secret Name plain text',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      const hitPaths = findings.map((f) => f.outputPath).sort();
      assert.deepEqual(hitPaths, ['css/style.css', 'data.json', 'graph.svg', 'js/app.js', 'notes.txt'].sort());
    },
  );
});

test('AC-D2-04: generator static assets (js/lunr.js, theme CSS) are scanned like any other file, not excluded', () => {
  withScratchOutDir(
    {
      'js/lunr.js': '// lunr 2.3.9 — Secret Name should still be caught if present',
      'css/theme.css': '/* Secret Name */',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      const hitPaths = findings.map((f) => f.outputPath).sort();
      assert.deepEqual(hitPaths, ['css/theme.css', 'js/lunr.js']);
    },
  );
});

test('AC-D2-04: two scans of one tree give an identically ordered finding list (read.walkVault determinism)', () => {
  withScratchOutDir(
    {
      'b/page.html': '<p>Secret Name here.</p>',
      'a/page.html': '<p>Secret Name here too.</p>',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
      const first = scanOutputTree({ outDir, campaign: 'unit', withheld });
      const second = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.deepEqual(first, second);
    },
  );
});

// --- Arm precedence and matchedForm classification ------------------------

test('arm precedence: a text hit wins over an href/path hit on the same file', () => {
  withScratchOutDir(
    {
      'page.html': '<a href="images/secret.png">Secret Name is right here in the text too.</a>',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].data.arm, 'text');
    },
  );
});

test('href arm: a percent-encoded href (%20, %28, %29) still matches after per-segment decode', () => {
  withScratchOutDir(
    {
      'page.html': '<a href="characters/npcs/secret%20name%20%28alt%29.html">elsewhere</a>',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['secret name (alt)'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].data.arm, 'href');
    },
  );
});

test('href arm: an entity-escaped href ("&amp;" in the attribute value) still matches after entity decode', () => {
  withScratchOutDir(
    {
      'page.html': '<a href="items/tea%20&amp;%20biscuits.html">elsewhere</a>',
    },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['tea & biscuits'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].data.arm, 'href');
    },
  );
});

test('matchedForm "literal": a raw, unescaped, un-normalised occurrence', () => {
  withScratchOutDir({ 'page.html': '<p>Secret Name is right here.</p>' }, (outDir) => {
    const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
    const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
    assert.equal(findings[0].data.matchedForm, 'literal');
    assert.equal(findings[0].data.rawContains, true);
  });
});

test('matchedForm "normalised": only reachable after entity-decode + typographer-fold, not in raw bytes', () => {
  withScratchOutDir({ 'page.html': '<p>D’Arcy Mallow vanished.</p>' }, (outDir) => {
    const withheld = [mkRow('Hidden/Typo.md', ["D'Arcy Mallow"])];
    const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.matchedForm, 'normalised');
    assert.equal(findings[0].data.rawContains, false, 'the raw bytes carry the curly apostrophe, not the straight one — a plain grep for the straight form would miss it');
  });
});

test('matchedForm "truncated-label": a name over 15 graphemes reachable ONLY in its SVG-truncated form', () => {
  // Isolated from any literal occurrence elsewhere on the page — this is
  // exactly the gap the Architect named as invisible in the real evidence
  // run (none of Thornhollow's withheld names are long enough to trigger
  // it), so it must be proven by fixture, not by the real vault build.
  withScratchOutDir(
    { 'page.html': '<svg><text>Evangelista-T…</text></svg>' },
    (outDir) => {
      const withheld = [mkRow('Hidden/Evangelista.md', ['Evangelista-Thornwood'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].data.matchedForm, 'truncated-label');
      assert.equal(findings[0].data.rawContains, false, 'the full name never appears whole in the raw bytes');
    },
  );
});

test('matchedForm "underscored": an unpublished target\'s de-underscored graph-node fallback, isolated', () => {
  withScratchOutDir(
    { 'page.html': '<svg><text>Rurik Hollow</text></svg>' },
    (outDir) => {
      const withheld = [mkRow('Hidden/Rurik.md', ['Rurik_Hollow'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].data.matchedForm, 'underscored');
      assert.equal(findings[0].data.rawContains, false, 'the literal underscored filename stem never appears in the raw bytes');
    },
  );
});

// --- Bucket C: a [[Withheld|public alias]] page must stay clean -----------

test('Bucket C: an alias-only occurrence produces no finding — the withheld name never reaches the output at all', () => {
  withScratchOutDir(
    { 'page.html': '<p>Rumor has it the quiet merchant moved on months ago.</p>' },
    (outDir) => {
      const withheld = [mkRow('Hidden/BucketC.md', ['Dashiell Renfrow', 'BucketC-Hidden'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.deepEqual(findings, []);
    },
  );
});

// --- One finding per (outputPath, name) ------------------------------------

test('one finding per (outputPath, name), even when a name appears multiple times on one page', () => {
  withScratchOutDir(
    { 'page.html': '<p>Secret Name. Secret Name again. Secret Name a third time.</p>' },
    (outDir) => {
      const withheld = [mkRow('Hidden/Secret.md', ['Secret Name'])];
      const findings = scanOutputTree({ outDir, campaign: 'unit', withheld });
      assert.equal(findings.length, 1);
    },
  );
});

// --- runOutputName: no-build / deferral INFO contracts ---------------------

test('runOutputName: no output directory at all gives exactly one INFO', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-outputscan-nobuild-'));
  const neverCreated = path.join(dir, 'does-not-exist');
  try {
    const ctx = { campaign: 'unit', outputPath: null, outputPathConfigured: neverCreated, deferOutputScan: false };
    const findings = runOutputName(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /no output directory exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runOutputName: an output directory that exists but was never built into gives a DISTINCT INFO', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-outputscan-nobuild-'));
  const preCreated = path.join(dir, 'out');
  fs.mkdirSync(preCreated);
  try {
    const ctx = { campaign: 'unit', outputPath: null, outputPathConfigured: preCreated, deferOutputScan: false };
    const findings = runOutputName(ctx);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].message, /exists but has no build in it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runOutputName: deferOutputScan gives exactly one INFO and no ERROR, regardless of outputPath', () => {
  const ctx = { campaign: 'unit', outputPath: '/does/not/matter', outputPathConfigured: '/does/not/matter', deferOutputScan: true };
  const findings = runOutputName(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /deferred/);
  assert.ok(!findings.some((f) => f.severity === 'error'));
});

// --- AC-D2-12 (structural half): deferOutputScan is reachable from src/cli/build.js only ---

test('AC-D2-12: deferOutputScan is set to true nowhere except src/cli/build.js, and reaches no CLI flag/config key/env var', () => {
  const path2 = require('path');
  const glob = require('fs');
  const root = path2.join(__dirname, '..');

  function walk(dir, out) {
    for (const entry of glob.readdirSync(dir, { withFileTypes: true })) {
      const full = path2.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full, out);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  }

  const srcFiles = [];
  walk(path2.join(root, 'src'), srcFiles);

  const sitesSettingTrue = srcFiles.filter((f) => glob.readFileSync(f, 'utf8').includes('deferOutputScan: true'));
  assert.deepEqual(
    sitesSettingTrue.map((f) => path2.relative(root, f)),
    ['src/cli/build.js'],
    'deferOutputScan: true must be set in exactly one product file, src/cli/build.js',
  );

  // No flag parser, config schema, or env var reads it.
  for (const dirName of ['cli', 'config']) {
    for (const f of srcFiles.filter((x) => x.includes(`${path2.sep}${dirName}${path2.sep}`))) {
      const text = glob.readFileSync(f, 'utf8');
      assert.ok(!/process\.env\.\w*DEFER/i.test(text), `${f}: must not read an env var for deferOutputScan`);
    }
  }
  const argsSrc = glob.readFileSync(path2.join(root, 'src', 'cli', 'args.js'), 'utf8');
  assert.ok(!/defer/i.test(argsSrc), 'src/cli/args.js must not define a --defer* flag');
});
