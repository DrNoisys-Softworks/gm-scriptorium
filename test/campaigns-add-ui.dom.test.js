'use strict';

/*
 * ADR 0052: adding a campaign from the panel, in real browsers (Chromium and Firefox via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core, found beside
 * PLAYWRIGHT_MODULE or via AXE_CORE_PATH). The real bin runs against scratch copies of the sample
 * vault with an isolated config, and its ports are chosen by the operating system. Every expected
 * string is written out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
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

/** Two campaigns registered, plus a pack-less vault copy ready to be added. */
function makeFixture() {
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-add-ui-')));
  const vaults = { alpha: path.join(H, 'vault-alpha'), beta: path.join(H, 'vault-beta') };
  for (const v of Object.values(vaults)) fs.cpSync(SAMPLE, v, { recursive: true });
  const fresh = path.join(H, 'work', 'vault-sable');
  fs.cpSync(SAMPLE, fresh, { recursive: true });
  fs.rmSync(path.join(fresh, '_meta', 'scriptorium'), { recursive: true, force: true });
  const lines = ['config_version = 1', 'default_campaign = "alpha"', ''];
  for (const [name, vault] of Object.entries(vaults)) lines.push(`[campaigns.${name}]`, `vault = ${JSON.stringify(vault)}`, `output = ${JSON.stringify(path.join(H, `out-${name}`))}`, '');
  const configPath = path.join(H, 'cfg', 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, lines.join('\n'));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
  delete env.SCRIPTORIUM_PROFILE;
  return { H, vaults, fresh, work: path.dirname(fresh), out: path.join(H, 'out-sable'), configPath, env };
}

/** One request to the loopback admin port with the launch token's cookie. */
function adminCall(base, token, method, pathname, body) {
  const port = new URL(base).port;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Cookie: `scriptorium_admin_${port}=${token}`, ...(method === 'POST' ? { Origin: base, 'Content-Type': 'application/json' } : {}) };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

