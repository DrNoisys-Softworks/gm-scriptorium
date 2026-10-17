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

/*
 * The browser job (ADR 0069): every pull request and every push to main, public repo only, running
 * scripts/browser-tests.js. Each pin below is a function of the workflow text, run against the real
 * file (it must hold) and against loosened copies (it must fail), in the style of
 * test/pages-workflow.test.js.
 */

// A local copy of the helper in test/pages-workflow.test.js, not an import.
function jobNames(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  if (start < 0) return null;
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) names.push(m[1]);
    else if (/^\S/.test(lines[i])) break;
  }
  return names;
}

const BROWSER_GUARD = "    if: github.repository == 'DrNoisys-Softworks/gm-scriptorium'";
const BROWSER_RUNS = [
  '      - run: npm ci',
  '      - run: npm install --prefix "$RUNNER_TEMP/browser-tools" $(node scripts/browser-tests.js packages)',
  '      - run: node "$RUNNER_TEMP/browser-tools/node_modules/playwright/cli.js" install --with-deps chromium firefox',
  '      - run: PLAYWRIGHT_MODULE="$RUNNER_TEMP/browser-tools/node_modules/playwright" node scripts/browser-tests.js run',
];

const bUses = (block) => (block || '').split('\n').filter((l) => /\buses:/.test(l));

const BPINS = {
  B1: (y) => {
    const n = jobNames(y);
    return Array.isArray(n) && n.join(',') === 'test,packaged-smoke,hygiene,browser';
  },
  B2: (y) => {
    const b = jobBlock(y, 'browser');
    if (!b) return false;
    return b.split('\n').includes(BROWSER_GUARD) && !/event_name|paths|continue-on-error|\|\| true|always\(\)/.test(b);
  },
  B3: (y) => {
    const b = jobBlock(y, 'browser');
    const m = b && TIMEOUT_RE.exec(b);
    return Boolean(m) && Number(m[1]) >= 1 && Number(m[1]) <= 30;
  },
  B4: (y) => {
    const b = jobBlock(y, 'browser');
    return Boolean(b) && /^ {4}concurrency:\n {6}group: browser-.+\n {6}cancel-in-progress: true$/m.test(b);
  },
  B5: (y) => {
    const b = bUses(jobBlock(y, 'browser'));
    const t = bUses(jobBlock(y, 'test'));
    return b.length === 2 && t.length === 2 && b.every((l, i) => l === t[i]);
  },
  B6: (y) => {
    const lines = (jobBlock(y, 'browser') || '').split('\n');
    let from = -1;
    for (const want of BROWSER_RUNS) {
      const at = lines.indexOf(want, from + 1);
      if (at < 0) return false;
      from = at;
    }
    return true;
  },
  B7: (y) => {
    const t = jobBlock(y, 'test');
    return Boolean(t) && !/PLAYWRIGHT_MODULE|browser-tests|playwright/i.test(t);
  },
  B8: (y) => y.length > 0 && !/playwright@|axe-core@/.test(y),
};

test('B1 to B8 hold on the real workflow file', () => {
  for (const [name, pin] of Object.entries(BPINS)) assert.equal(pin(YML), true, name);
});

