'use strict';

/*
 * The campaign switcher, the Campaigns screen, the remove confirm, the unsaved-changes confirm and
 * the stale-tab banner in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE; skips, loudly,
 * without it; the axe checks also need axe-core, found beside PLAYWRIGHT_MODULE or via
 * AXE_CORE_PATH). The real bin runs against scratch copies of the sample vault with an isolated
 * config, and both of its ports are chosen by the operating system, so no fixed port is needed.
 * Every expected string is written out by hand (ADR 0050).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { SAMPLE } = require('./helpers/setup-fixtures');

const REPO = path.join(__dirname, '..');

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

async function axeViolations(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] },
      rules: { region: { enabled: true } },
    });
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(`${v.id}:${n.target.join(' ')}`)));
    return out;
  });
}

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** Three campaigns on disk, one in the config whose vault is missing, one with a very long folder name. */
function makeFixture(extraLines = []) {
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-ui-')));
  const longDir = path.join(H, 'a-very-long-folder-name-that-goes-on-and-on-and-on-and-on-and-on-and-on-and-on-and-on-and-on', 'campaign-vault-for-the-ninth-hundred-and-ninety-ninth-drowned-king');
  fs.mkdirSync(path.dirname(longDir), { recursive: true });
  const vaults = { alpha: path.join(H, 'vault-alpha'), beta: longDir, gamma: path.join(H, 'vault-gamma') };
  for (const v of Object.values(vaults)) fs.cpSync(SAMPLE, v, { recursive: true });
  const gone = path.join(H, 'not-there');
  const lines = ['config_version = 1', 'default_campaign = "alpha"', ''];
  for (const [name, vault] of Object.entries(vaults)) lines.push(`[campaigns.${name}]`, `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(path.join(H, `out-${name}`))}`, '');
  lines.push('[campaigns.gone]', `vault = ${JSON.stringify(gone)}`, `output = ${JSON.stringify(path.join(H, 'out-gone'))}`, '', ...extraLines);
  const configPath = path.join(H, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, lines.join('\n'));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
  delete env.SCRIPTORIUM_PROFILE;
  return { H, vaults, gone, configPath, env };
}