for (const browserName of ['chromium', 'firefox']) {
  async function withPanel(t, fn) {
    const fx = makeFixture();
    const srv = await startAdminServer(['serve', '--admin', '--config', fx.configPath], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const port = /127\.0\.0\.1:(\d+)\/auth/.exec(srv.output())[1];
    const browser = await pw[browserName].launch();
    try {
      const base = `http://127.0.0.1:${port}`;
      /** Opens the panel on its Overview, or (add: true) the add page directly. */
      const open = async (size = WIDTHS[0], { add = false } = {}) => {
        const ctx = await browser.newContext({ viewport: size });
        const page = await ctx.newPage();
        await page.goto(`${base}/auth?token=${srv.token}`, { waitUntil: 'load' });
        await page.waitForSelector('.cs-trigger', { state: 'attached' });
        await page.waitForFunction(() => document.querySelector('[data-screen="overview"]') !== null);
        if (add) {
          await page.goto(`${base}/campaigns/add`, { waitUntil: 'load' });
          await page.waitForSelector('[data-role="setup-root"] h1');
        }
        return page;
      };
      await fn({ fx, srv, base, open, browser });
    } finally {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    }
  }

  const type = (page, sel, text) => page.fill(sel, text);

  async function toName(page) {
    await page.click('.su-foot .a1-btn.primary');
    await page.waitForSelector('#su-name');
  }

  async function nameOk(page, name) {
    await type(page, '#su-name', name);
    await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('works.'));
    await page.click('[data-part="next"]');
    await page.waitForSelector('#su-vault');
  }

  async function chooseByBrowse(page, folder) {
    await page.click('.pk-browse');
    await page.waitForSelector('.pk .pk-opt');
    await type(page, '.pk input[id$="-loc"]', folder);
    await page.keyboard.press('Enter');
    await page.waitForFunction((p) => document.querySelector('.pk-path') && document.querySelector('.pk-path').textContent === p, folder);
    await page.click('.pk >> text=Choose this folder');
  }

  /** From the add page's start to the review, adding the pack-less vault by Browse. */
  async function toReview(page, fx, name = 'sable-tide') {
    await toName(page);
    await nameOk(page, name);
    await chooseByBrowse(page, fx.fresh);
    await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
    await page.click('[data-part="next"]');
    await page.waitForFunction((out) => document.getElementById('su-out') && document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'), fx.out);
    await page.click('[data-part="next"]');
    await page.waitForSelector('[data-part="next"]');
    await page.click('[data-part="next"]'); // title
    await page.waitForSelector('.su-themes');
    await page.click('[data-part="next"]'); // theme
    await page.waitForSelector('.a1-slip');
  }

  test(`entry points in ${browserName}: the Campaigns screen and the switcher both open the add page, and #/campaigns/add redirects with a replace so Back does not loop`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, async ({ open, base }) => {
      const page = await open();
      await page.evaluate(() => { location.hash = '#/campaigns'; });
      await page.waitForSelector('.cs-add');
      assert.equal((await page.textContent('.cs-add')).trim(), 'Add a campaign');
      await page.click('.cs-add');
      await page.waitForURL(`${base}/campaigns/add`);
      await page.waitForSelector('[data-role="setup-root"] h1');
      assert.equal(await page.textContent('[data-role="setup-root"] h1'), 'Add another campaign');
      await page.context().close();

      const page2 = await open();
      await page2.click('[data-role="side"] .cs-trigger');
      await page2.waitForSelector('.cs-pop:not([hidden]) .cs-foot');
      const links = await page2.locator('.cs-pop:not([hidden]) .cs-foot a').allTextContents();
      assert.deepEqual(links.map((x) => x.trim()), ['Add a campaign', 'Manage campaigns']);
      await page2.click('.cs-pop:not([hidden]) .cs-foot a:has-text("Add a campaign")');
      await page2.waitForURL(`${base}/campaigns/add`);
      await page2.context().close();

      // Typing the fragment opens it too, and Back goes to where the GM was, not round again.
      const page3 = await open();
      await page3.evaluate(() => { location.hash = '#/theme'; });
      await page3.waitForFunction(() => location.hash === '#/theme');
      await page3.evaluate(() => { location.hash = '#/campaigns/add'; });
      await page3.waitForURL(`${base}/campaigns/add`);
      await page3.waitForSelector('[data-role="setup-root"] h1');
      await page3.goBack({ waitUntil: 'load' });
      await page3.waitForTimeout(600);
      const where = await page3.evaluate(() => location.pathname + location.hash);
      assert.equal(where, '/#/theme', 'Back lands where the GM was and does not bounce to the add page');
      await page3.context().close();
    });
  });

  test(`the add flow in ${browserName}: Browse an existing vault, a clash shown word for word, the review says the default stays, and the added screen offers three actions`, { skip: SKIP, timeout: 300000 }, async (t) => {
    await withPanel(t, async ({ open, fx, base, srv }) => {
      const page = await open(WIDTHS[0], { add: true });
      assert.equal(await page.textContent('.su-intro h1'), 'Add another campaign');
      assert.match(await page.textContent('.su-intro + .a1-note'), /The panel is on alpha, and it stays there\./);
      assert.equal((await page.textContent('.am-back')).trim(), 'Back to campaigns');
      assert.equal(await page.getAttribute('.am-back', 'href'), '/#/campaigns');
      assert.match(await page.textContent('.a1-sub'), /Adding to alpha/);
      await toName(page);

      await type(page, '#su-name', 'beta');
      await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('already registered'));
      assert.equal(await page.textContent('#su-name-st .su-rule'), 'campaign "beta" is already registered; choose another name');
      assert.match(await page.textContent('#su-name-st'), /That name is already used\./);
      assert.equal(await page.isDisabled('[data-part="next"]'), true);
      assert.match(await page.textContent('.a1-hint:has-text("Already registered")'), /Already registered: alpha, beta\./);

      await nameOk(page, 'sable-tide');
      await type(page, '#su-vault', fx.vaults.beta);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('already registered'));
      assert.equal(await page.textContent('#su-vault-st .su-rule'), `${fx.vaults.beta} is already registered as campaign "beta"`);
      assert.match(await page.textContent('#su-vault-st'), /That vault is already a campaign\./);

      await chooseByBrowse(page, fx.fresh);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
      assert.equal(await page.inputValue('#su-vault'), fx.fresh);
      await page.click('[data-part="next"]');
      await page.waitForFunction(() => document.getElementById('su-out') && document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
      await type(page, '#su-out', path.join(fx.vaults.beta, 'site'));
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('overlaps the vault of campaign'));
      assert.equal(
        await page.textContent('#su-out-st .su-rule'),
        `${path.join(fx.vaults.beta, 'site')} overlaps the vault of campaign "beta" (${fx.vaults.beta}); a build replaces its whole output folder, so it must stay clear of every vault`,
      );
      await type(page, '#su-out', fx.out);
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Outside the vault') && !document.getElementById('su-out-st').textContent.includes('overlaps'));
      await page.click('[data-part="next"]');
      await page.click('[data-part="next"]');
      await page.waitForSelector('.su-themes');
      await page.click('[data-part="next"]');
      await page.waitForSelector('.a1-slip');

      assert.equal((await page.textContent('#su-rv')).trim(), 'Add sable-tide');
      assert.match(await page.textContent('.su-do'), /Your default stays alpha\./);
      assert.equal(await page.locator('.cf-btns .a1-btn').count(), 1, 'one Add button');
      assert.equal((await page.textContent('.cf-btns .a1-btn')).trim(), 'Add sable-tide');

      await page.click('.cf-btns .a1-btn');
      await page.waitForSelector('.su-ready h1');
      assert.equal(await page.textContent('.su-ready h1'), 'sable-tide is added');
      assert.match(await page.textContent('.su-ready .a1-lede'), /The panel is still on alpha/);
      const actions = await page.locator('.am-acts .a1-btn').allTextContents();
      assert.deepEqual(actions.map((x) => x.trim()), ['Switch and build its first preview', 'Switch to sable-tide', 'Stay on alpha']);
      const cfg = fs.readFileSync(fx.configPath, 'utf8');
      assert.match(cfg, /default_campaign = "alpha"/);
      assert.match(cfg, /\[campaigns\.sable-tide\]/);
      assert.equal((await adminCall(base, srv.token, 'GET', '/api/session')).json.campaign, 'alpha', 'adding does not switch');

      await page.click('.am-acts .a1-btn:has-text("Stay on alpha")');
      await page.waitForURL(`${base}/#/campaigns`);
      await page.context().close();
    });
  });

  test(`switch and build in ${browserName}: the check and the preview carry the NEW campaign's header, Go to my panel shows its Overview with the welcome`, { skip: SKIP, timeout: 300000 }, async (t) => {
    await withPanel(t, async ({ open, fx, base, srv }) => {
      const page = await open(WIDTHS[0], { add: true });
      const posts = [];
      page.on('request', (req) => {
        if (req.method() === 'POST') posts.push({ url: new URL(req.url()).pathname, header: req.headers()['x-scriptorium-campaign'] });
      });
      await toReview(page, fx);
      await page.click('.cf-btns .a1-btn');
      await page.waitForSelector('.am-acts');
      await page.click('.am-acts .a1-btn:has-text("Switch and build its first preview")');
      await page.waitForSelector('.su-ready h1:has-text("Its first preview is ready")', { timeout: 120000 });
      const byUrl = (u) => posts.filter((p) => p.url === u);
      assert.deepEqual(byUrl('/api/campaigns/add').map((p) => p.header), ['alpha']);
      assert.deepEqual(byUrl('/api/campaigns/switch').map((p) => p.header), ['alpha']);
      assert.deepEqual(byUrl('/api/check').map((p) => p.header), ['sable-tide'], 'the check names the campaign the page switched to');
      assert.deepEqual(byUrl('/api/preview').map((p) => p.header), ['sable-tide']);
      assert.match(await page.textContent('.su-prog'), /Switched the panel to sable-tide/);
      assert.equal((await adminCall(base, srv.token, 'GET', '/api/session')).json.campaign, 'sable-tide');

      await page.click('.su-ready .a1-btn:has-text("Go to my panel")');
      await page.waitForURL(`${base}/#/overview`);
      await page.waitForSelector('[data-role="side"] [data-part="campaign"]');
      assert.equal(await page.textContent('[data-role="side"] [data-part="campaign"]'), 'sable-tide');
      await page.waitForSelector('[data-part="welcome"]');
      await page.context().close();
    });
  });

  test(`a stale tab in ${browserName}: a switch from another tab makes the add commit say the tab is out of date, and nothing more is sent`, { skip: SKIP, timeout: 300000 }, async (t) => {
    await withPanel(t, async ({ open, fx, base, srv }) => {
      const page = await open(WIDTHS[0], { add: true });
      await toReview(page, fx);
      const switched = await adminCall(base, srv.token, 'POST', '/api/campaigns/switch', { name: 'beta' });
      assert.equal(switched.status, 200);
      const adds = [];
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/campaigns/add')) adds.push(req.postData());
      });
      await page.click('.cf-btns .a1-btn');
      await page.waitForFunction(() => document.getElementById('su-commit-st').textContent.includes('This tab is out of date. Reload to continue.'));
      assert.equal(adds.length, 1);
      await page.waitForSelector('#su-commit-st .a1-btn:has-text("Reload")');
      await page.click('.cf-btns .a1-btn');
      await page.waitForTimeout(500);
      assert.equal(adds.length, 1, 'a stale tab sends no further POST');
      assert.doesNotMatch(fs.readFileSync(fx.configPath, 'utf8'), /sable-tide/);
      // A page that is already stale cannot be re-pointed at a campaign: adopt refuses, and a change is still answered locally.
      const adopted = await page.evaluate(() => window.ScriptoriumAdmin.adopt('sable-tide'));
      assert.equal(adopted, false, 'adopt does nothing for a stale page');
      const later = await page.evaluate(() => window.ScriptoriumAdmin.api('/api/campaigns/add', { method: 'POST', body: '{}' }).then((r) => ({ status: r.status, error: r.body && r.body.error })));
      assert.deepEqual(later, { status: 409, error: 'campaign-changed' });
      assert.equal(adds.length, 1, 'and nothing was sent');
      await page.context().close();
    });
  });

  test(`remote look in ${browserName}: a stubbed remote state shows the remote footer, and a deferred path shows the check-it-now hint, not the network-path words`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, async ({ open, fx, base }) => {
      const page = await open(WIDTHS[0]);
      const c = page.context();
      await c.route('**/api/campaigns/add/state', async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        await route.fulfill({ response: res, json: { ...json, via: 'remote' } });
      });
      await c.route('**/api/campaigns/add/check?*', async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('field') === 'vault' && url.searchParams.get('commit') === '0') {
          await route.fulfill({ json: { field: 'vault', state: 'deferred', value: url.searchParams.get('value'), rule: null, facts: { found: false, isVault: false, unc: false, candidate: null, packExists: false, campaignTitle: null } } });
        } else await route.continue();
      });
      await page.goto(`${base}/campaigns/add`, { waitUntil: 'load' });
      await page.waitForSelector('[data-role="setup-root"] h1');
      assert.match(await page.textContent('.a1-sidefoot'), /Remote session/);
      assert.match(await page.textContent('.a1-sidefoot'), /Folders you type are checked when you leave the box\. Checks and the add are recorded in the audit log\./);
      assert.doesNotMatch(await page.textContent('.a1-sidefoot'), /127\.0\.0\.1/);
      await toName(page);
      await nameOk(page, 'sable-tide');
      await type(page, '#su-vault', fx.fresh);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('check it now'));
      const hint = await page.textContent('#su-vault-st');
      assert.match(hint, /This path is checked when you leave the box, so nothing is probed while you type\. Press Continue, or check it now\./);
      assert.doesNotMatch(hint, /network path/);
      await page.context().close();
    });
  });

  test(`axe in ${browserName}: the add screens are clean at 1440, 1280 and 390`, { skip: SKIP_AXE, timeout: 300000 }, async (t) => {
    await withPanel(t, async ({ open, fx }) => {
      const page = await open(WIDTHS[0], { add: true });
      const check = async (label) => {
        for (const size of WIDTHS) {
          await page.setViewportSize(size);
          assert.deepEqual(await axeViolations(page), [], `${label} at ${size.width}`);
        }
        await page.setViewportSize(WIDTHS[0]);
      };
      await check('start');
      await toName(page);
      await type(page, '#su-name', 'beta');
      await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('already registered'));
      await check('name refused');
      await nameOk(page, 'sable-tide');
      await type(page, '#su-vault', fx.vaults.beta);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('already registered'));
      await check('vault refused');
      await type(page, '#su-vault', fx.fresh);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
      await page.click('[data-part="next"]');
      await page.waitForFunction(() => document.getElementById('su-out') && document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
      await type(page, '#su-out', fx.vaults.beta);
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('overlaps'));
      await check('output refused');
      await type(page, '#su-out', fx.out);
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Outside the vault') && !document.getElementById('su-out-st').textContent.includes('overlaps'));
      await page.click('[data-part="next"]');
      await page.click('[data-part="next"]');
      await page.waitForSelector('.su-themes');
      await page.click('[data-part="next"]');
      await page.waitForSelector('.a1-slip');
      await check('review');
      // A refusal is drawn above the review, on the page's own ground, and must stay readable.
      await page.route('**/api/campaigns/add', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'config-changed', message: 'Your settings changed outside the panel. Reload and try again.' }) }) : route.continue()));
      await page.click('.cf-btns .a1-btn');
      await page.waitForFunction(() => document.getElementById('su-commit-st').textContent.includes('Your settings changed outside the panel. Reload and try again.'));
      await check('refused');
      await page.unroute('**/api/campaigns/add');
      await page.click('.cf-btns .a1-btn');
      await page.waitForSelector('.am-acts');
      await check('added');
      await page.context().close();
    });
  });
}