test('every browser pin goes false on a loosened copy of the text (positive controls)', () => {
  const onBrowser = (fn) => (y) => {
    const i = y.indexOf('\n  browser:');
    return i < 0 ? y : y.slice(0, i) + fn(y.slice(i));
  };
  const loosen = [
    ['B1', (y) => y.replace('\n  hygiene:\n', '\n  hygiene2:\n')],
    ['B1', (y) => y.replace('\n  browser:\n', '\n  browser2:\n')],
    ['B1', (y) => y + '\n  extra:\n    runs-on: ubuntu-latest\n'],
    ['B1', (y) => y.replace('\n  test:\n', '\n  first:\n    runs-on: x\n  test:\n')],
    ['B2', onBrowser((b) => b.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    continue-on-error: true\n'))],
    ['B2', onBrowser((b) => b.replace("gm-scriptorium'", "gm-scriptorium' && github.event_name == 'push'"))],
    ['B2', onBrowser((b) => b.replace(BROWSER_GUARD + '\n', ''))],
    ['B2', onBrowser((b) => b.replace(BROWSER_GUARD, "    if: github.repository != 'x'"))],
    ['B2', onBrowser((b) => b.replace('browser-tests.js run', 'browser-tests.js run || true'))],
    ['B2', onBrowser((b) => b.replace(BROWSER_GUARD, '    if: always()'))],
    ['B2', onBrowser((b) => b.replace('  browser:\n', '  browser:\n    # paths: [x]\n'))],
    ['B3', onBrowser((b) => b.replace('timeout-minutes: 30', 'timeout-minutes: 120'))],
    ['B3', onBrowser((b) => b.replace('    timeout-minutes: 30\n', ''))],
    ['B3', onBrowser((b) => b.replace('timeout-minutes: 30', 'timeout-minutes: 0'))],
    ['B4', onBrowser((b) => b.replace('cancel-in-progress: true', 'cancel-in-progress: false'))],
    ['B4', onBrowser((b) => b.replace('group: browser-', 'group: other-'))],
    ['B4', onBrowser((b) => b.replace(/ {4}concurrency:\n {6}group: .*\n {6}cancel-in-progress: true\n/, ''))],
    ['B5', onBrowser((b) => b.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@' + 'a'.repeat(40)))],
    ['B5', onBrowser((b) => b.replace(/(actions\/setup-node@[0-9a-f]{40}) # v\S+/, '$1 # v1'))],
    ['B5', onBrowser((b) => b.replace(/(actions\/setup-node@[0-9a-f]{40}) # v\S+/, '$1'))],
    ['B5', onBrowser((b) => b + '      - uses: actions/cache@' + 'a'.repeat(40) + ' # v1\n')],
    ['B6', onBrowser((b) => b.replace(BROWSER_RUNS[3] + '\n', ''))],
    ['B6', onBrowser((b) => b.replace(BROWSER_RUNS[3], BROWSER_RUNS[3].replace('PLAYWRIGHT_MODULE=', 'PW=')))],
    ['B6', onBrowser((b) => b.replace(BROWSER_RUNS[1] + '\n' + BROWSER_RUNS[2], BROWSER_RUNS[2] + '\n' + BROWSER_RUNS[1]))],
    ['B6', onBrowser((b) => b.replace('$(node scripts/browser-tests.js packages)', 'playwright'))],
    ['B6', onBrowser((b) => b.replace(' install --with-deps', ' install'))],
    ['B7', (y) => y.replace('      - run: npm test\n', '      - run: npm test\n      - run: echo PLAYWRIGHT_MODULE\n')],
    ['B7', (y) => y.replace('      - run: npm test\n', '      - run: npm test\n      - run: node scripts/browser-tests.js run\n')],
    ['B7', (y) => y.replace('      - run: npm test\n', '      - run: npm test\n      - run: npx playwright test\n')],
    ['B8', (y) => y.replace('npm ci\n      # Playwright', 'npm ci\n      - run: npm i ' + 'playwright@' + '1.0.0' + '\n      # Playwright')],
    ['B8', onBrowser((b) => b + '      - run: npm i ' + 'axe-core@' + '4.0.0\n')],
  ];
  for (const [pinName, fn] of loosen) {
    const mutated = fn(YML);
    assert.notEqual(mutated, YML, `a loosening for ${pinName} changed nothing: ${fn}`);
    assert.equal(BPINS[pinName](mutated), false, `${pinName} stayed true on: ${fn}`);
  }
});

test('the browser run lines are plain YAML scalars: none starts with a quote character', () => {
  const b = jobBlock(YML, 'browser');
  assert.ok(b, 'no browser job');
  const runs = b.split('\n').filter((l) => /^\s*- run: /.test(l));
  assert.equal(runs.length, 4);
  for (const l of runs) assert.doesNotMatch(l, /run: ["']/, l);
  // control: a quoted scalar is caught
  assert.match('      - run: "npm ci"', /run: ["']/);
});
