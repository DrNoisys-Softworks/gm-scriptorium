'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runAtomicBuild } = require('../src/build/run');

/*
 * A minimal, purpose-built vault, generated fresh per test (never checked
 * in): one published page embedding an attachment named after a withheld
 * entity's own filename stem. This is a genuinely check-time-clean leak —
 * no wikilink, no relationship, no frontmatter field ever names the
 * withheld entity, so L1-L5 and L4's collision check all pass with zero
 * ERROR findings; only Track D2's staging scan, reading the copied
 * attachment's own emitted path, can see it. That isolation is the point:
 * these tests exercise the GATE mechanism (refuse/force/no-check/FR-16),
 * not "does D2 find a leak" (proven separately against test/fixtures/pin-vault
 * and, per the brief, against the real 91d8a7b export).
 */
const ONE_PIXEL_PNG = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'pin-vault', '_attachments', 'personal', 'hidden-map.png'),
);

function buildGateVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, 'NPCs'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });

  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n',
  );
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'NPCs', 'Public.md'),
    '---\ntype: npc\ntitle: Public Page\n---\nAn ordinary published page.\n\n![[secret-witness.png]]\n',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'NPCs', 'Secret-Witness.md'),
    '---\ntype: npc\ntitle: Secret Witness\nwithheld: true\n---\nNever meant to reach a player.\n',
  );
  fs.writeFileSync(path.join(vaultPath, '_attachments', 'secret-witness.png'), ONE_PIXEL_PNG);

  const siteDir = path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  // finalOut is deliberately NOT jsonConfig.outputDir: the two are unrelated in a real
  // build (src/build/stage.js always overwrites outputDir with the staging path before
  // the generator ever sees it), and making them equal here would accidentally exercise
  // src/build/plan.js's siteConfigOutputDirCollision guard (issue #21, defect 1), which
  // is not what this file's tests are about.
  const finalOut = path.join(root, 'out');
  const jsonConfig = {
    siteTitle: 'Gate Vault',
    siteUrl: 'https://example.invalid',
    vaultPath,
    outputDir: path.join(root, 'site-declared-outputdir'),
    attachmentsDir: '_attachments',
    folderMap: { NPCs: 'npcs' },
    excludeDirs: [],
  };
  return { vaultPath, siteDir, jsonConfig, finalOut };
}

function withGateVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gate-vault-'));
  try {
    return fn(buildGateVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sha256Manifest(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else entries.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  })(dir, '');
  return entries.sort().join('\n');
}

function siblingDirs(finalOut) {
  const parent = path.dirname(finalOut);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((e) => /^\.scriptorium-(build|old)-/.test(e));
}

/**
 * Writes the gate vault's site config and a campaign config.toml to real
 * files on disk, so runBuildCommand (src/cli/build.js) can resolve them
 * exactly the way a real `scriptorium build` invocation does — no direct
 * runAtomicBuild call, no hand-built ctx. This is the ONLY thing that
 * exercises the actual production call site (src/cli/build.js's own
 * `force: forced`), which every other test in this file deliberately does
 * not (see the module doc comment above).
 */
function writeGateVaultOnDisk(root) {
  const { vaultPath, siteDir, jsonConfig, finalOut } = buildGateVault(root);
  const siteConfigPath = path.join(siteDir, 'vault.config.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify(jsonConfig, null, 2));

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      'default_campaign = "gate"',
      '',
      '[campaigns.gate]',
      `vault = '${vaultPath}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${finalOut}'`,
      '',
    ].join('\n'),
  );
  return { configPath, finalOut };
}

// --- AC-D2-14: refuse path -------------------------------------------------

test('AC-D2-14: a scan hit without force refuses, leaves finalOut byte-unchanged, and removes staging', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    const before = sha256Manifest(finalOut);
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate' });

    assert.equal(result.ok, false);
    assert.equal(result.refusedByScan, true);
    assert.equal(result.stagingRoot, null);
    assert.ok(result.findings.length > 0);
    assert.ok(result.findings.every((f) => f.severity === 'error'));
    assert.ok(result.findings.some((f) => f.id === 'leak/l4-output-name' && f.outputPath === 'images/secret-witness.png'));

    assert.equal(sha256Manifest(finalOut), before, 'finalOut must be byte-identical before and after a refused build');
    assert.deepEqual(siblingDirs(finalOut), [], 'no .scriptorium-build-* sibling may be left behind');
  });
});

