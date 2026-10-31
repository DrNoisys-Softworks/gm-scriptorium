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

test('config/exclude-dirs-divergence description reads exactly as written (#141)', () => {
  assert.equal(
    getCheck('config/exclude-dirs-divergence').description,
    "A directory excluded in _meta/vault-config.md's publish.exclude_dirs but not in vault.config.json's excludeDirs. A fresh build honours both lists (lib/build.js scans with the unioned exclude_dirs via scanConfigFor), so this is a WARN whether or not the directory holds pages or images (data.appliesInOutput says which); files a stale build left in real output are leak/l2-excluded-dir-in-output's to report. A vault.config.json-only entry is INFO.",
  );
});

test('no check description carries a bare --force claim (#140)', () => {
  const offenders = CHECKS.filter((c) => /--force(?![-a-z])/.test(c.description)).map((c) => c.id);
  assert.equal(offenders.join(','), '');
});

test('T-R1: leak/l2-excluded-dir-in-output is dynamicSeverity and its description reads exactly as written (#154)', () => {
  assert.equal(getCheck('leak/l2-excluded-dir-in-output').dynamicSeverity, true);
  assert.equal(
    getCheck('leak/l2-excluded-dir-in-output').description,
    "A built page or image is sourced from a directory in the union of vault.config.json:excludeDirs and _meta/vault-config.md:publish.exclude_dirs, or under one of the pin's always-excluded directories (_meta, _Templates, _templates, personal; lib/publish-decision.js:47). A file under images/ that is byte-identical to a cover picture or section banner the generator copies there (lib/build.js) is judged by that real source instead of being read back to the attachments folder: WARN when the GM named it in publish.theme.campaign_image or banners, ERROR when the banner was an auto-found _banner.* (ADR 0061). Reads the real built tree when a build exists (INFO when none). Inside build the pre-build check defers it (one INFO) and src/build/outputgate.js's scanStagingOutput runs it against the staging tree before the swap, where the command line cannot override it (ADR 0055).",
  );
});
