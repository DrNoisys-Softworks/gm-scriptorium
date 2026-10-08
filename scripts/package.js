'use strict';

/*
 * Builds a Scriptorium exe with @yao-pkg/pkg and writes a SHA256SUMS file
 * alongside it, in the format src/update/verify.js's parseSha256Sums()
 * expects ("<64-hex>  <filename>", standard `sha256sum` output).
 *
 * DEP-a2, docs/decisions/0005-generator-pin.md ("Packaging findings
 * resolved"): the input is package.json itself, never bin/scriptorium.js
 * and never `-c`/`--config` (pkg rejects package.json input plus -c,
 * node_modules/@yao-pkg/pkg/lib-es5/config.js:560-562). pkg follows
 * package.json's `bin.scriptorium` to bin/scriptorium.js
 * (config.js:532-546), sets its asset-glob base to the repo root, and
 * -- only because the input IS package.json -- actually reads
 * package.json's own `pkg.assets` field (config.js:511-591,
 * index.js:50-57). The old invocation (bin/scriptorium.js as input)
 * silently ignored `pkg.assets` entirely; see PIN.json/asset history in
 * docs/decisions/0005-generator-pin.md and the evidence this replaces at
 * spike/manifests/pin-5779522/release-v0.1.x-verification.txt, retained in the private archive at b5b48b4.
 *
 * This is the single invocation path for both the release build
 * (`npm run package`, default: BOTH win-x64 and linux-x64 -> dist/v<version>/, one combined
 * SHA256SUMS, P5a-FR01/D-12) and, formerly, spike/run-pin-proof.sh's Linux packaging proof, retained in the private archive at b5b48b4
 * (--target/--out overrides, single-target mode). `--debug` output is captured per target and
 * gated through scripts/pkg-assets.js's assertAssetsEmbedded() and
 * scripts/content-markers.js's assertNoRulesContent() before SHA256SUMS is
 * written: on any missing asset, or any rules-content marker found in the
 * produced binary (Track DEP-c/R, docs/decisions/0007-rules-content-redaction.md),
 * every output built so far this run is removed and the process exits 1 (DEP-AC-01/DEP-AC-03).
 *
 * `--no-bytecode --public --public-packages "*"` (docs/decisions/0010-no-bytecode-packaging.md):
 * v0.1.0 through v0.2.0 shipped without these flags, so pkg compiled V8 bytecode for the
 * win-x64 target ON THIS LINUX BUILD HOST. V8's serialised code cache only loads back on a
 * matching V8 build, so the embedded Windows Node rejected it on load, before a single line
 * of Scriptorium code ran -- no published Windows exe has ever started. These three flags are
 * pkg's own fix, verbatim from the error message this defect produced ("Rebuild pkg with
 * --public-packages "*" --public or --sea to avoid bytecode"): they make the packed snapshot
 * carry plain JS instead of a V8 code cache, which cross-compiles cleanly because it is never
 * V8-build-specific. The cost is real and is written down in that ADR: the packaged JS is
 * readable source, not bytecode. `--no-bytecode` alone throws ("no source breaks final
 * executable") for any record pkg would otherwise store as bytecode-only; `--public` and
 * `--public-packages "*"` are what make pkg keep the plain-text fallback for every file
 * instead. A build run after this line still passes through package.json's `pkg.patches`
 * unchanged -- stepPatch fires off `hasPatch(record)`, not off the bytecode flag (proven in
 * that ADR's positive/negative control re-run).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { verifyInstalled } = require('./generator-pin');
const { assertAssetsEmbedded } = require('./pkg-assets');
const { assertNoRulesContent } = require('./content-markers');
const { assertNoticesFresh, NOTICES_PATH } = require('./notices-freshness');
const { verifyTemplateTree } = require('../src/setup/template');
const { planSelfTest, execVersionProbe } = require('./package-selftest');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const pkg = require(PACKAGE_JSON_PATH);

/*
 * P5a-FR01/FR02, D-12: `npm run package` builds BOTH targets by default, into the same
 * dist/v<version>/ directory, with one SHA256SUMS covering both binaries plus the notices
 * file. The Linux asset carries no extension and is named `gm-scriptorium-linux-x64`
 * (D-12). `--target`/`--out` still override to a single target (formerly used by
 * spike/run-pin-proof.sh, retained in the private archive at b5b48b4, and still used by docs/decisions/0007's positive/negative controls), exactly as
 * before 5a: passing either flag switches `run()` into single-target mode.
 */