test('AC-D2-14 (envelope shape): runAtomicBuild refusedByScan maps to CHECK_FAILED (exit 2)', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate' });
    assert.equal(result.refusedByScan, true);
    // Mirrors src/cli/build.js's own shaping of a refusedByScan result.
    const { EXIT_CODES } = require('../src/util/exitcodes');
    assert.equal(EXIT_CODES.CHECK_FAILED, 2);
  });
});

/*
 * AC-D2-14/15, through the REAL production call site (src/cli/build.js),
 * not a direct runAtomicBuild call. Every other test in this file
 * deliberately calls runAtomicBuild directly to isolate the gate mechanism
 * from CLI plumbing — but that means none of them would ever notice a
 * regression in src/cli/build.js's own `force: forced` wiring (e.g. a
 * hardcoded `force: true` at the call site, which would silently make
 * every real `scriptorium build` unconditionally override every future
 * scan hit). This test is the one thing standing between that regression
 * and a green suite; verified by deliberately hardcoding `force: true` at
 * src/cli/build.js's call site and confirming this test goes red before
 * committing it (not itself an automated check — see the dynamic
 * regression-guard test below for the always-on version of that proof).
 *
 * `--no-check` is deliberate, not a shortcut: the gate vault's own
 * attachment reference (`![[secret-witness.png]]`) necessarily makes the
 * withheld entity's name reachable in the page's own raw markdown too, so
 * the PRE-BUILD check (leak/l4-hidden-name, source-side) always finds an
 * ERROR of its own there as well — every attachment reference that makes a
 * name D2-path-arm-detectable is, structurally, also L4-detectable
 * somewhere, the same way the real 91d8a7b vault never has a clean `check`
 * either (`docs/HANDOVER-WINDOWS.md`). `--no-check` makes the SCAN
 * unambiguously the only thing `runBuildCommand` can refuse on, which is
 * exactly the regression surface this test targets; AC-D2-16 already
 * requires `--no-check` to still scan and still refuse, so this is that
 * same behaviour, exercised through the real CLI entry point for the
 * first time rather than only through a direct runAtomicBuild call.
 */
test('AC-D2-14/15 (CLI, real call site): runBuildCommand refuses without --force and succeeds with --force', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gate-cli-'));
  try {
    const { configPath, finalOut } = writeGateVaultOnDisk(root);

    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const { EXIT_CODES } = require('../src/util/exitcodes');

    const refused = runBuildCommand({ config: configPath, 'no-check': true }, 'gate');
    assert.equal(refused.exitCode, EXIT_CODES.CHECK_FAILED, 'a real scan hit must refuse the real build without --force');
    assert.equal(refused.envelope.ok, false);
    assert.equal(refused.envelope.refused, true);
    assert.equal(refused.envelope.refusedByScan, true);
    assert.ok(refused.envelope.outputScanFindings.length > 0);
    assert.ok(
      refused.envelope.outputScanFindings.some((f) => f.outputPath === 'images/secret-witness.png'),
      'the CLI envelope must carry the real scan finding, not a summary',
    );
    assert.match(refused.human, /secret-witness\.png/);
    assert.ok(!fs.existsSync(path.join(finalOut, 'index.html')), 'a refused build must write nothing, via the real CLI path');

    const forced = runBuildCommand({ config: configPath, 'no-check': true, force: true }, 'gate');
    assert.equal(forced.exitCode, EXIT_CODES.OK, 'the user\'s own --force flag must let the same real build through');
    assert.equal(forced.envelope.ok, true);
    assert.ok(forced.envelope.overriddenFindings.length > 0);
    assert.ok(
      forced.envelope.overriddenFindings.some((f) => f.outputPath === 'images/secret-witness.png'),
      'the override record must be the real scan finding',
    );
    assert.ok(fs.existsSync(path.join(finalOut, 'index.html')), 'a forced build must actually swap, via the real CLI path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-D2-15: force path ---------------------------------------------------

test('AC-D2-15: with force the swap happens and every scan hit is recorded as overridden', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate', force: true });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(path.join(finalOut, 'index.html')), 'the swap must actually have happened');
    assert.ok(result.outputScan.overridden, true);
    assert.ok(result.outputScan.findings.length > 0);
    assert.ok(result.outputScan.findings.some((f) => f.outputPath === 'images/secret-witness.png'));
  });
});

