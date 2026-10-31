'use strict';

/*
 * The panel on a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (ADR 0071), in a
 * real browser (Playwright via PLAYWRIGHT_MODULE; skips, loudly, without it; the axe check also needs
 * axe-core beside it or AXE_CORE_PATH). The vault is a copy of the sample that the pin's own move ran
 * on without folding the pack in, so the yaml sets no title and the pack still holds its settings.
 * Opening Title & tagline shows the carry's lines and a "Carry these settings" button; pressing it
 * shows the result lines, and the title, now in the yaml, is shown read-only. The nav and layout text
 * name the yaml, the dry run runs once per screen open, and a busy dry run says so. Chromium and
 * Firefox, each on a fresh copy. Port from testPort(7942).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { testPort } = require('./helpers/ports');
const { moveVaultCopy } = require('./helpers/moved-vault');

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'examples', 'the-long-lease');
const PORT = String(testPort(7942));

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
function loadAxeSource() {
  const roots = [];
  if (process.env.AXE_CORE_PATH) roots.push(process.env.AXE_CORE_PATH);
  if (process.env.PLAYWRIGHT_MODULE) roots.push(path.join(path.dirname(process.env.PLAYWRIGHT_MODULE), 'axe-core', 'axe.min.js'));
  for (const r of roots) {
    try {
      return fs.readFileSync(r, 'utf8');
    } catch (_) {
      /* next */
    }
  }
  try {
    return fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  } catch (_) {
    return null;
  }
}
const pw = loadPlaywright();
const axeSource = loadAxeSource();
const SKIP = pw ? false : 'playwright not available (set PLAYWRIGHT_MODULE)';
const SKIP_AXE = SKIP || (axeSource ? false : 'axe-core not available (set AXE_CORE_PATH)');

const TITLE_MOVED =
  "This campaign's title is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.";
const TAGLINE_MOVED =
  "This campaign's tagline is set in the vault's settings file (_meta/vault-config.yaml). Editing it here arrives in the next update; change it in that file for now.";
const SETTINGS_MOVED =
  "This campaign's settings are set in the vault's settings file (_meta/vault-config.yaml). Editing them here arrives in the next update; change them in that file for now.";
const NO_TITLE = "No site title is set in the vault's settings file (_meta/vault-config.yaml).";
const SAMPLE_TAGLINE = 'Three hundred years ago a queen rented this valley from a dragon. At midsummer the dragon came back for the rent.';

const MOVED_TITLE_LEDE = 'The name and one-line tagline on your landing page. This vault keeps both in _meta/vault-config.yaml, so they show here read-only. Editing them here arrives in the next update.';
const MOVED_VC_LEDE = "Your vault's own settings file. gm-apprentice and GM-Scriptorium both read it. Editing it here arrives in the next update; change it in that file for now.";
const BUSY = 'Another job is running in the panel. Open this screen again when it ends.';

const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

async function axeViolations(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] }, rules: { region: { enabled: true } } });
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(v.id + ':' + n.target.join(' '))));
    return out;
  });
}

