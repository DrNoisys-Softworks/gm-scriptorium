'use strict';

/*
 * The browser-test runner behind the `browser` CI job (ADR 0069). It runs every real-browser test
 * file in Chromium and Firefox with axe-core, through the same `node --test` a contributor runs,
 * and fails on anything but a clean, complete run:
 *   node scripts/browser-tests.js packages   prints the two package specs CI installs
 *   node scripts/browser-tests.js run        runs the files and prints a verdict
 * Those test files skip themselves when Playwright is missing, and a skip is green to `node --test`.
 * So this runner reads the TAP summary and fails on any failed, cancelled, skipped or todo test,
 * on zero tests, on a missing summary, and on any non-clean child exit (a timeout, a signal or a
 * buffer overflow included). It reads no environment variable itself: the child inherits
 * PLAYWRIGHT_MODULE and AXE_CORE_PATH, so an unset one shows up as skips, and skips fail.
 *
 * The tool versions below are the only place they are written. CI installs from `packages`, and
 * test/browser-tests.test.js pins the commands in docs/DEVELOPING.md to these constants.
 * BROWSER_TEST_FILES is frozen on purpose: test/browser-tests.test.js checks it against the test
 * files that read the Playwright variable, so a new browser test cannot be left out silently.
 *
 * It proves nothing about the packaged executable, about Windows or macOS browsers, or about
 * WebKit. Its `run` path has no unit test; only a real run (CI, or the same command locally)
 * shows the spawn works. Output shape and exit codes follow scripts/packaged-smoke.js.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const PLAYWRIGHT_VERSION = '1.55.1';
const AXE_CORE_VERSION = '4.13.0';

const BROWSER_TEST_FILES = Object.freeze([
  'test/admin-109-roadmap.dom.test.js',
  'test/admin-bugs-b1.dom.test.js',
  'test/admin-moved-vault.dom.test.js',
  'test/admin-signin.dom.test.js',
  'test/admin-v1e10-vc.dom.test.js',
  'test/admin-vocab-phone-example.dom.test.js',
  'test/campaigns-add-ui.dom.test.js',
  'test/campaigns-ui.dom.test.js',
  'test/desktop-card-ui.dom.test.js',
  'test/desktop-panel-ui.dom.test.js',
  'test/focus-not-obscured.dom.test.js',
  'test/launch-ui.dom.test.js',
  'test/preview-strip.dom.test.js',
  'test/remote-accounts-screen.dom.test.js',
  'test/setup-newvault.dom.test.js',
  'test/setup-picker.dom.test.js',
  'test/setup-ui.dom.test.js',
  'test/story-nav-pin.test.js',
  'test/update-notice-ui.dom.test.js',
]);

const REPO_ROOT = path.join(__dirname, '..');
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_BUFFER = 512 * 1024 * 1024;

function packageSpecs() {
  return ['playwright@' + PLAYWRIGHT_VERSION, 'axe-core@' + AXE_CORE_VERSION];
}

const SUMMARY_RE = /^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/;
const SUMMARY_KEYS = {
  tests: 'tests',
  pass: 'pass',
  fail: 'fail',
  cancelled: 'cancelled',
  skipped: 'skipped',
  todo: 'todo',
  duration_ms: 'durationMs',
};

/** The trailing summary Node prints. Unindented lines only; the last occurrence of a key wins. */
function parseSummary(text) {
  const out = { tests: null, pass: null, fail: null, cancelled: null, skipped: null, todo: null, durationMs: null };
  for (const line of String(text).split(/\r?\n/)) {
    const m = SUMMARY_RE.exec(line);
    if (m) out[SUMMARY_KEYS[m[1]]] = Number(m[2]);
  }
  return out;
}

const NOT_OK_RE = /^\s*not ok \d+ - (.*)$/;
const DIRECTIVE_RE = /\s#\s*(?:TODO|SKIP)\b/i;

/** Names of failed tests, at any indent. A todo or skip directive line is not a failure here. */
function failedTests(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = NOT_OK_RE.exec(line);
    if (m && !DIRECTIVE_RE.test(m[1])) names.push(m[1]);
  }
  return names;
}

/** Reasons a spawnSync result is not a clean exit: an error, a signal, or a status other than 0. */
function childOutcome(res) {
  if (!res) return ['spawn-error=none'];
  const reasons = [];
  if (res.error) reasons.push('spawn-error=' + (res.error.code || 'unknown'));
  if (res.signal) reasons.push('signal=' + res.signal);
  if (res.status !== 0) reasons.push('exit=' + res.status);
  return reasons;
}

/** An empty array means pass. `outcome` is the array childOutcome returns. */
function verdict(summary, outcome) {
  const reasons = [];
  if (summary.tests === null) reasons.push('no-summary');
  else if (summary.tests === 0) reasons.push('zero-tests');
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    if (summary[key] > 0) reasons.push(`${key}=${summary[key]}`);
  }
  return reasons.concat(outcome || []);
}

function run() {
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...BROWSER_TEST_FILES], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
  });
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  for (const name of failedTests(stdout)) console.log(`BROWSER-TESTS FAILED ${name}`);
  const summary = parseSummary(stdout);
  const reasons = verdict(summary, childOutcome(res));
  if (reasons.length > 0) {
    console.log(`BROWSER-TESTS FAIL ${reasons.join(' ')}`);
    return 1;
  }
  console.log(
    `BROWSER-TESTS PASS tests=${summary.tests} pass=${summary.pass} fail=0 skipped=0 duration_ms=${summary.durationMs}`,
  );
  return 0;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === 'packages') {
    console.log(packageSpecs().join(' '));
    return 0;
  }
  if (argv.length === 1 && argv[0] === 'run') return run();
  console.log('BROWSER-TESTS FAIL usage: node scripts/browser-tests.js packages|run');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  PLAYWRIGHT_VERSION,
  AXE_CORE_VERSION,
  BROWSER_TEST_FILES,
  packageSpecs,
  parseSummary,
  failedTests,
  childOutcome,
  verdict,
  main,
};