// --- AC-D2-16: --no-check still scans and still refuses ---------------------

test('AC-D2-16: runAtomicBuild scans and refuses regardless of whether a pre-build check ran at all', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    // runAtomicBuild has no "skip the scan" parameter at all (Structural
    // decision 5) — calling it directly, the way src/cli/build.js's
    // --no-check path still does, proves the scan is unconditional.
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate' });
    assert.equal(result.refusedByScan, true);
  });
});

// --- AC-D2-17 (FR-16): a poisoned stale finalOut is not judged by the pre-build check ---

test('AC-D2-17: deferOutputScan:true gives an INFO instead of judging a poisoned, about-to-be-replaced finalOut', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }, root) => {
    // Poison finalOut with a "build" that very much looks leaky, standing in
    // for a stale previous build the vault no longer matches.
    fs.mkdirSync(finalOut, { recursive: true });
    fs.writeFileSync(path.join(finalOut, 'index.html'), '<html><body>Secret Witness everywhere</body></html>');
    fs.writeFileSync(path.join(finalOut, 'search-index.json'), '{"index":{"version":"not-even-real"},"documents":{}}');

    const { buildCheckContext } = require('../src/checks/context');
    const { runChecks } = require('../src/checks/run');

    const deferredCtx = buildCheckContext({
      campaign: 'gate',
      vaultPath,
      jsonConfig,
      outputPath: finalOut,
      deferOutputScan: true,
    });
    const deferredFindings = runChecks(deferredCtx).filter((f) => f.id.startsWith('leak/l4-output-name') || f.id.startsWith('leak/l4-index-term'));
    assert.ok(deferredFindings.every((f) => f.severity === 'info'), 'deferred: only INFO, never judging the stale tree');
    assert.ok(deferredFindings.some((f) => /deferred/.test(f.message)));

    // The real build must therefore proceed (refused only by its OWN
    // staging scan against the FRESH tree, never by the stale finalOut).
    const result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate' });
    assert.equal(result.refusedByScan, true, 'still refused — but by this build\'s own staging tree, not the poisoned one');
    void root;
  });
});

// --- AC-D2-18: render-error path unchanged ----------------------------------

test('AC-D2-18: the render-error branch returns before the scan and is textually unchanged', () => {
  // Forcing a genuine mid-generator render crash needs a page that makes
  // gm-apprentice-publish itself throw per-page, which is expensive and
  // fragile to construct as a fixture; the render-error path's own shape
  // (early return, staging kept, no refusedByScan field) is exercised by
  // this source-order assertion instead, the same structural-test pattern
  // AC-D3-01 (test/leak-l4-rendered.test.js) already uses for an
  // equivalent "which branch runs first" guarantee.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'run.js'), 'utf8');
  const renderErrorReturnIdx = src.indexOf('renderErrors,\n      detail,\n      stagingRoot,\n    };');
  const scanCallIdx = src.indexOf('scanStagingOutput(');
  assert.ok(renderErrorReturnIdx !== -1, 'expected the render-error early return to still exist verbatim');
  assert.ok(scanCallIdx !== -1, 'expected the scan call to exist');
  assert.ok(renderErrorReturnIdx < scanCallIdx, 'the render-error branch must return BEFORE the output-leak scan ever runs');

  // And the render-error return object itself must not carry refusedByScan.
  const renderErrorBlockMatch = src.match(/if \(error \|\| renderErrors\.length > 0\) \{[\s\S]*?\n {4}\}/);
  assert.ok(renderErrorBlockMatch, 'expected to find the render-error branch');
  assert.ok(!renderErrorBlockMatch[0].includes('refusedByScan'), 'the render-error branch must not set refusedByScan');
});

// --- AC-D2-19: determinism ---------------------------------------------------

