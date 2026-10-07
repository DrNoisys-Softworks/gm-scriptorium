'use strict';

/*
 * Browser setup in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE; skips, loudly,
 * without it; the axe checks also need axe-core, found beside PLAYWRIGHT_MODULE or via
 * AXE_CORE_PATH). The real bin runs in setup mode against scratch copies of the sample vault with
 * an isolated config. The full flow is keyboard only. Ports: 9441 (Chromium) and 9442 (Firefox);
 * override the first with SETUP_UI_TEST_PORT (the second is that plus one).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { SAMPLE } = require('./helpers/setup-fixtures');

const REPO = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.SETUP_UI_TEST_PORT || 9441);

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

function makeFixture() {
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ui-')));
  const cp = (name, withPack) => {
    const dest = path.join(H, name);
    fs.cpSync(SAMPLE, dest, { recursive: true });
    if (!withPack) fs.rmSync(path.join(dest, '_meta', 'scriptorium'), { recursive: true, force: true });
    return dest;
  };
  const fx = { H, vault: cp('vault', false), packVault: cp('pack-vault', true), configPath: path.join(H, 'cfg', 'config.toml') };
  fx.plain = path.join(H, 'plain');
  fs.mkdirSync(fx.plain);
  fx.parent = path.join(H, 'games');
  fs.mkdirSync(fx.parent);
  fs.cpSync(SAMPLE, path.join(fx.parent, 'long-lease'), { recursive: true });
  fx.full = path.join(H, 'full');
  fs.mkdirSync(fx.full);
  fs.writeFileSync(path.join(fx.full, 'notes.txt'), 'x');
  fx.env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
  return fx;
}

/** Presses Tab until the focused element matches, failing after a bound. */
async function tabTo(page, selector, limit = 60) {
  for (let i = 0; i < limit; i++) {
    const hit = await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector);
    if (hit) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${selector}`);
}

async function typeInto(page, selector, text) {
  await page.focus(selector);
  await page.fill(selector, '');
  await page.keyboard.type(text);
}

const statusText = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);

/** Waits until the focused element is the h1 with this text (the focus lands on each screen's heading). */
async function h1Focused(page, text) {
  await page.waitForFunction((want) => document.activeElement && document.activeElement.tagName === 'H1' && document.activeElement.textContent === want, text);
  return text;
}

for (const browserName of ['chromium', 'firefox']) {
  test(`browser setup in ${browserName}`, { skip: SKIP, timeout: 420000 }, async (t) => {
    const port = BASE_PORT + (browserName === 'firefox' ? 1 : 0);
    const fx = makeFixture();
    const srv = await startAdminServer(['serve', '--admin', '--port', String(port), '--config', fx.configPath], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const browser = await pw[browserName].launch();
    t.after(async () => {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    const open = async (width) => {
      const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 1000 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/auth?token=${srv.token}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-role="setup-root"] h1');
      return page;
    };

    await t.test('every setup screen and state has no axe violations at 1280 and 390', { skip: SKIP_AXE }, async () => {
      for (const width of [1280, 390]) {
        const page = await open(width);
        const clean = async (what) => assert.deepEqual(await axeViolations(page), [], `${what} at ${width}`);
        await clean('start');
        await page.click('.su-foot .a1-btn.primary');
        await page.waitForSelector('#su-name');
        await clean('name, empty');
        await typeInto(page, '#su-name', 'The Long Lease');
        await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('shared rule says') || document.getElementById('su-name-st').textContent.includes('Use lowercase'));
        await clean('name, bad');
        await typeInto(page, '#su-name', 'lease');
        await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('works.'));
        await clean('name, ok');
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-vault');
        const vaultState = async (value, expect) => {
          await typeInto(page, '#su-vault', value);
          await page.waitForFunction((e) => document.getElementById('su-vault-st').textContent.includes(e), expect);
        };
        await vaultState(fx.vault, 'A gm-apprentice vault');
        await clean('vault, ok');
        await vaultState(fx.plain, 'isn\u2019t a vault');
        await clean('vault, not a vault');
        await vaultState(fx.parent, 'one folder down');
        await clean('vault, candidate offered');
        await vaultState(path.join(fx.H, 'nowhere'), 'Can’t find that folder');
        await clean('vault, missing');
        await typeInto(page, '#su-vault', `/${fx.vault}`);
        await page.keyboard.press('Tab');
        await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('network share'));
        await clean('vault, share');
        await vaultState(fx.vault, 'A gm-apprentice vault');
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-out');
        await page.waitForFunction(() => document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
        await clean('output, ok');
        await typeInto(page, '#su-out', path.join(fx.vault, 'site'));
        await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('inside your vault'));
        await clean('output, inside');
        await typeInto(page, '#su-out', fx.full);
        await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Not empty'));
        await clean('output, full');
        await page.check('#su-outok');
        await typeInto(page, '#su-out', path.join(fx.H, 'lease-site'));
        await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Outside the vault') && !document.getElementById('su-out-st').textContent.includes('Not empty'));
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-title');
        await page.waitForFunction(() => document.getElementById('su-title').value === 'The Long Lease');
        await clean('title, new');
        await typeInto(page, '#su-title', '   ');
        await page.waitForFunction(() => document.getElementById('su-title-st').textContent.includes('some words'));
        await clean('title, bad');
        await typeInto(page, '#su-title', 'The Long Lease');
        await page.waitForFunction(() => document.getElementById('su-title-st').textContent.includes('Players will see'));
        await page.click('[data-part="next"]');
        await page.waitForSelector('input[name="su-theme"]');
        await clean('theme');
        await page.click('label.su-theme:has(#su-theme-haze)');
        await page.waitForFunction(() => document.querySelector('.su-themes-note').textContent.includes('config/theme-scheme-mismatch'));
        await clean('theme, haze note');
        await page.click('label.su-theme:has(#su-theme-gloam)');
        await page.click('[data-part="next"]');
        await page.waitForSelector('.a1-slip');
        await clean('review');
        await page.context().close();
      }
    });

    await t.test('a vault that already has a pack shows the title and the theme read-only', { skip: SKIP_AXE }, async () => {
      const page = await open(1280);
      await page.click('.su-foot .a1-btn.primary');
      await typeInto(page, '#su-name', 'lease');
      await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('works.'));
      await page.click('[data-part="next"]');
      await typeInto(page, '#su-vault', fx.packVault);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('already exists'));
      await page.click('[data-part="next"]');
      await page.waitForFunction(() => document.getElementById('su-out') && document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside'));
      await page.click('[data-part="next"]');
      await page.waitForSelector('.su-ro');
      assert.match(await page.textContent('.su-ro'), /The Long Lease/);
      assert.deepEqual(await axeViolations(page), [], 'title, from the pack');
      await page.click('[data-part="next"]');
      await page.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent === 'Pick a look for the player site');
      await page.waitForSelector('.su-ro');
      assert.match(await page.textContent('.su-ro'), /gloam/);
      assert.deepEqual(await axeViolations(page), [], 'theme, from the pack');
      await page.context().close();
    });

    await t.test('the whole flow with the keyboard only: focus lands on each heading, live regions announce, the build screen and the welcome are clean, and the welcome stays dismissed after a reload', async () => {
      const page = await open(1280);
      assert.equal(await h1Focused(page, 'Let’s set up your first campaign'), 'Let’s set up your first campaign');
      await tabTo(page, '.su-foot .a1-btn.primary');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'What should we call this campaign?'), 'What should we call this campaign?');
      await tabTo(page, '#su-name');
      await page.keyboard.type('lease');
      await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('works.'));
      assert.equal(await page.evaluate(() => document.getElementById('su-name-st').getAttribute('aria-live')), 'polite');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'Where is your campaign vault?'), 'Where is your campaign vault?');
      await tabTo(page, '#su-vault');
      await page.keyboard.type(fx.vault);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'Where should the built site go?'), 'Where should the built site go?');
      await page.waitForFunction(() => document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
      assert.equal(await page.inputValue('#su-out'), path.join(fx.H, 'lease-site'), 'the default sits next to the vault, named after the campaign');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'What’s the site called?'), 'What’s the site called?');
      await page.waitForFunction(() => document.getElementById('su-title') && document.getElementById('su-title').value === 'The Long Lease');
      await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'Pick a look for the player site'), 'Pick a look for the player site');
      await tabTo(page, 'input[name="su-theme"]');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'gloam', 'the default is picked');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'haze');
      await page.waitForFunction(() => document.querySelector('.su-themes-note').textContent.includes('theme-scheme-mismatch'));
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('input[name="su-theme"]:checked').value === 'gloam');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');

      assert.equal(await h1Focused(page, 'Check your answers'), 'Check your answers');
      const rows = await page.$$eval('.su-sum > div', (els) => els.map((e) => e.querySelector('.k').textContent));
      assert.deepEqual(rows, ['Campaign name', 'Vault', 'Output folder', 'Site title', 'Theme']);
      assert.equal(fs.existsSync(fx.configPath), false, 'nothing is written before the review is confirmed');

      // Hold the preview so the build screen can be inspected.
      let release;
      const held = new Promise((resolve) => {
        page.route('**/api/preview', (route) => {
          release = () => route.continue();
          resolve();
        });
      });
      await tabTo(page, '.cf-btns .a1-btn.primary');
      await page.keyboard.press('Enter');
      assert.equal(await h1Focused(page, 'Building your first preview'), 'Building your first preview');
      await held;
      assert.match(await page.textContent('.su-prog'), /Registered lease/);
      assert.ok(await page.$('.su-prog .spin'), 'the running step has a spinner');
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'build screen');
      release();

      assert.equal(await h1Focused(page, 'Your first preview is ready'), 'Your first preview is ready');
      assert.ok(fs.existsSync(fx.configPath));
      assert.equal(fs.existsSync(path.join(fx.H, 'lease-site')), false, 'the output folder is never touched');
      assert.match(await page.textContent('.su-prog'), /Preview built/);
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'ready screen');
      await tabTo(page, '.su-ready .a1-actions button');
      await page.keyboard.press('Enter');

      await page.waitForSelector('.wel');
      assert.match(await page.textContent('.wel h2'), /lease is set up/);
      await page.waitForSelector('[data-role="side"] a');
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'Overview with the welcome');
      await page.click('.wel .x');
      await page.waitForFunction(() => !document.querySelector('.wel'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-role="side"] a');
      await page.waitForTimeout(800);
      assert.equal(await page.$('.wel'), null, 'the dismissal survives a reload');
      await page.context().close();
    });
  });
}
