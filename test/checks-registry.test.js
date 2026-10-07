'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHECKS, getCheck, defaultEnabledChecks } = require('../src/checks/registry');

test('every check id is unique', () => {
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every check has the required registry fields', () => {
  for (const c of CHECKS) {
    assert.equal(typeof c.id, 'string');
    assert.ok(['leak', 'link', 'frontmatter', 'config', 'graph', 'census'].includes(c.category));
    assert.ok(['error', 'warn', 'info'].includes(c.defaultSeverity));
    assert.equal(typeof c.defaultEnabled, 'boolean');
    assert.equal(typeof c.description, 'string');
    assert.ok(c.description.length > 0);
  }
});

test('every graph/* check requires --graph and is off by default', () => {
  for (const c of CHECKS.filter((x) => x.category === 'graph')) {
    assert.equal(c.requiresFlag, '--graph');
    assert.equal(c.defaultEnabled, false);
  }
});

test('no check outside category graph requires a flag', () => {
  for (const c of CHECKS.filter((x) => x.category !== 'graph')) {
    assert.equal(c.requiresFlag, null);
    assert.equal(c.defaultEnabled, true);
  }
});

test('getCheck returns the check by id', () => {
  assert.equal(getCheck('leak/l4-hidden-name').category, 'leak');
});

test('getCheck throws on an unknown id', () => {
  assert.throws(() => getCheck('nonsense/id'));
});

test('defaultEnabledChecks excludes --graph checks by default', () => {
  const enabled = defaultEnabledChecks();
  assert.ok(enabled.every((c) => c.requiresFlag === null));
  assert.ok(enabled.some((c) => c.id === 'leak/l4-hidden-name'));
});

test('defaultEnabledChecks includes --graph checks when graph:true', () => {
  const enabled = defaultEnabledChecks({ graph: true });
  assert.ok(enabled.some((c) => c.id === 'graph/orphan'));
  assert.ok(enabled.some((c) => c.id === 'leak/l4-hidden-name'));
});

test('the leak checks required by the brief are all registered', () => {
  const leakIds = CHECKS.filter((c) => c.category === 'leak').map((c) => c.id);
  assert.deepEqual(
    leakIds.sort(),
    [
      'leak/l1-no-manifest',
      'leak/l2-excluded-dir-in-output',
      'leak/l3-unpublished-link',
      'leak/l4-hidden-name',
      'leak/l4-name-collision',
      'leak/l4-output-name',
      'leak/l4-index-term',
      'leak/l5-gm-heading-survives',
      'leak/l6-comment-withheld',
      'leak/l6-comment-unterminated',
      'leak/l6-comment-in-output',
    ].sort(),
  );
});

test('link/in-code (#77 follow-up) is registered as an INFO, default-enabled, no-flag check', () => {
  const c = getCheck('link/in-code');
  assert.equal(c.category, 'link');
  assert.equal(c.defaultSeverity, 'info');
  assert.equal(c.defaultEnabled, true);
  assert.equal(c.requiresFlag, null);
});

test('l3, config divergence and the D2 index-term check are marked dynamicSeverity', () => {
  assert.equal(getCheck('leak/l3-unpublished-link').dynamicSeverity, true);
  assert.equal(getCheck('config/exclude-sections-divergence').dynamicSeverity, true);
  assert.equal(getCheck('config/exclude-dirs-divergence').dynamicSeverity, true);
  assert.equal(getCheck('leak/l4-index-term').dynamicSeverity, true);
});