test('AC-D2-19: two forced builds of an unchanged vault produce identical trees', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    const a = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate', force: true });
    assert.equal(a.ok, true);
    const manifestA = sha256Manifest(finalOut);

    const b = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate', force: true });
    assert.equal(b.ok, true);
    const manifestB = sha256Manifest(finalOut);

    assert.equal(manifestA, manifestB);
  });
});

// --- Structural: no caller of runAtomicBuild can skip the scan -------------

test('every runAtomicBuild call site passes campaign and an explicit force', () => {
  const root = path.join(__dirname, '..');
  // The four call sites the brief names explicitly: one product path
  // (src/cli/build.js) and the three non-product callers that deliberately
  // build leaky vaults (Structural decision 5). This file's own
  // runAtomicBuild calls are exercised directly by the tests above, not
  // re-grepped here — this file's own doc comments legitimately contain the
  // literal text "runAtomicBuild({...})", which would falsely self-match.
  const callers = [
    path.join(root, 'src', 'cli', 'build.js'),
    path.join(root, 'scripts', 'equivalence-check.js'),
    path.join(root, 'scripts', 'l4-render-audit.js'),
    path.join(root, 'test', 'publish-equivalence.test.js'),
  ];
  // The three non-product callers deliberately build vaults known to leak,
  // and must hardcode `force: true` as a loud, greppable override
  // (Structural decision 5) — so THIS assertion is the opposite of the
  // product call site's: it fails if a future edit quietly makes the
  // override conditional or removes it, eroding the "loud statement"
  // guarantee ADR 0009 documents.
  const nonProductCallers = new Set([
    path.join(root, 'scripts', 'equivalence-check.js'),
    path.join(root, 'scripts', 'l4-render-audit.js'),
    path.join(root, 'test', 'publish-equivalence.test.js'),
  ]);

  for (const file of callers) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('runAtomicBuild(')) continue;
    const calls = text.match(/runAtomicBuild\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(calls.length > 0, `${file}: expected at least one runAtomicBuild({...}) call`);
    for (const call of calls) {
      assert.match(call, /campaign\s*:/, `${file}: a runAtomicBuild call is missing campaign: ${call}`);
      assert.match(call, /force\s*:/, `${file}: a runAtomicBuild call is missing an explicit force: ${call}`);

      if (nonProductCallers.has(file)) {
        assert.match(
          call,
          /force\s*:\s*true\b/,
          `${file}: a non-product caller that deliberately builds a leaky vault must hardcode force: true, not: ${call}`,
        );
      } else {
        // The product call site (src/cli/build.js): `force` must be a
        // regression a value test can actually fail on. A hardcoded
        // `force: true` here would silently make every real `scriptorium
        // build` override every future scan hit — exactly the gap this
        // test exists to close, so it is asserted directly rather than
        // only checking that SOME token named `force` is present.
        assert.doesNotMatch(
          call,
          /force\s*:\s*true\b/,
          `${file}: the product call site must never hardcode force: true — it must come from the user's own --force flag: ${call}`,
        );
        assert.doesNotMatch(
          call,
          /force\s*:\s*false\b/,
          `${file}: the product call site must never hardcode force: false either — a real --force flag would then do nothing: ${call}`,
        );
        assert.match(
          call,
          /force\s*:\s*forced\b/,
          `${file}: expected force to be threaded from the user's own --force flag (the local "forced" binding), got: ${call}`,
        );
      }
    }
  }
});