for (const browserName of ['chromium', 'firefox']) {
  test(`the panel on a moved vault (${browserName})`, { skip: SKIP, timeout: 300000 }, async (t) => {
    const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moved-dom-')));
    let child;
    let browser;
    try {
      const vault = moveVaultCopy(SAMPLE, H).vaultPath;
      const cfgDir = path.join(H, 'cfg');
      fs.mkdirSync(cfgDir);
      const cfg = path.join(cfgDir, 'config.toml');
      fs.writeFileSync(cfg, `config_version = 1\ndefault_campaign = "lease"\n\n[campaigns.lease]\nvault = '${vault}'\noutput = '${H}/out'\n`);
      const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: cfg };
      const srv = await startAdminServer(['serve', '--admin', '--port', PORT, '--config', cfg, 'lease'], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env });
      child = srv.child;
      browser = await pw[browserName].launch();
      const pack = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');

      const openPage = async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
        const page = await ctx.newPage();
        const dryRuns = [];
        page.on('request', (req) => {
          if (req.method() === 'POST' && req.url().endsWith('/api/settings/carry') && JSON.parse(req.postData() || '{}').dryRun === true) dryRuns.push(req.url());
        });
        await page.goto(`http://127.0.0.1:${PORT}/auth?token=${srv.token}`, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        return { page, dryRuns };
      };
      const gotoScreen = async (page, id) => {
        await page.click(`[data-role="side"] a[data-nav="${id}"]`);
        await page.waitForTimeout(500);
      };

      await t.test('a busy dry run says so on the screen', async () => {
        const { page } = await openPage();
        await page.route('**/api/settings/carry', (route) =>
          route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy', busy: 'build' }) }),
        );
        await gotoScreen(page, 'title');
        await page.waitForSelector('[data-screen="title"] [data-part="carry"] [role="alert"]:not([hidden])');
        assert.equal((await texts(page, '[data-screen="title"] [data-part="carry"] [role="alert"]')).join('|'), BUSY);
        await page.context().close();
      });

      await t.test('Title & tagline: the title and tagline are read-only, the carry lines show, and carrying shows the result and the yaml title', async () => {
        const { page, dryRuns } = await openPage();
        assert.equal(dryRuns.length, 0, 'no dry run before the screen is opened');
        await gotoScreen(page, 'title');
        const screen = '[data-screen="title"]';
        await page.waitForSelector(`${screen} [data-part="carry"] li`);
        assert.equal(dryRuns.length, 1, 'one dry run when the screen opens');

        // The nav and header text name the yaml.
        assert.equal((await texts(page, `${screen} .a1-eyebrow`))[0], '_meta/vault-config.yaml');
        assert.equal((await texts(page, `${screen} .a1-lede`))[0], MOVED_TITLE_LEDE);
        assert.equal((await texts(page, '[data-role="side"] a[data-nav="vault-config"] [data-nav-label]'))[0], 'vault-config.yaml');
        // The three layouts' summary.
        assert.equal((await texts(page, `${screen} .tt1-toggle b`))[0], 'Other site settings');
        assert.equal((await texts(page, `${screen} .tt1-more .a1-fine`))[0], 'These are set in _meta/vault-config.yaml, not in the campaign pack.');
        assert.equal((await texts(page, `${screen} [data-tt="tt1"] [data-part="raw-file"]`)).length, 0, 'no pack file shown as the settings');
        assert.match((await texts(page, `${screen} [data-tt="tt2"] h2.a1-rule`))[1], /^Also set for your site/);
        assert.equal((await texts(page, `${screen} [data-tt="tt3"] .tt3-card.main .a1-pill`))[0], 'read-only');
        assert.equal(await page.$$eval(`${screen} [data-tt="tt3"] .a1-seg`, (els) => els.length), 0, 'no JSON view of the pack');
        const screenText = await page.textContent(screen);
        assert.ok(!screenText.includes('vault.config.json by hand'), 'no row sends the GM to vault.config.json');

        // Before: the yaml sets no title (gm-apprentice#539), so the field is empty with a plain note.
        const title = await page.$eval('#pack-title-input', (e) => ({ value: e.value, readOnly: e.readOnly }));
        assert.deepEqual(title, { value: '', readOnly: true });
        assert.equal((await texts(page, `${screen} [data-part="title-note"]`)).join('|'), NO_TITLE);
        const tagline = await page.$eval('#pack-tagline-input', (e) => ({ value: e.value, disabled: e.disabled }));
        assert.deepEqual(tagline, { value: SAMPLE_TAGLINE, disabled: true });
        assert.ok(screenText.includes(TAGLINE_MOVED), 'the tagline says where it lives now');

        assert.deepEqual(await texts(page, `${screen} [data-part="carry"] li`), [
          'This vault is already on the new settings file (_meta/vault-config.yaml).',
          '`host` moves to `player_site.host`.',
          `Will take the settings out of ${pack}: siteTitle, host, folderMap, attachmentsDir, excludeDirs, excludeSections, excludeCallouts, landingTagline, backend.statusBar, backend.inbox. ` +
            'Its excludeDirs entries were added to player_site.hide.folders. Its excludeSections entries were added to player_site.hide.sections. The rest of that file is as it was.',
          '`siteTitle` moves to `player_site.title`.',
          '`folderMap` moves to `player_site.folder_map`.',
        ]);
        const button = `${screen} [data-part="carry"] button:has-text("Carry these settings")`;
        assert.equal(await page.isEnabled(button), true);
        assert.equal(fs.readFileSync(pack, 'utf8').includes('siteTitle'), true, 'nothing is carried by opening the screen');

        // A state reload re-renders the screen but does not plan again.
        await page.evaluate(() => window.ScriptoriumAdmin.store.load());
        await page.evaluate(() => window.ScriptoriumAdmin.store.load());
        await page.waitForTimeout(800);
        assert.equal(dryRuns.length, 1, 'a reload does not post a new dry run');
        assert.equal((await texts(page, `${screen} [data-part="carry"] li`)).length, 5, 'the lines are still shown after the reload');

        // The accessibility check, with the carry lines and the button on screen.
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'axe, before the carry');

        await page.click(button);
        await page.waitForSelector(`${screen} [data-part="carry-result"] li`);
        await page.waitForFunction(() => document.querySelector('#pack-title-input').value === 'The Long Lease');
        assert.deepEqual(await texts(page, `${screen} [data-part="carry-result"] li`), [
          'This vault is already on the new settings file (_meta/vault-config.yaml).',
          `Removed the settings from ${pack}: siteTitle, host, folderMap, attachmentsDir, excludeDirs, excludeSections, excludeCallouts, landingTagline, backend.statusBar, backend.inbox. The rest of that file is as it was.`,
          '`host` moved to `player_site.host`.',
          '`siteTitle` moved to `player_site.title`.',
          '`folderMap` moved to `player_site.folder_map`.',
          `${pack} was rewritten without the settings that moved.`,
        ]);
        const backupDir = path.join(H, 'cfg', 'backups', 'campaign-lease');
        const backups = fs.readdirSync(backupDir).map((n) => path.join(backupDir, n));
        assert.equal(backups.length, 2);
        const shown = await texts(page, `${screen} [data-part="carry-backups"] li`);
        assert.deepEqual([...shown].sort(), [...backups].sort());

        // After: the title is the yaml's, still read-only, and nothing is left to carry (planned once more, after the carry).
        await page.waitForTimeout(500);
        assert.equal(dryRuns.length, 2, 'one more dry run, after the carry');
        const after = await page.$eval('#pack-title-input', (e) => ({ value: e.value, readOnly: e.readOnly }));
        assert.deepEqual(after, { value: 'The Long Lease', readOnly: true });
        assert.equal((await texts(page, `${screen} [data-part="title-note"]`)).join('|'), TITLE_MOVED);
        assert.equal(await page.$$eval(button, (els) => els.length), 0, 'no carry button once there is nothing to carry');
        assert.equal(fs.readFileSync(pack, 'utf8'), '{}\n');
        assert.equal(await page.isDisabled(`${screen} .a1-pending .a1-btn.primary`), true, 'Review and save stays off');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'axe, with the result lines');
        await page.context().close();
      });

      await t.test('the vault-config editor names the yaml, shows the refusal and offers no way to edit', async () => {
        const { page } = await openPage();
        await gotoScreen(page, 'vault-config');
        const screen = '[data-screen="vault-config"]';
        await page.waitForSelector(`${screen} [data-part="moved-note"]`);
        assert.equal((await texts(page, `${screen} [data-part="moved-note"]`)).join('|'), SETTINGS_MOVED);
        assert.equal(await page.$$eval(`${screen} .vc-sw, ${screen} [role="switch"]`, (els) => els.length), 0, 'no edit switch');
        assert.equal((await texts(page, `${screen} .a1-eyebrow`))[0], '_meta/vault-config.yaml');
        assert.equal((await texts(page, `${screen} h1`))[0], 'vault-config.yaml');
        assert.equal((await texts(page, `${screen} .a1-lede`))[0], MOVED_VC_LEDE);
        assert.equal(await page.title(), 'vault-config.yaml · Scriptorium admin panel');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'axe, the moved editor');
        await page.context().close();
      });

      // Makes a missing axe-core show as a skip, since the axe checks above are guarded inline.
      await t.test('axe-core is loaded, so the axe checks above ran', { skip: SKIP_AXE }, () => {
        assert.ok(axeSource);
      });
    } finally {
      if (browser) await browser.close();
      if (child) await stopChild(child);
      fs.rmSync(H, { recursive: true, force: true });
    }
  });
}