const TARGETS = [
  { target: 'node22-win-x64', assetName: 'gm-scriptorium-win-x64.exe' },
  { target: 'node22-linux-x64', assetName: 'gm-scriptorium-linux-x64' },
];
const DEFAULT_TARGET = TARGETS[0].target;
const DEFAULT_OUT_DIR = path.join(ROOT, 'dist', `v${pkg.version}`);
const DEFAULT_OUT = path.join(DEFAULT_OUT_DIR, TARGETS[0].assetName);

/*
 * #28: the self-test proxy build's exe used to be a bare file directly under os.tmpdir(),
 * and `--version`'s own side effect of writing THIRD-PARTY-NOTICES.txt beside whatever binary
 * it runs landed in os.tmpdir() too, under a fixed filename -- surviving every run's cleanup
 * (which only ever removed the exe, by name) and getting silently overwritten, not appended
 * to, by the next run. Scoping the proxy build to its own fresh directory makes "remove
 * everything this probe produced" the same operation as "remove the directory", covering the
 * notices file and anything a future self-test step writes beside it, by construction rather
 * than by each addition remembering to extend a cleanup list.
 */
/** @returns {{ dir: string, exePath: string }} a fresh directory under os.tmpdir(), created, plus the proxy exe path inside it. */
function makeProxyBuildDir() {
  const dir = path.join(os.tmpdir(), `scriptorium-package-selftest-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, exePath: path.join(dir, 'scriptorium-linux-x64') };
}

/** The default out path for a single-target override that names `target` but not `out`. */
function defaultOutPathFor(target) {
  const known = TARGETS.find((t) => t.target === target);
  return path.join(DEFAULT_OUT_DIR, known ? known.assetName : `gm-scriptorium-${target}`);
}

// pkg's --debug output can run into several hundred KB on this project
// (729KB observed for a win-x64 build in
// spike/manifests/pin-5779522/release-v0.1.x-verification.txt, retained in the private archive at b5b48b4); give
// execFileSync a generous ceiling well above that.
const DEBUG_MAX_BUFFER = 200 * 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      out.target = argv[++i];
    } else if (arg === '--out') {
      out.out = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * The pkg CLI argv for building `out` for `target`, with package.json as
 * input and no `-c`/`--config`. Exported so test/package-config.test.js can
 * assert its shape without invoking pkg.
 *
 * `--no-bytecode --public --public-packages "*"`: see the file header and
 * docs/decisions/0010-no-bytecode-packaging.md. Without these, pkg compiles
 * V8 bytecode for the target on this (Linux) build host, which the
 * embedded Windows Node rejects at load -- the defect this invocation now
 * avoids for every target, not just win-x64.
 *
 * @param {{ target: string, out: string }} opts
 * @returns {string[]}
 */
function buildInvocation({ target, out }) {
  return [
    path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js'),
    '--debug',
    '--no-bytecode',
    '--public',
    '--public-packages',
    '*',
    '-t',
    target,
    '-o',
    out,
    PACKAGE_JSON_PATH,
  ];
}

/**
 * Runs every one of the six gates (CLAUDE.md's gate table) for ONE target, verifying the
 * generator pin and the embedded-asset gate before trusting the output. P5a-FR01: "all 6
 * gates run per target" -- pin verification and notices freshness do not vary by target, but
 * running them again per target is cheap and keeps every target's build provably gated on
 * its own run, not on an earlier target's already-stale check.
 *
 * Never calls process.exit: failure is reported back to the caller (`run()`, below), which
 * owns deciding what to remove across a whole multi-target build and when to actually exit.
 *
 * @param {{ target: string, outPath: string }} opts
 * @returns {{ ok: true, outPath: string, assetName: string, hash: string } | { ok: false }}
 */
function buildTarget({ target, outPath }) {
  const outDir = path.dirname(outPath);
  const assetName = path.basename(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  // DEP-AC-01: a corrupted/mismatched generator must never make it into a
  // packaged exe. Checked before the pkg build starts, not after.
  const { ok: pinOk, problems } = verifyInstalled();
  if (!pinOk) {
    console.error(`package: refusing to build ${target}, the installed gm-apprentice-publish does not match vendor/gm-apprentice-publish/PIN.json:`);
    for (const p of problems) console.error(`  - ${p}`);
    return { ok: false };
  }

  // The committed THIRD-PARTY-NOTICES.txt is embedded verbatim (pkg.assets); refuse to ship a
  // stale copy of it before spending any time on the pkg build. See scripts/notices-freshness.js.
  const { ok: noticesFresh, detail: noticesDetail } = assertNoticesFresh();
  if (!noticesFresh) {
    console.error(`package: refusing to build ${target}, ${noticesDetail}`);
    return { ok: false };
  }

  // Gate 6 (docs/decisions/0048-new-campaign-vault.md): the new-campaign starter embedded below must
  // match its manifest file for file, with nothing extra on disk. Fails closed: a manifest that
  // cannot be read counts as a failure too.
  try {
    const { problems: starterProblems } = verifyTemplateTree(path.join(ROOT, 'assets', 'vault-template'));
    if (starterProblems.length > 0) {
      console.error(`package: refusing to build ${target}, the starter template in assets/vault-template does not match its manifest:`);
      for (const p of starterProblems) console.error(`  - ${p}`);
      return { ok: false };
    }
  } catch (err) {
    console.error(`package: refusing to build ${target}, the starter template cannot be verified: ${err.message}`);
    return { ok: false };
  }

  let debugText;
  try {
    debugText = execFileSync(process.execPath, buildInvocation({ target, out: outPath }), {
      cwd: ROOT,
      maxBuffer: DEBUG_MAX_BUFFER,
      encoding: 'utf8',
    });
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
  process.stdout.write(debugText);

  // DEP-a2 Finding 2 regression gate: package.json's pkg.assets globs are
  // only honoured when pkg's input is package.json itself. Confirm every
  // expected asset actually landed before this build is trusted.
  const { ok: assetsOk, missing } = assertAssetsEmbedded(debugText, ROOT);
  if (!assetsOk) {
    console.error(`package: refusing to ship ${target}, pkg did not embed every expected asset:`);
    for (const m of missing) console.error(`  - missing: ${m}`);
    fs.rmSync(outPath, { force: true });
    return { ok: false };
  }

  // DEP-c/R ship gate (docs/decisions/0007-rules-content-redaction.md, AC-R8): package.json's
  // pkg.patches erases the two redacted files' bodies before @yao-pkg/pkg reads them for
  // storage (lib-es5/walker.js's hasPatch(record) check, :787-798) -- this fires regardless
  // of the --no-bytecode/--public flags above (re-verified under the new build route,
  // docs/decisions/0010-no-bytecode-packaging.md), so the produced binary should carry none
  // of scripts/content-markers.js's marker strings. Scan the produced binary before trusting
  // it: on any hit, print them, remove the output, and write no SHA256SUMS — mirroring
  // assertAssetsEmbedded's own shape immediately above.
  const { ok: rulesContentOk, hits } = assertNoRulesContent([outPath]);
  if (!rulesContentOk) {
    console.error(`package: refusing to ship ${target}, the packaged binary contains rules-content marker(s):`);
    for (const h of hits) console.error(`  - ${h.file}: "${h.marker}"`);
    fs.rmSync(outPath, { force: true });
    return { ok: false };
  }

  // Startup self-test (docs/decisions/0010-no-bytecode-packaging.md): the hole this whole
  // fix closes. Every prior gate inspects the artefact; none of them ever ran it, which is
  // exactly how v0.1.0 through v0.2.0 shipped Windows exes that threw inside pkg's own
  // bootstrap before any Scriptorium code ran. A win-x64 binary cannot be executed on this
  // Linux box at all (no wine; docs/decisions/0001-packager.md), so this proves what is
  // actually provable from here: that the exact same invocation (same pkg flags, same
  // pkg.patches) produces something that starts on this host. P5a-FR03: for the linux-x64
  // target on a linux-x64 build host, planSelfTest() returns 'direct' and this runs the real
  // shipped artefact, not a proxy build. See scripts/package-selftest.js's header for exactly
  // what this does and does not prove for a target that isn't this host's own.
  const plan = planSelfTest({ target, outPath });
  let selfTest = null;
  if (plan.mode === 'unavailable') {
    console.warn(`package: startup self-test skipped for ${target}: ${plan.detail}`);
  } else if (plan.mode === 'direct') {
    console.log(`package: startup self-test for ${target}: ${plan.detail}`);
    selfTest = execVersionProbe(plan.binPath);
  } else {
    console.log(`package: startup self-test for ${target}: ${plan.detail}`);
    const { dir: proxyDir, exePath: proxyOut } = makeProxyBuildDir();
    try {
      execFileSync(process.execPath, buildInvocation({ target: plan.buildTarget, out: proxyOut }), {
        cwd: ROOT,
        maxBuffer: DEBUG_MAX_BUFFER,
      });
      selfTest = execVersionProbe(proxyOut);
    } catch (err) {
      selfTest = { ok: false, detail: `proxy build for the self-test itself failed: ${err.message}` };
    } finally {
      // #28: remove the whole probe directory, not just the exe by name --
      // this also covers THIRD-PARTY-NOTICES.txt, which `--version` writes
      // beside whatever binary it runs, and anything a future self-test
      // step writes beside it.
      fs.rmSync(proxyDir, { recursive: true, force: true });
    }
  }
  if (selfTest && !selfTest.ok) {
    console.error(`package: refusing to ship ${target}, the packaged pipeline does not start:`);
    console.error(`  ${selfTest.detail}`);
    fs.rmSync(outPath, { force: true });
    return { ok: false };
  }
  if (selfTest && selfTest.ok) {
    console.log(`package: startup self-test passed for ${target}: ${selfTest.detail}`);
  }

  const hash = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
  console.log(`packaged ${outPath}`);
  return { ok: true, outPath, assetName, hash };
}

/**
 * Runs the build. With neither `target` nor `out` given, builds every entry in TARGETS (the
 * default: both win-x64 and linux-x64) into dist/v<version>/ and writes ONE SHA256SUMS
 * covering both binaries plus THIRD-PARTY-NOTICES.txt (P5a-FR01). Passing either `target` or
 * `out` switches to single-target mode, unchanged from before 5a (formerly relied on by spike/run-pin-proof.sh, retained in the private archive at b5b48b4, and
 * still relied on by docs/decisions/0007's positive/negative controls).
 *
 * P5a-FR01: "if any gate fails, remove the outputs, write no SHA256SUMS, and exit 1" -- this
 * applies to the WHOLE run, not just the target that failed: a later target's failure also
 * removes any earlier target's already-verified binary, so a partial SHA256SUMS-less dist/
 * directory never contains a stray, unlisted, unverified binary left over from before the
 * failure.
 *
 * @param {{ target?: string, out?: string }} [opts]
 */
function run(opts = {}) {
  const overriding = opts.target !== undefined || opts.out !== undefined;
  const plan = overriding
    ? [
        {
          target: opts.target || DEFAULT_TARGET,
          outPath: path.resolve(opts.out || defaultOutPathFor(opts.target || DEFAULT_TARGET)),
        },
      ]
    : TARGETS.map((t) => ({ target: t.target, outPath: path.join(DEFAULT_OUT_DIR, t.assetName) }));

  const built = [];
  for (const { target, outPath } of plan) {
    const result = buildTarget({ target, outPath });
    if (!result.ok) {
      for (const b of built) fs.rmSync(b.outPath, { force: true });
      fs.rmSync(outPath, { force: true });
      process.exit(1);
    }
    built.push(result);
  }

  const outDir = path.dirname(plan[0].outPath);

  // Ship THIRD-PARTY-NOTICES.txt as a release asset alongside the exe(s) too, matching the
  // "install it next to the executable" half of docs/PROVENANCE.md section 11's shipping
  // spec: this covers whoever obtains a binary on its own (browser download, gh release
  // download by pattern), same as --version's embedded-copy write covers whoever already
  // has the exe but not this directory. See src/util/notices.js for the embedded-copy half.
  const noticesOutPath = path.join(outDir, path.basename(NOTICES_PATH));
  fs.copyFileSync(NOTICES_PATH, noticesOutPath);
  const noticesHash = crypto.createHash('sha256').update(fs.readFileSync(noticesOutPath)).digest('hex');

  const sumsLines = built.map((b) => `${b.hash}  ${b.assetName}`);
  sumsLines.push(`${noticesHash}  ${path.basename(noticesOutPath)}`);
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sumsLines.join('\n')}\n`);

  console.log(`wrote ${noticesOutPath}`);
  console.log(`wrote ${path.join(outDir, 'SHA256SUMS')}`);
}

function main() {
  run(parseArgs(process.argv.slice(2)));
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInvocation,
  run,
  parseArgs,
  TARGETS,
  DEFAULT_TARGET,
  DEFAULT_OUT,
  DEFAULT_OUT_DIR,
  defaultOutPathFor,
  makeProxyBuildDir,
  ROOT,
  PACKAGE_JSON_PATH,
};