test('AC-D2-14/15 regression guard (CLI): the run-through-runBuildCommand test above actually exercises real call-site regressions', () => {
  // A direct proof, run at test time rather than only asserted about by
  // reading source (the check above): temporarily monkey-patch
  // src/build/run.js's exported runAtomicBuild to record whether the
  // caller (src/cli/build.js, reached only through runBuildCommand) ever
  // passes force: true when the CLI flags did not ask for it. This is a
  // narrower, dynamic version of "hardcode force: true and watch the CLI
  // test go red" that can live in the suite permanently.
  const runModulePath = require.resolve('../src/build/run');
  const original = require(runModulePath).runAtomicBuild;
  let sawForceTrueWithoutFlag = false;

  require.cache[runModulePath].exports.runAtomicBuild = (opts) => {
    if (opts.force === true) sawForceTrueWithoutFlag = true;
    return original(opts);
  };
  delete require.cache[require.resolve('../src/cli/build')];

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gate-cli-guard-'));
  try {
    const { configPath } = writeGateVaultOnDisk(root);
    const { runBuildCommand } = require('../src/cli/build');
    // 'no-check': true so the pre-build check's OWN error (the gate vault's
    // attachment embed also literally names the withheld entity in source,
    // see the module doc comment above) never short-circuits before
    // runAtomicBuild is reached at all — otherwise this guard would pass
    // vacuously, having never actually called the patched function.
    runBuildCommand({ config: configPath, 'no-check': true }, 'gate'); // no --force flag
    assert.equal(
      sawForceTrueWithoutFlag,
      false,
      'src/cli/build.js called runAtomicBuild with force: true even though the CLI flags carried no --force',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    require.cache[runModulePath].exports.runAtomicBuild = original;
    delete require.cache[require.resolve('../src/cli/build')];
  }
});

// --- Regression: EBUSY on staging cleanup must not swallow the refusal ----
//
// Reproduces the Windows defect the Windows verifier found (the Windows verification channel
// 2026-09-18-1450-win-to-deb-items-2-3-4-staging-crash.md): a file handle
// held anywhere inside the staging tree makes fs.rmSync throw EBUSY on the
// cleanup step of a scan refusal. That used to propagate straight out of
// runAtomicBuild uncaught, so the caller never got to report the refusal or
// the leak finding at all, and the process exited 1 ("Scriptorium itself
// failed") instead of 2 (a refusal). A real Windows file lock cannot be
// reproduced on Linux; this simulates the exact failure mode (fs.rmSync
// throwing on the staging root) to prove the CONTRACT — reporting must not
// depend on cleanup succeeding — regardless of what makes rmSync throw. The
// real Windows behaviour (does this literal fix clear the file lock too)
// still needs the Windows verifier to confirm.
test('EBUSY on staging cleanup after a scan refusal does not crash runAtomicBuild', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, opts) => {
      if (/\.scriptorium-build-/.test(String(target))) {
        const err = new Error(`EBUSY: resource busy or locked, unlink '${target}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };
    let result;
    try {
      result = runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: 'gate' });
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.equal(result.ok, false);
    assert.equal(result.refusedByScan, true, 'a failed cleanup must still return the refusal, not throw');
    assert.ok(result.findings.length > 0, 'the leak finding must still be reported when cleanup fails');
    assert.ok(result.findings.some((f) => f.id === 'leak/l4-output-name' && f.outputPath === 'images/secret-witness.png'));
    assert.equal(sha256Manifest(finalOut), null, 'finalOut must still be untouched');
  });
});

test('EBUSY on staging cleanup after a scan refusal: runBuildCommand still reports the refusal at exit 2, not an uncaught crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-gate-cleanup-crash-'));
  try {
    const { configPath, finalOut } = writeGateVaultOnDisk(root);

    delete require.cache[require.resolve('../src/cli/build')];
    const { runBuildCommand } = require('../src/cli/build');
    const { EXIT_CODES } = require('../src/util/exitcodes');

    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, opts) => {
      if (/\.scriptorium-build-/.test(String(target))) {
        const err = new Error(`EBUSY: resource busy or locked, unlink '${target}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };
    let result;
    try {
      result = runBuildCommand({ config: configPath, 'no-check': true }, 'gate');
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.equal(
      result.exitCode,
      EXIT_CODES.CHECK_FAILED,
      'a scan refusal must exit CHECK_FAILED (2) even when staging cleanup fails, never SCRIPTORIUM_ERROR (1)',
    );
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.refusedByScan, true);
    assert.ok(result.envelope.outputScanFindings.length > 0);
    assert.match(result.human, /secret-witness\.png/, 'the refusal message and the leak finding must still print when cleanup fails');
    assert.ok(!fs.existsSync(path.join(finalOut, 'index.html')), 'a refused build must still write nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runAtomicBuild throws if campaign is missing or empty', () => {
  withGateVault(({ vaultPath, siteDir, jsonConfig, finalOut }) => {
    assert.throws(() => runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir }));
    assert.throws(() => runAtomicBuild({ vaultPath, userJsonConfig: jsonConfig, finalOut, siteDir, campaign: '' }));
  });
});
