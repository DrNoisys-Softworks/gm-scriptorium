'use strict';

/*
 * V1e-8 rework (Reviewer blocker AC-V8-03): the phone "See how it will look" example
 * (.vo2-mhow) must refresh from the same hooks as the desktop example (input, focus, tab
 * change). Also (minor): vocabExample.refresh() hides the "out of date" pill in EVERY branch.
 *
 * Real browser test: node --test cannot drive the DOM. Needs Playwright + a Chromium; resolved
 * via PLAYWRIGHT_MODULE (a path to the playwright package) or plain require('playwright').
 * Skips, loudly, when Playwright is unavailable. Port range 7780-7799 (own ports only).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startAdminServer, stopChild } = require('./helpers/admin-server');

const REPO = path.join(__dirname, '..');
const PORT = String(process.env.V1E8_TEST_PORT || 7781);

function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  for (const c of cands) {
    try {
      return require(c);
    } catch (_) {
      /* next */
    }
  }
  return null;
}
const pw = loadPlaywright();

test('phone vo2 example refreshes on edit, and the pill never survives a Now/After switch', { skip: pw ? false : 'playwright not available (set PLAYWRIGHT_MODULE)', timeout: 120000 }, async () => {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e8-phone-'));
  const vaultDir = path.join(H, 'vault');
  fs.cpSync(path.join(REPO, 'test/fixtures/vocab-vault'), vaultDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    XDG_CONFIG_HOME: path.join(H, 'xdg'),
    SCRIPTORIUM_CONFIG: path.join(H, 'cfg/config.toml'),
    APPDATA: path.join(H, 'appdata'),
  });
  delete env.SCRIPTORIUM_PROFILE;
  execFileSync('node', ['bin/scriptorium.js', 'config', 'add', 'dom', '--vault', vaultDir, '--out', path.join(H, 'out')], { cwd: REPO, env });
  let srv;
  let browser;
  try {
    srv = await startAdminServer(['serve', '--admin', '--port', PORT, 'dom'], { bin: path.join(REPO, 'bin', 'scriptorium.js'), cwd: REPO, env });
    const token = srv.token;
    browser = await pw.chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.goto('http://127.0.0.1:' + PORT + '/auth?token=' + token, { waitUntil: 'load' });
    // Phone: the sidebar is hidden, so navigate by hash.
    await page.evaluate(() => { location.hash = '#/overview'; });
    await page.waitForTimeout(300);
    const b = await page.$('button:has-text("Build preview")');
    if (b) {
      await b.click();
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => { location.hash = '#/vocab'; });
    await page.waitForSelector('[data-screen="vocab"]', { state: 'visible' });
    await page.click('[data-view-opt="vo2"]');
    await page.fill('#vocab-row-group_npc', 'Phone Folk One');
    await page.click('.vo2-mhow .vo-mhow-s');
    const body = () => page.evaluate(() => document.querySelector('.vo2-mhow .vo-mhow-b').innerText);

    // The edit made after the block was created is visible once it opens (no-edits is gone).
    await page.click('.vo2-mhow button:has-text("Update example")');
    await page.waitForFunction(() => /Built \d/.test(document.querySelector('.vo2-mhow .vo-mhow-b').innerText), null, { timeout: 30000 });
    assert.match(await body(), /Phone Folk One/);

    // Edit again + blur in place (change event, focus stays on the edited key): state must go "outdated" and show the new word.
    await page.fill('#vocab-row-group_npc', 'Phone Folk Two');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(300);
    const after = await body();
    assert.match(after, /from before your latest edits/, 'state text reads outdated, got: ' + after);
    assert.doesNotMatch(after, /Built \d/);
    assert.match(after, /Phone Folk Two/, 'caption follows the new value');
    const pillHidden = () => page.evaluate(() => document.querySelector('.vo2-mhow .a1-pill').hidden);
    assert.equal(await pillHidden(), false, 'After + outdated shows the pill');
    await page.click('.vo2-mhow button:has-text("Now")');
    assert.equal(await pillHidden(), true, 'Now hides the pill');
  } finally {
    if (browser) await browser.close();
    if (srv) await stopChild(srv.child);
  }
});

test('vocabExample.refresh(): the "out of date" pill is reset before any branch (missing and empty included), and the phone example refreshes from every hook', () => {
  const v = fs.readFileSync(path.join(REPO, 'assets/admin/variants.js'), 'utf8');
  const reset = v.indexOf('pillWrap.hidden = true;\n', v.indexOf("var showVocab = vo2When === 'after'"));
  const branch = v.indexOf('if (showVocab) {');
  assert.ok(reset > 0 && reset < branch, 'pillWrap.hidden = true precedes the showVocab branches');
  const src = fs.readFileSync(path.join(REPO, 'assets/admin/vocab.js'), 'utf8');
  // setActiveTab, labels focusin, onAnyInput.
  assert.equal((src.match(/^\s+refreshVo2Mhow\(\);$/gm) || []).length, 3);
});
