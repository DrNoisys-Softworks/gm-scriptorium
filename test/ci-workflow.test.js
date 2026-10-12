'use strict';

/*
 * rc.4 #9: structural checks on .github/workflows/ci.yml (text level, no YAML dependency).
 * The packaged-smoke job downloads two Node runtimes, so it must stay push-to-main only, in the
 * public repo only, time-boxed, cancellable and artifact-free. Every regex has a positive control
 * so a loosened pattern cannot pass silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const YML = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

const GUARD =
  "    if: github.repository == 'DrNoisys-Softworks/gm-scriptorium' && github.event_name == 'push' && github.ref == 'refs/heads/main'";
const USES_RE = /^\s*-?\s*uses:\s*\S+@[0-9a-f]{40} # v\S*\s*$/;
const TIMEOUT_RE = /^ {4}timeout-minutes: (\d+)$/m;

/** The block of a top-level job: its `  name:` line down to the next two-space-indented key. */
function jobBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const SMOKE = jobBlock(YML, 'packaged-smoke');

test('the packaged-smoke job exists', () => {
  assert.ok(SMOKE, 'no packaged-smoke job in ci.yml');
});

test('the job guard is exactly: public repo, push event, main ref', () => {
  assert.ok(SMOKE.split('\n').includes(GUARD));
});

test('timeout-minutes is an integer of 45 or less', () => {
  const m = TIMEOUT_RE.exec(SMOKE);
  assert.ok(m, 'no timeout-minutes in the job');
  assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 45);
});

test('concurrency cancels in-progress runs', () => {
  assert.match(SMOKE, /^ {4}concurrency:\n {6}group: .+\n {6}cancel-in-progress: true$/m);
});

test('every uses: in the file is pinned by full SHA with a version comment', () => {
  const uses = YML.split('\n').filter((l) => /\buses:/.test(l));
  assert.ok(uses.length >= 5);
  for (const l of uses) assert.match(l, USES_RE, l);
});

test('no upload-artifact anywhere in the file', () => {
  assert.equal(YML.includes('upload-artifact'), false);
});

test('the job packages and then smokes the linux binary', () => {
  assert.ok(SMOKE.includes('run: npm ci'));
  assert.ok(SMOKE.includes('run: npm run package'));
  assert.ok(SMOKE.includes('node scripts/packaged-smoke.js'));
  assert.ok(SMOKE.includes('gm-scriptorium-linux-x64'));
});

test('the test job still does not package', () => {
  const t = jobBlock(YML, 'test');
  assert.ok(t);
  assert.equal(t.includes('npm run package'), false);
});

/** A top-level block: its unindented key line plus every following indented or blank line. */
function topBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join('\n').trimEnd();
}

test('workflow-level permissions is exactly contents: read', () => {
  assert.equal(topBlock(YML, 'permissions'), 'permissions:\n  contents: read');
});

test('no job declares its own permissions', () => {
  assert.equal(/^ {4}permissions:/m.test(YML), false);
});

test('the triggers are exactly push to main and pull_request', () => {
  assert.equal(topBlock(YML, 'on'), 'on:\n  push:\n    branches: [main]\n  pull_request:');
});

test('positive controls for the permissions and trigger checks', () => {
  assert.equal(
    topBlock('a: 1\npermissions:\n  contents: read\n  x: y\n\njobs:\n', 'permissions'),
    'permissions:\n  contents: read\n  x: y',
  );
  assert.equal(topBlock('a: 1\n', 'permissions'), null);
  assert.equal(/^ {4}permissions:/m.test('  j:\n    permissions:\n      contents: write\n'), true);
});

test('positive controls: each pattern rejects a loosened line and accepts a good one', () => {
  assert.match('      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0', USES_RE);
  assert.doesNotMatch('      - uses: actions/cache@v6', USES_RE);
  assert.doesNotMatch('      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9', USES_RE);
  assert.match('    timeout-minutes: 30', TIMEOUT_RE);
  assert.doesNotMatch('    timeout-minutes: ${{ vars.T }}', TIMEOUT_RE);
  const sample = 'jobs:\n  a:\n    x: 1\n  b:\n    y: 2\n';
  assert.equal(jobBlock(sample, 'a'), '  a:\n    x: 1');
  assert.equal(jobBlock(sample, 'zzz'), null);
  assert.notEqual(GUARD, GUARD.replace(" && github.event_name == 'push'", ''));
});
