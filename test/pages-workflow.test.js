'use strict';

/*
 * Structural pins on .github/workflows/pages.yml (text level, no YAML dependency), the workflow
 * that publishes the sample campaign to GitHub Pages. Every pin is a function of the file text,
 * so each one runs twice: on the real file (must hold) and on a loosened copy of the text (must
 * fail). A pin that cannot fail is not a pin. The same loosenings are also run against a
 * git-archive copy of the repository by the engineer's mutation pass, where this file reads the
 * mutated workflow from its own repository path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES_PATH = path.join(ROOT, '.github', 'workflows', 'pages.yml');
const YML = fs.existsSync(PAGES_PATH) ? fs.readFileSync(PAGES_PATH, 'utf8') : '';
const CI = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const SCRIPT_SRC = fs.existsSync(path.join(ROOT, 'scripts', 'sample-site.js'))
  ? fs.readFileSync(path.join(ROOT, 'scripts', 'sample-site.js'), 'utf8')
  : '';

const GUARD_LINE = "    if: github.repository == 'DrNoisys-Softworks/gm-scriptorium'";
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

/** A top-level block: its unindented key line plus every following indented or blank line. */
function topBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join('\n').trimEnd();
}

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

function usesLines(text) {
  return text.split('\n').filter((l) => /\buses:/.test(l));
}

function actionName(line) {
  const m = /uses:\s*([^@\s]+)@/.exec(line);
  return m ? m[1] : null;
}

