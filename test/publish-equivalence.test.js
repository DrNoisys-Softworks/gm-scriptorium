'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');
const { computePublishedSet } = require('../src/vault/publishset');
const { compareBuiltToPublishSet } = require('../scripts/equivalence-check');

/*
 * DEP-AC-05 (fixture half): build test/fixtures/pin-vault with the REAL
 * pinned generator, then assert computePublishedSet()'s prediction matches
 * the built tree exactly. If the sets differ, this test fails outright —
 * per the brief, the oracle (the real build) is never adjusted to match a
 * wrong prediction.
 */

const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

test('publish-equivalence: computePublishedSet matches a real build of test/fixtures/pin-vault exactly', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pin-vault-build-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT };
    const finalOut = path.join(scratch, 'out');

    // Track D2, Structural decision 5: this fixture vault deliberately carries
    // withheld-name leaks (Gus Marzone et al, Track D1/D3's fixtures, plus D2's
    // own graph-label/index-card/index-term fixtures below), so the pre-swap
    // output-leak scan would refuse the build. `force: true` is the loud,
    // greppable statement that this build is EXPECTED to be leaky — it exists
    // to prove computePublishedSet matches the real build, not to prove the
    // vault is clean.
    const buildResult = runAtomicBuild({
      vaultPath: PIN_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'pin-vault-equivalence',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));

    const publishSet = computePublishedSet(PIN_VAULT, userJsonConfig);
    const result = compareBuiltToPublishSet(finalOut, publishSet);

    assert.deepEqual(
      result.missing,
      [],
      `predicted but not built: ${JSON.stringify(result.missing)}`,
    );
    assert.deepEqual(
      result.extra,
      [],
      `built but not predicted: ${JSON.stringify(result.extra)}`,
    );
    assert.equal(result.ok, true);

    // A stub page's HTML must not contain a non-included section's sentinel.
    const rowanHtml = fs.readFileSync(path.join(finalOut, 'characters', 'pcs', 'rowan.html'), 'utf8');
    assert.ok(rowanHtml.includes('Rowan grew up in the borderlands'), 'the included section must render');
    assert.ok(
      !rowanHtml.includes('Secret backstory nobody should see'),
      'the non-included "## GM Notes" section must not survive the stub reduction',
    );
    assert.ok(
      !rowanHtml.includes('Sensitive session notes'),
      'the story\'s own non-included section must not survive the stub reduction either',
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('publish-equivalence: an excluded folder written with a trailing slash, ./, backslashes or an absolute path is left out of the prediction, as the real build leaves it out', () => {
  const vaultPath = path.join(__dirname, 'fixtures', 'story-vault');
  const siteConfig = require(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'));
  for (const spelling of ['Characters/NPCs/', './Characters/NPCs', 'Characters\\NPCs', path.join(vaultPath, 'Characters', 'NPCs')]) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-exclude-spelling-'));
    try {
      const siteDir = path.join(scratch, 'site');
      fs.mkdirSync(siteDir, { recursive: true });
      const userJsonConfig = { ...siteConfig, vaultPath, excludeDirs: [...(siteConfig.excludeDirs || []), spelling] };
      const finalOut = path.join(scratch, 'out');
      const buildResult = runAtomicBuild({ vaultPath, userJsonConfig, finalOut, siteDir, campaign: 'exclude-spelling', force: true });
      assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.error && buildResult.error.message));
      assert.equal(fs.existsSync(path.join(finalOut, 'characters', 'npcs', 'doran.html')), false, `${spelling}: the real build leaves the folder out`);
      const publishSet = computePublishedSet(vaultPath, userJsonConfig);
      const result = compareBuiltToPublishSet(finalOut, publishSet);
      assert.deepEqual(result.missing, [], `${spelling}: predicted but not built`);
      assert.deepEqual(result.extra, [], `${spelling}: built but not predicted`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
