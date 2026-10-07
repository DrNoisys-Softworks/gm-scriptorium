'use strict';

/*
 * GitHub issue 13, case 1: `staleness/story-behind-pc` warns when a PC's paired `<Name>_Story.md`
 * carries a lower `asOfSession` than the PC page. Every case runs a real `check` over a scratch
 * copy of examples/the-long-lease (all PCs and stories there are at "3") with one pair edited.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runCheckCommand } = require('../src/cli/check');
const { CHECKS_BY_ID } = require('../src/checks/registry');
const { RUNNERS } = require('../src/checks/run');

const ID = 'staleness/story-behind-pc';
const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const PC_REL = 'Characters/PCs/Kit Farrow.md';
const STORY_REL = 'Characters/PCs/Kit Farrow_Story.md';

/** Copies the sample to scratch, applies `mutate(vaultDir)`, runs `check`, cleans up. */
function checkVariant(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-behind-'));
  try {
    const vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    if (mutate) mutate(vault);
    const cfg = path.join(root, 'config.toml');
    fs.writeFileSync(
      cfg,
      ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n'),
    );
    return runCheckCommand({ config: cfg }, 'lease');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setAsOf(vault, rel, literal) {
  const file = path.join(vault, rel);
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^asOfSession:.*$/m, literal === null ? '' : `asOfSession: ${literal}`);
  assert.ok(/^asOfSession:/m.test(text), `${rel} must carry asOfSession before the edit`);
  fs.writeFileSync(file, next);
}

function findings(result) {
  return result.envelope.findings.filter((f) => f.id === ID);
}

function pair(pcLiteral, storyLiteral) {
  return checkVariant((v) => {
    setAsOf(v, PC_REL, pcLiteral);
    setAsOf(v, STORY_REL, storyLiteral);
  });
}

test('registered as a default-enabled warn with a runner', () => {
  assert.equal(CHECKS_BY_ID[ID].defaultSeverity, 'warn');
  assert.equal(CHECKS_BY_ID[ID].defaultEnabled, true);
  assert.equal(typeof CHECKS_BY_ID[ID].description, 'string');
  assert.equal(typeof RUNNERS[ID], 'function');
});

test('the untouched sample stays silent', () => {
  const r = checkVariant(null);
  assert.deepEqual(findings(r), []);
});

test('story lower than the PC page: one warn naming both numbers and both files', () => {
  const r = pair('"3"', '"1"');
  const f = findings(r);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].path, STORY_REL);
  assert.ok(f[0].message.includes(STORY_REL), f[0].message);
  assert.ok(f[0].message.includes(PC_REL), f[0].message);
  assert.ok(f[0].message.includes('1'), f[0].message);
  assert.ok(f[0].message.includes('3'), f[0].message);
  assert.deepEqual(f[0].data, { pc: PC_REL, story: STORY_REL, pcAsOfSession: 3, storyAsOfSession: 1 });
});

test('a warning alone leaves the exit code at 0', () => {
  const r = pair('"3"', '"1"');
  assert.equal(findings(r).length, 1);
  assert.equal(r.exitCode, 0);
});

test('equal: no finding', () => {
  assert.deepEqual(findings(pair('"3"', '"3"')), []);
});

test('story higher: no finding', () => {
  assert.deepEqual(findings(pair('"3"', '"5"')), []);
});

test('numeric and unquoted forms parse; comparison is numeric, not lexical', () => {
  assert.equal(findings(pair('3', '1')).length, 1);
  assert.equal(findings(pair('10', '"9"')).length, 1);
  assert.deepEqual(findings(pair('"9"', '10')), []);
  assert.equal(findings(pair('"03"', '2')).length, 1);
  assert.equal(findings(pair('0', '0')).length, 0);
});

test('unparseable on either side: no finding, no guess', () => {
  const bad = ['prep-s02', 'book', '"[[Session 2]]"', '""', '-1', '2.5', '"2.5"', '" 2"', 'null', '[2]', '"1e1"'];
  for (const b of bad) {
    assert.deepEqual(findings(pair('"3"', b)), [], `story=${b}`);
    assert.deepEqual(findings(pair(b, '"1"')), [], `pc=${b}`);
  }
});

test('asOfSession missing on either side: no finding', () => {
  assert.deepEqual(findings(pair('"3"', null)), []);
  assert.deepEqual(findings(pair(null, '"1"')), []);
});

test('PC with no story file: no finding', () => {
  const r = checkVariant((v) => {
    setAsOf(v, PC_REL, '"9"');
    fs.rmSync(path.join(v, STORY_REL));
  });
  assert.deepEqual(findings(r), []);
});