// Each pin takes the workflow text and returns true when the text satisfies it.
const PINS = {
  P1: (y) => {
    const n = jobNames(y);
    return !!n && n.length === 2 && n[0] === 'build' && n[1] === 'deploy';
  },
  P2: (y) => topBlock(y, 'on') === 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:',
  P3: (y) => topBlock(y, 'permissions') === 'permissions:\n  contents: read',
  P4: (y) => {
    const d = jobBlock(y, 'deploy');
    const b = jobBlock(y, 'build');
    if (!d || !b) return false;
    return (
      d.includes('    permissions:\n      pages: write\n      id-token: write\n') &&
      !/^ {4}permissions:/m.test(b) &&
      !y.includes('contents: write') &&
      !y.includes('write-all') &&
      !y.includes('read-all') &&
      (y.match(/id-token:/g) || []).length === 1 &&
      (y.match(/pages: write/g) || []).length === 1
    );
  },
  P5: (y) => {
    const names = jobNames(y) || [];
    return names.length > 0 && names.every((n) => (jobBlock(y, n) || '').split('\n').includes(GUARD_LINE));
  },
  P6: (y) => {
    const uses = usesLines(y);
    if (uses.length !== 4) return false;
    if (!uses.every((l) => USES_RE.test(l))) return false;
    const names = uses.map(actionName);
    const want = [
      'actions/checkout',
      'actions/setup-node',
      'actions/upload-pages-artifact',
      'actions/deploy-pages',
    ];
    if (JSON.stringify([...names].sort()) !== JSON.stringify([...want].sort())) return false;
    const ci = usesLines(CI);
    for (const n of ['actions/checkout', 'actions/setup-node']) {
      const mine = uses.find((l) => actionName(l) === n);
      const theirs = ci.find((l) => actionName(l) === n);
      if (!mine || !theirs || mine.trim().replace(/^- /, '') !== theirs.trim().replace(/^- /, '')) return false;
    }
    return true;
  },
  P7: (y) => {
    const names = jobNames(y) || [];
    if (names.length === 0) return false;
    return names.every((n) => {
      const m = TIMEOUT_RE.exec(jobBlock(y, n) || '');
      return !!m && Number(m[1]) >= 1 && Number(m[1]) <= 15;
    });
  },
  P8: (y) => topBlock(y, 'concurrency') === 'concurrency:\n  group: pages\n  cancel-in-progress: false',
  P9: (y) => y.length > 0 && y.includes('${{') === false,
  P10: (y) => {
    if (y.length === 0) return false;
    for (const bad of [
      '--force',
      '--no-check',
      'site_config',
      '--site-config',
      '--vault',
      '--out',
      'inputs',
      'vars.',
      'secrets.',
      'env:',
      'pull_request',
      'paths',
    ]) {
      if (y.includes(bad)) return false;
    }
    return true;
  },
  P11: (y) => {
    const lines = y.split('\n');
    const at = (s) => lines.indexOf(s);
    const ci = at('      - run: npm ci');
    const vg = at('      - run: npm run verify-generator');
    const run = at('      - run: node scripts/sample-site.js');
    if (ci < 0 || vg < 0 || run < 0 || !(ci < vg && vg < run)) return false;
    if (lines.filter((l) => l.includes('sample-site.js') && !l.trim().startsWith('#')).length !== 1) return false;
    if (!/^ {6}- uses: actions\/upload-pages-artifact@[0-9a-f]{40} # v\S+$/.test(lines[run + 1] || '')) return false;
    if (lines[run + 2] !== '        with:' || lines[run + 3] !== '          path: _site') return false;
    if (lines[run + 4] !== '' ) return false;
    const co = lines.findIndex((l) => /uses: actions\/checkout@/.test(l));
    return co >= 0 && lines[co + 1] === '        with:' && lines[co + 2] === '          persist-credentials: false';
  },
  P12: (y) => {
    const toks = y.match(/examples\/[^\s'"]*/g) || [];
    return toks.every((t) => t === 'examples/the-long-lease');
  },
  P13: (y) => {
    const d = jobBlock(y, 'deploy');
    return !!d && d.includes('    needs: build\n') && d.includes('    environment:\n      name: github-pages\n');
  },
};

test('P1 to P13 hold on the real workflow file', () => {
  assert.ok(YML.length > 0, 'pages.yml does not exist');
  for (const [name, pin] of Object.entries(PINS)) assert.equal(pin(YML), true, name);
});

test('every pin goes false on a loosened copy of the text (positive controls)', () => {
  assert.ok(YML.length > 0, 'pages.yml does not exist');
  const sha = (n) => YML.match(new RegExp(`actions/${n}@[0-9a-f]{40} # v\\S+`))[0];
  const loosen = [
    ['P1', (y) => y.replace('\n  deploy:\n', '\n  deploy:\n  extra:\n    runs-on: x\n  deploy2:\n')],
    ['P1', (y) => y.replace('\n  build:\n', '\n  buildx:\n')],
    ['P2', (y) => y.replace('on:\n  push:', 'on:\n  pull_request:\n  push:')],
    ['P2', (y) => y.replace('  workflow_dispatch:', '  workflow_dispatch:\n    inputs:\n      a:\n        type: string')],
    ['P2', (y) => y.replace('branches: [main]', 'branches: [main]\n    paths: [x]')],
    ['P3', (y) => y.replace('contents: read', 'contents: write')],
    ['P3', (y) => y.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write')],
    ['P4', (y) => y.replace('      id-token: write\n', '')],
    ['P4', (y) => y.replace('    runs-on: ubuntu-latest\n    timeout-minutes: 15\n', '    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    permissions:\n      pages: write\n')],
    ['P4', (y) => y.replace('pages: write', 'pages: write\n      contents: write')],
    ['P5', (y) => y.replace(GUARD_LINE + '\n    needs: build', '    needs: build')],
    ['P5', (y) => y.replace(GUARD_LINE, "    if: github.repository != 'x'")],
    ['P6', (y) => y.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4')],
    ['P6', (y) => y.replace(sha('setup-node'), sha('setup-node').replace(/ # v.*/, ''))],
    ['P6', (y) => y.replace(/actions\/deploy-pages@[0-9a-f]{40}/, 'actions/deploy-pages@' + 'a'.repeat(39))],
    ['P6', (y) => y + '      - uses: actions/cache@' + 'a'.repeat(40) + ' # v1\n'],
    ['P7', (y) => y.replace('timeout-minutes: 10', 'timeout-minutes: 120')],
    ['P7', (y) => y.replace('    timeout-minutes: 10\n', '')],
    ['P7', (y) => y.replace('timeout-minutes: 15', 'timeout-minutes: 0')],
    ['P8', (y) => y.replace('cancel-in-progress: false', 'cancel-in-progress: true')],
    ['P8', (y) => y.replace('group: pages', 'group: pages-x')],
    ['P9', (y) => y.replace('path: _site', 'path: ${{ github.workspace }}')],
    ['P10', (y) => y.replace('node scripts/sample-site.js', 'node scripts/sample-site.js --force-check')],
    ['P10', (y) => y.replace('node scripts/sample-site.js', 'node scripts/sample-site.js --vault x')],
    ['P10', (y) => y.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    env:\n      A: b')],
    ['P11', (y) => y.replace('      - run: npm run verify-generator\n', '')],
    ['P11', (y) => y.replace('node scripts/sample-site.js', 'node scripts/sample-site.js x')],
    ['P11', (y) => y.replace('path: _site', 'path: .')],
    ['P11', (y) => y.replace('          persist-credentials: false\n', '          fetch-depth: 0\n')],
    ['P11', (y) => y.replace('      - run: npm ci\n', '')],
    ['P12', (y) => y.replace('node scripts/sample-site.js', 'node scripts/sample-site.js examples/other')],
    ['P13', (y) => y.replace('    needs: build\n', '')],
    ['P13', (y) => y.replace('      name: github-pages', '      name: other')],
  ];
  for (const [pinName, fn] of loosen) {
    const mutated = fn(YML);
    assert.notEqual(mutated, YML, `a loosening for ${pinName} changed nothing: ${fn}`);
    assert.equal(PINS[pinName](mutated), false, `${pinName} stayed true on: ${fn}`);
  }
});

test('P5/P6/P7 helpers accept a good line and reject a bad one', () => {
  assert.match('      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0', USES_RE);
  assert.doesNotMatch('      - uses: actions/cache@v6', USES_RE);
  assert.doesNotMatch('      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9', USES_RE);
  assert.match('    timeout-minutes: 15', TIMEOUT_RE);
  assert.doesNotMatch('    timeout-minutes: ${{ vars.T }}', TIMEOUT_RE);
  const sample = 'jobs:\n  a:\n    x: 1\n  b:\n    y: 2\n';
  assert.equal(jobBlock(sample, 'a'), '  a:\n    x: 1');
  assert.equal(jobBlock(sample, 'zzz'), null);
  assert.deepEqual(jobNames(sample), ['a', 'b']);
  assert.equal(
    topBlock('a: 1\npermissions:\n  contents: read\n  x: y\n\njobs:\n', 'permissions'),
    'permissions:\n  contents: read\n  x: y',
  );
  assert.equal(topBlock('a: 1\n', 'permissions'), null);
});

test('P14: the pipeline script constants equal their literals', () => {
  assert.ok(SCRIPT_SRC.length > 0, 'scripts/sample-site.js does not exist');
  const lines = SCRIPT_SRC.split('\n');
  for (const want of [
    "const SAMPLE_VAULT_REL = 'examples/the-long-lease';",
    "const SCRATCH_REL = '.sample-site';",
    "const STAGING_REL = '_site';",
    "const PAGES_SITE_URL = 'https://drnoisys-softworks.github.io/gm-scriptorium/';",
  ]) {
    assert.equal(lines.filter((l) => l === want).length, 1, `expected exactly one line: ${want}`);
  }
});