for (const browserName of ['chromium', 'firefox']) {
  /** Runs `fn(ctx)` with a fresh server on OS-chosen ports and a browser. */
  async function withPanel(t, extraArgs, fn) {
    const fx = makeFixture();
    const srv = await startAdminServer(['serve', '--admin', '--config', fx.configPath, ...extraArgs], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const port = /127\.0\.0\.1:(\d+)\/auth/.exec(srv.output())[1];
    const browser = await pw[browserName].launch();
    try {
      const base = `http://127.0.0.1:${port}`;
      const open = async (size = WIDTHS[0], hash = '') => {
        const ctx = await browser.newContext({ viewport: size });
        const page = await ctx.newPage();
        await page.goto(`${base}/auth?token=${srv.token}`, { waitUntil: 'load' });
        await page.waitForSelector('.cs-trigger', { state: 'attached' });
        await page.waitForFunction(() => document.querySelector('[data-screen="overview"]') !== null);
        if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
        return page;
      };
      await fn({ fx, srv, base, open, browser });
    } finally {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    }
  }

  const trigger = (page, size) => page.locator(size.width < 700 ? '[data-role="top-bar"] .cs-trigger' : '[data-role="side"] .cs-trigger');
  const pop = (page, size) => page.locator(size.width < 700 ? '[data-role="top-bar"] .cs-pop' : '[data-role="side"] .cs-pop');
  const campaignOf = (page) => page.evaluate(() => document.querySelector('[data-role="side"] [data-part="campaign"]').textContent);
  const serverCampaign = (base, token) => fetch(`${base}/api/session`, { headers: { Cookie: `scriptorium_admin_${new URL(base).port}=${token}` } }).then((r) => r.json()).then((j) => j.campaign);

  async function openSwitcher(page, size) {
    await trigger(page, size).click();
    await pop(page, size).waitFor({ state: 'visible' });
    await page.waitForSelector('.cs-pop:not([hidden]) .cs-row');
  }

  test(`the switcher in ${browserName}: lists campaigns in config order, marks active and default, opens from the keyboard, closes on Escape, no axe violations at three widths`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, [], async ({ open }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        await openSwitcher(page, size);
        const rows = await pop(page, size).locator('.cs-row').evaluateAll((els) => els.map((e) => ({ name: e.getAttribute('data-campaign'), current: e.getAttribute('aria-current'), text: e.textContent })));
        assert.deepEqual(rows.map((r) => r.name), ['alpha', 'beta', 'gamma', 'gone']);
        assert.equal(rows.find((r) => r.name === 'alpha').current, 'true');
        assert.equal(rows.filter((r) => r.current === 'true').length, 1);
        assert.match(rows.find((r) => r.name === 'alpha').text, /Default/);
        assert.doesNotMatch(rows.find((r) => r.name === 'beta').text, /Default/);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `switcher open at ${size.width}`);
        await page.keyboard.press('Escape');
        await pop(page, size).waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => document.activeElement.classList.contains('cs-trigger')), true, 'focus returns to the trigger');
        // keyboard: Enter opens it
        await trigger(page, size).focus();
        await page.keyboard.press('Enter');
        await pop(page, size).waitFor({ state: 'visible' });
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `closed again at ${size.width}`.replace('closed again', 'open by keyboard'));
        await page.context().close();
      }
    });
  });

  test(`a successful switch in ${browserName}: the header is sent, the tab goes to the Overview on the new campaign`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, [], async ({ open, base, srv }) => {
      const page = await open();
      const seen = [];
      page.on('request', (req) => {
        if (req.method() === 'POST') seen.push({ url: new URL(req.url()).pathname, header: req.headers()['x-scriptorium-campaign'] });
      });
      await page.evaluate(() => { location.hash = '#/theme'; });
      await openSwitcher(page, WIDTHS[0]);
      await pop(page, WIDTHS[0]).locator('[data-campaign="beta"]').click();
      await page.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'beta');
      assert.deepEqual(seen.filter((s) => s.url === '/api/campaigns/switch'), [{ url: '/api/campaigns/switch', header: 'alpha' }]);
      assert.equal(await page.evaluate(() => location.hash), '#/overview');
      assert.equal(await serverCampaign(base, srv.token), 'beta');
    });
  });

  test(`a failed switch in ${browserName} shows the server's words, keeps the panel where it was and marks the row`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, [], async ({ open, fx }) => {
      for (const size of [WIDTHS[0], WIDTHS[2]]) {
        const page = await open(size);
        await openSwitcher(page, size);
        await pop(page, size).locator('[data-campaign="gone"]').click();
        const msg = pop(page, size).locator('.cs-msg[role="alert"]');
        await msg.waitFor({ state: 'visible' });
        assert.equal((await msg.textContent()).trim(), `campaign "gone": configured vault path does not exist: ${fx.gone}`);
        assert.equal(await campaignOf(page), 'alpha');
        assert.equal(await pop(page, size).locator('[data-campaign="gone"]').getAttribute('aria-describedby'), 'cs-fail');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `failed switch at ${size.width}`);
        await page.context().close();
      }
    });
  });

  test(`unsaved changes in ${browserName}: a switch asks first, Stay changes nothing, Switch goes ahead`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, [], async ({ open, base, srv }) => {
      for (const size of [WIDTHS[0], WIDTHS[2]]) {
        const page = await open(size);
        const switches = [];
        page.on('request', (req) => {
          if (req.method() === 'POST' && req.url().endsWith('/api/campaigns/switch')) switches.push(req.postData());
        });
        await page.evaluate(() => { location.hash = '#/title'; });
        await page.fill('#pack-title-input', 'An edit nobody saved');
        await openSwitcher(page, size);
        await pop(page, size).locator('[data-campaign="beta"]').click();
        const dialog = page.locator('dialog.cs-dialog[open]');
        await dialog.waitFor({ state: 'visible' });
        assert.match(await dialog.locator('p').first().textContent(), /^You have unsaved changes on this page\. Switch anyway\?$/);
        assert.deepEqual(await dialog.locator('button').allTextContents(), ['Stay', 'Switch']);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `unsaved confirm at ${size.width}`);
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Stay', 'Stay has focus first');

        await dialog.locator('button', { hasText: 'Stay' }).click();
        await page.waitForSelector('dialog.cs-dialog[open]', { state: 'detached' });
        assert.deepEqual(switches, []);
        assert.equal(await page.inputValue('#pack-title-input'), 'An edit nobody saved', 'the edit is still there');
        assert.equal(await campaignOf(page), 'alpha');

        await openSwitcher(page, size);
        await pop(page, size).locator('[data-campaign="beta"]').click();
        await page.locator('dialog.cs-dialog[open] button', { hasText: 'Switch' }).click();
        await page.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'beta');
        assert.equal(switches.length, 1);
        assert.equal(await serverCampaign(base, srv.token), 'beta');
        await page.context().close();
        // put it back for the next width
        await fetch(`${base}/api/campaigns/switch`, { method: 'POST', headers: { Cookie: `scriptorium_admin_${new URL(base).port}=${srv.token}`, Origin: base, 'Content-Type': 'application/json', 'X-Scriptorium-Campaign': 'beta' }, body: '{"name":"alpha"}' });
      }
    });
  });

  test(`with nothing unsaved in ${browserName} a switch needs no confirm`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, [], async ({ open }) => {
      const page = await open();
      await openSwitcher(page, WIDTHS[0]);
      await pop(page, WIDTHS[0]).locator('[data-campaign="gamma"]').click();
      await page.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'gamma');
    });
  });

  test(`the Campaigns screen in ${browserName}: folders shown and wrapped, flags, set default, remove with its confirm, no axe violations at three widths`, { skip: SKIP, timeout: 300000 }, async (t) => {
    await withPanel(t, [], async ({ open, fx, base, srv }) => {
      for (const size of WIDTHS) {
        const page = await open(size, '#/campaigns');
        await page.waitForSelector('[data-screen="campaigns"] .cs-card');
        const names = await page.locator('[data-screen="campaigns"] .cs-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign')));
        assert.deepEqual(names, ['alpha', 'beta', 'gamma', 'gone']);
        const beta = page.locator('.cs-card[data-campaign="beta"]');
        assert.match(await beta.textContent(), new RegExp(fx.vaults.beta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(await beta.textContent(), /out-beta/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `no sideways scroll at ${size.width} (overflow ${overflow})`);
        // the active row's remove is off, with the reason
        const active = page.locator('.cs-card[data-campaign="alpha"]');
        assert.equal(await active.locator('[data-act="remove"]').isDisabled(), true);
        assert.match(await active.textContent(), /Switch to another campaign first\./);
        assert.equal(await active.locator('[data-act="switch"]').count(), 0);
        assert.equal(await active.locator('[data-act="default"]').isDisabled(), true, 'the default campaign has nothing to set');
        assert.equal((await active.locator('[data-act="default"]').textContent()).trim(), 'Default campaign');
        assert.match(await active.textContent(), /Active/);
        assert.match(await active.textContent(), /Default/);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `Campaigns screen at ${size.width}`);
        await page.context().close();
      }

      const page = await open(WIDTHS[0], '#/campaigns');
      await page.waitForSelector('.cs-card[data-campaign="gamma"]');
      const posts = [];
      page.on('request', (req) => {
        if (req.method() === 'POST') posts.push({ url: new URL(req.url()).pathname, header: req.headers()['x-scriptorium-campaign'], body: req.postData() });
      });
      // set as default: does not switch
      await page.locator('.cs-card[data-campaign="gamma"] [data-act="default"]').click();
      await page.waitForFunction(() => document.querySelector('.cs-flash') && document.querySelector('.cs-flash').textContent.includes('Default campaign is now "gamma"'));
      assert.equal((await page.locator('.cs-flash').textContent()).trim(), 'Default campaign is now "gamma". The panel is still on "alpha".');
      assert.equal(posts[0].url, '/api/campaigns/default');
      assert.equal(posts[0].header, 'alpha');
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), /default_campaign = "gamma"/);
      assert.match(await page.locator('.cs-card[data-campaign="gamma"]').textContent(), /Default/);
      assert.equal(await serverCampaign(base, srv.token), 'alpha');

      // remove: the confirm, Cancel first
      await page.locator('.cs-card[data-campaign="gone"] [data-act="remove"]').click();
      const dialog = page.locator('dialog.cs-dialog[open]');
      await dialog.waitFor({ state: 'visible' });
      assert.equal((await dialog.locator('h2').textContent()).trim(), 'Remove "gone" from GM-Scriptorium?');
      assert.equal((await dialog.locator('p').first().textContent()).trim(), "This only takes it off GM-Scriptorium's list. The vault, pack, output and backups stay where they are.");
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'remove confirm');
      const before = posts.length;
      await dialog.locator('button', { hasText: 'Cancel' }).click();
      await page.waitForSelector('dialog.cs-dialog[open]', { state: 'detached' });
      assert.equal(posts.length, before);
      await page.locator('.cs-card[data-campaign="gone"] [data-act="remove"]').click();
      await page.locator('dialog.cs-dialog[open] .danger').click();
      await page.waitForSelector('.cs-card[data-campaign="gone"]', { state: 'detached' });
      assert.equal(posts[posts.length - 1].url, '/api/campaigns/remove');
      assert.equal(fs.readFileSync(fx.configPath, 'utf8').includes('[campaigns.gone]'), false);
      assert.match((await page.locator('.cs-flash').textContent()).trim(), /^Removed "gone" from GM-Scriptorium's list\./);
      assert.equal(fs.existsSync(fx.vaults.alpha), true);
    });
  });

  test(`a tab that is out of date in ${browserName}: the banner shows on a 409 and on a GET that names another campaign, and no change request is sent after it`, { skip: SKIP, timeout: 300000 }, async (t) => {
    await withPanel(t, [], async ({ open, base, srv }) => {
      const other = await open();
      for (const how of ['post', 'get']) {
        const size = WIDTHS[0];
        const tab = await open(size, '#/campaigns');
        await tab.waitForSelector('.cs-card[data-campaign="gamma"]');
        const posts = [];
        tab.on('request', (req) => {
          if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
        });
        // the other tab moves the panel
        await openSwitcher(other, size);
        await other.locator('.cs-pop [data-campaign="beta"]').click();
        await other.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'beta');
        if (how === 'post') {
          await tab.locator('.cs-card[data-campaign="gamma"] [data-act="default"]').click();
        } else {
          await tab.evaluate(() => window.ScriptoriumAdmin.api('/api/state'));
        }
        const banner = tab.locator('.cs-stale[role="alert"]');
        await banner.waitFor({ state: 'visible' });
        assert.equal((await banner.locator('p').textContent()).trim(), 'This tab was showing alpha. The panel is now on beta. Reload to continue.');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(tab), [], `stale banner (${how})`);
        const sent = posts.length;
        const result = await tab.evaluate(() => window.ScriptoriumAdmin.api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => ({ ok: r.ok, status: r.status })));
        assert.deepEqual(result, { ok: false, status: 409 });
        assert.equal(posts.length, sent, 'nothing was sent after the tab went stale');
        await banner.locator('[data-cs-reload]').click();
        await tab.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'beta');
        assert.equal(await tab.locator('.cs-stale').count(), 0);
        await tab.context().close();
        // back to alpha for the next round
        await fetch(`${base}/api/campaigns/switch`, { method: 'POST', headers: { Cookie: `scriptorium_admin_${new URL(base).port}=${srv.token}`, Origin: base, 'Content-Type': 'application/json', 'X-Scriptorium-Campaign': 'beta' }, body: '{"name":"alpha"}' });
        await other.reload();
        await other.waitForFunction(() => (document.querySelector('[data-role="side"] [data-part="campaign"]') || {}).textContent === 'alpha');
      }
    });
  });

  test(`started with --vault in ${browserName}: the switcher is off with its reason, Switch to is off, set default still works`, { skip: SKIP, timeout: 240000 }, async (t) => {
    const fx = makeFixture();
    const srv = await startAdminServer(['serve', '--admin', '--config', fx.configPath, '--vault', fx.vaults.alpha], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const port = /127\.0\.0\.1:(\d+)\/auth/.exec(srv.output())[1];
    const browser = await pw[browserName].launch();
    try {
      const reason = 'This panel was started with --vault, which changes the folder for "alpha" only, so switching campaigns is off. Restart without --vault to switch.';
      for (const size of [WIDTHS[0], WIDTHS[2]]) {
        const ctx = await browser.newContext({ viewport: size });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}/auth?token=${srv.token}`);
        await page.waitForSelector('.cs-trigger', { state: 'attached' });
        await page.waitForFunction(() => document.querySelector('.cs-trigger[aria-disabled="true"]') !== null);
        const posts = [];
        page.on('request', (req) => {
          if (req.method() === 'POST') posts.push(req.url());
        });
        await trigger(page, size).click({ force: true }); // aria-disabled, so Playwright would wait forever
        await pop(page, size).waitFor({ state: 'visible' });
        assert.equal((await pop(page, size).locator('.cs-msg.is-lock').textContent()).trim(), reason);
        await pop(page, size).locator('[data-campaign="beta"]').click({ force: true });
        assert.deepEqual(posts, [], 'a disabled row sends nothing');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `--vault switcher at ${size.width}`);
        await page.keyboard.press('Escape');
        await page.evaluate(() => { location.hash = '#/campaigns'; });
        await page.waitForSelector('.cs-card[data-campaign="beta"]');
        assert.equal((await page.locator('[data-screen="campaigns"] .cs-msg.is-lock').textContent()).trim(), reason);
        assert.equal(await page.locator('.cs-card[data-campaign="beta"] [data-act="switch"]').isDisabled(), true);
        assert.equal(await page.locator('.cs-card[data-campaign="beta"] [data-act="default"]').isDisabled(), false);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `--vault Campaigns screen at ${size.width}`);
        await ctx.close();
      }
    } finally {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    }
  });
}
