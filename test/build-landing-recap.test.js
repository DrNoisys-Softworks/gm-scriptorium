'use strict';

/*
 * FR-20/SD-20 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): upstream's #269
 * fix renders the landing recap's markdown emphasis as real HTML (extractRecapHtml), so
 * src/build/recap-emphasis.js's hand-rolled *...*-to-<em> transform is retired (deleted, not
 * disabled). This is the real-build proof that the pin itself now does what the deleted
 * transform used to: a build of test/fixtures/wrapup-vault, whose paired Wrap-Up's recap
 * paragraph contains real markdown emphasis (`*narrowly*`), must render it as exactly one
 * `<em>...</em>` with no literal `*` left in the recap div.
 *
 * Positive control: the recap div must exist at all (a vault with no session/no recap would make
 * "0 <em> tags" trivially true for the wrong reason).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const WRAPUP_VAULT = path.join(__dirname, 'fixtures', 'wrapup-vault');
const WRAPUP_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'wrapup-vault-site-config.json'));

test('FR-20: the landing recap renders emphasis as exactly one <em>, with no literal * (real build, wrapup-vault)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-landing-recap-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const userJsonConfig = { ...WRAPUP_SITE_CONFIG, vaultPath: WRAPUP_VAULT };

    const result = runAtomicBuild({
      vaultPath: WRAPUP_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'landing-recap',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));

    const landingPath = path.join(finalOut, 'index.html');
    assert.ok(fs.existsSync(landingPath), 'expected a landing page');
    const landing = fs.readFileSync(landingPath, 'utf8');

    const recapMatch = landing.match(/<div class="recap">([\s\S]*?)\n\s*<br>/);
    assert.ok(recapMatch, 'positive control: the recap div must exist');
    const recapHtml = recapMatch[1];

    const emCount = (recapHtml.match(/<em>/g) || []).length;
    assert.equal(emCount, 1, `expected exactly one <em>, got ${emCount}: ${recapHtml}`);
    assert.ok(!recapHtml.includes('*'), `expected no literal "*" in the recap, got: ${recapHtml}`);
    assert.match(recapHtml, /<em>narrowly<\/em>/, `expected the source's own emphasised word, got: ${recapHtml}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
