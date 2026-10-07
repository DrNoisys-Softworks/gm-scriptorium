'use strict';

/*
 * V1e-10 real-browser checks (Playwright via PLAYWRIGHT_MODULE; skips, loudly, without it):
 * the vc2 typed-name unlock gate, a layout switch never discarding edits (Q16), the vc3 chip
 * flow and the field save landing only the changed line. Port 7822 (7820-7839 are this slice's).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');

const REPO = path.join(__dirname, '..');
const PORT = String(process.env.V1E10_TEST_PORT || 7822);

function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try {
      return require(c);
    } catch (_) {
      /* next */
    }
  }
  return null;
}
const pw = loadPlaywright();

const FM = 'type: meta\npublish:\n  mode: player\n  exclude_fields: ["secret", "gm_notes"]\n  landing:\n    featured_npcs: ["A"]\n    max_npcs: 6\n';

test('vc2 unlock gate, layout switch keeps edits, vc3 chip and field save', { skip: pw ? false : 'playwright not available (set PLAYWRIGHT_MODULE)', timeout: 180000 }, async () => {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e10-dom-'));
  const vault = path.join(H, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  const vc = path.join(vault, '_meta', 'vault-config.md');
  fs.writeFileSync(vc, `---\n${FM}---\n\nbody\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), '{"folderMap":{},"excludeDirs":["_meta"]}\n');
  const cfg = path.join(H, 'config.toml');
  fs.writeFileSync(cfg, `config_version = 1\ndefault_campaign = "lease"\n\n[campaigns.lease]\nvault = '${vault}'\noutput = '${H}/out'\n`);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  let srv;
  let browser;
  try {
    srv = await startAdminServer(['serve', '--admin', '--port', PORT, '--config', cfg, 'lease'], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env });
    const token = srv.token;
    browser = await pw.chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 2400, height: 1300 } })).newPage();
    await page.goto(`http://127.0.0.1:${PORT}/auth?token=${token}`, { waitUntil: 'load' });
    await page.click('a:has-text("vault-config.md")');
    await page.click('[data-switcher="vault-config"] [data-view-opt="vc2"]');
    await page.click('.vc2-bar .a1-switch');
    const unlockDisabled = () => page.$eval('.vc2-warn .a1-btn.danger', (b) => b.disabled);
    for (const [typed, disabled] of [['', true], ['leas', true], ['xlease', true], ['lease2', true], ['constructor', true], [' LEASE ', false]]) {
      await page.fill('#vc2-type', typed);
      assert.equal(await unlockDisabled(), disabled, `typed "${typed}"`);
    }
    await page.click('.vc2-warn .a1-btn.danger');
    await page.waitForSelector('#vc-text');
    await page.fill('#vc-text', (await page.inputValue('#vc-text')).replace('"secret", ', ''));
    // A layout switch with dirty text edits: the fields layout shows a note, nothing is discarded.
    await page.click('[data-switcher="vault-config"] [data-view-opt="vc3"]');
    await page.waitForSelector('[data-screen="vault-config"] .a1-note');
    assert.match(await page.$eval('[data-screen="vault-config"] .a1-note', (n) => n.textContent), /^Your unsaved edits are in the Unlock and watch layout\. Switch back to review or discard them\.$/);
    assert.equal(await page.$('#vc-text'), null, 'the other-kind layout is read-only');
    await page.click('[data-switcher="vault-config"] [data-view-opt="vc2"]');
    await page.waitForSelector('#vc-text');
    assert.equal((await page.inputValue('#vc-text')).includes('"secret"'), false, 'the edit survived both switches');
    await page.click('.vc-editing button:has-text("Stop editing")');

    // vc3: unlock once (the drawer), add a chip, change max_npcs, review, save.
    await page.click('[data-switcher="vault-config"] [data-view-opt="vc3"]');
    await page.waitForSelector('.vc3-grid');
    await page.click('[data-screen="vault-config"] .vc-sw');
    await page.check('#vc3-ack');
    await page.click('dialog.vc3-drawer button:has-text("Unlock")');
    await page.waitForSelector('.vc3-tier.priv.is-live');
    await page.click('.vc3-f[data-path="publish.landing.featured_npcs"] .vc3-add');
    await page.fill('.vc3-f[data-path="publish.landing.featured_npcs"] .vc3-addrow input', 'B');
    await page.keyboard.press('Enter');
    await page.fill('#vc3-max', '9');
    await page.fill('#vc3-max', 'abc');
    assert.equal(await page.$eval('[data-screen="vault-config"] .a1-pending .a1-btn.primary', (b) => b.disabled), true, 'an invalid number disables Review');
    await page.fill('#vc3-max', '9');
    await page.click('[data-screen="vault-config"] .a1-pending .a1-btn.primary');
    await page.waitForSelector('#admin-slip[open] button:has-text("Back up and save")');
    await page.click('#admin-slip button:has-text("Back up and save")');
    await page.waitForSelector('#admin-slip :text("is updated")');
    const after = fs.readFileSync(vc, 'utf8');
    assert.equal(after, `---\n${FM.replace('featured_npcs: ["A"]', 'featured_npcs: ["A", "B"]').replace('max_npcs: 6', 'max_npcs: 9')}---\n\nbody\n`);
  } finally {
    if (browser) await browser.close();
    if (srv) await stopChild(srv.child);
    fs.rmSync(H, { recursive: true, force: true });
  }
});
