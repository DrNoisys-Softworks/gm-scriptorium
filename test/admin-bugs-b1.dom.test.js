'use strict';

/*
 * Bug batch B1 real-browser checks (Playwright via PLAYWRIGHT_MODULE; each skips, loudly, without
 * it): #88 theme radiogroup arrow keys keep focus, #89 forced-colors mode, #90 phone top bar
 * contrast behind a modal dialog, #99 the V1e-9 phone/laptop rules actually apply. The axe checks
 * also need axe-core, found next to PLAYWRIGHT_MODULE or via AXE_CORE_PATH. Port 7902 (7900-7919
 * are this batch's; override with B1_TEST_PORT).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');

const REPO = path.join(__dirname, '..');
const PORT = String(process.env.B1_TEST_PORT || 7902);

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

const FM = 'type: meta\npublish:\n  mode: player\n  exclude_fields: ["secret", "gm_notes"]\n  landing:\n    featured_npcs: ["A"]\n    max_npcs: 6\n';

let H;
let child;
let browser;
let token;

async function startFixture() {
  H = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-dom-'));
  const vault = path.join(H, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), `---\n${FM}---\n\nbody\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), '{"folderMap":{},"excludeDirs":["_meta"]}\n');
  const cfg = path.join(H, 'config.toml');
  fs.writeFileSync(cfg, `config_version = 1\ndefault_campaign = "lease"\n\n[campaigns.lease]\nvault = '${vault}'\noutput = '${H}/out'\n`);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  const srv = await startAdminServer(['serve', '--admin', '--port', PORT, '--config', cfg, 'lease'], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env });
  child = srv.child;
  token = srv.token;
  browser = await pw.chromium.launch();
}

async function stopFixture() {
  if (browser) await browser.close();
  if (child) await stopChild(child);
  if (H) fs.rmSync(H, { recursive: true, force: true });
}

async function openPage(width, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 1000 }, ...opts });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/auth?token=${token}`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return page;
}

async function gotoScreen(page, width, text) {
  if (width < 700) {
    await page.click('[data-role="more"]');
    await page.click(`[data-role="sheet"] a:has-text("${text}")`);
  } else {
    await page.click(`[data-role="side"] a:has-text("${text}")`);
  }
  await page.waitForTimeout(500);
}

// axe with wcag2a/aa/22aa/best-practice plus 'region' explicitly on (a past harness silently
// excluded 'region'); returns every violation as `id:target` strings.
async function axeViolations(page, onlyRule) {
  await page.evaluate(axeSource);
  return page.evaluate(async (only) => {
    const cfg = only
      ? { runOnly: [only] }
      : { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] }, rules: { region: { enabled: true } } };
    const r = await window.axe.run(document, cfg);
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(v.id + ':' + n.target.join(' '))));
    return out;
  }, onlyRule || null);
}

test('B1 browser checks', { skip: SKIP, timeout: 300000 }, async (t) => {
  await startFixture();
  try {
    await t.test('#88 theme radiogroup: arrow keys keep focus on the newly selected option', async () => {
      const page = await openPage(1280);
      await gotoScreen(page, 1280, 'Theme');
      const radios = '[data-screen="theme"] input[name="theme"]';
      const names = await page.$$eval(radios, (els) => els.map((e) => e.value));
      assert.ok(names.length >= 3, 'the fixture offers at least three themes');
      await page.focus(`${radios}[value="${names[0]}"]`);
      for (let i = 1; i <= 2; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(150);
        const st = await page.evaluate(() => ({ v: document.activeElement.value, type: document.activeElement.type, checked: document.activeElement.checked }));
        assert.deepEqual(st, { v: names[i], type: 'radio', checked: true }, `step ${i}: focus follows the selection`);
      }
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.activeElement.value), names[1], 'ArrowLeft too');
      await page.context().close();
    });

    await t.test('#99 V1e-9 phone and laptop rules apply (no @container rule without a declared container)', async () => {
      const page = await openPage(390);
      await gotoScreen(page, 390, 'vault-config.md');
      await page.click('[data-screen="vault-config"] .vc-sw');
      await page.waitForSelector('dialog.vc-dialog[open]');
      const d = await page.$eval('dialog.vc-dialog', (e) => {
        const cs = getComputedStyle(e);
        return { w: Math.round(e.getBoundingClientRect().width), r: cs.borderTopLeftRadius };
      });
      assert.equal(d.w, 390, 'phone warning dialog is full width');
      assert.equal(d.r, '0px', 'phone warning dialog has square corners');
      await page.context().close();

      const lap = await openPage(1280);
      await gotoScreen(lap, 1280, 'vault-config.md');
      await lap.waitForSelector('.vc-map .a1-cap');
      const cap = await lap.$eval('.vc-map .a1-cap', (e) => getComputedStyle(e).gridColumnEnd);
      assert.equal(cap, '-1', 'the laptop-width map caption spans the grid');
      await lap.context().close();
    });
    await t.test('#90 phone top bar is clean (axe) with a review dialog open over a long page, scroll 0', { skip: SKIP_AXE }, async () => {
      const page = await openPage(390);
      await gotoScreen(page, 390, 'vault-config.md');
      await page.click('[data-switcher="vault-config"] [data-view-opt="vc3"]');
      await page.waitForSelector('.vc3-grid');
      await page.click('[data-screen="vault-config"] .vc-sw');
      await page.check('#vc3-ack');
      await page.click('dialog.vc3-drawer button:has-text("Unlock")');
      await page.waitForTimeout(400);
      await page.fill('#vc3-max', '8');
      const fills = [];
      const zs = [];
      for (const scrolled of [false, true]) {
        if (scrolled) await page.evaluate(() => window.scrollTo(0, 0));
        await page.click('[data-screen="vault-config"] .a1-pending .a1-btn.primary');
        await page.waitForSelector('#admin-slip[open]');
        await page.waitForTimeout(600);
        const viol = await axeViolations(page);
        const alpha = await page.$eval('[data-role="top-bar"]', (e) => getComputedStyle(e).backgroundColor);
        fills.push(alpha);
        zs.push(await page.$$eval('[data-role="top-bar"], [data-role="bottom-bar"]', (els) => els.map((e) => getComputedStyle(e).zIndex)));
        fills.push(viol);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      for (let i = 0; i < fills.length; i += 2) assert.deepEqual(fills[i + 1], [], `axe clean, run ${i / 2 + 1}`);
      for (let i = 0; i < fills.length; i += 2) {
        assert.ok(/^rgb\(/.test(fills[i]), `top bar is opaque while a modal is open (got ${fills[i]})`);
      }
      // exactly 0 (not auto, not 10): axe's stacking model only stops seeing the bottom bar over the
      // dialog footer once both bars sit at 0, and 'auto'/'revert-layer' must not slip through.
      zs.forEach((z, i) => assert.deepEqual(z, ['0', '0'], `top and bottom bar z-index while a modal is open, run ${i + 1}`));
      await page.context().close();
    });

    await t.test('#89 forced-colors: no contrast failures and visible borders and focus rings', { skip: SKIP_AXE }, async () => {
      for (const width of [1280, 390]) {
        const page = await openPage(width, { forcedColors: 'active' });
        assert.ok(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'emulation is on');
        for (const text of ['Overview', 'Theme', 'Title & tagline', 'Images', 'Vocabulary', 'Check', 'Preview', 'vault-config.md']) {
          if (text !== 'Overview') await gotoScreen(page, width, text);
          assert.deepEqual(await axeViolations(page, 'color-contrast'), [], `${text} at ${width}`);
        }
        await page.context().close();
      }
      const page = await openPage(1280, { forcedColors: 'active' });
      // pills and cards keep a visible border (not transparent / none) when colours are forced
      const b = await page.evaluate(() => {
        const pill = document.querySelector('.a1-pill');
        return pill ? getComputedStyle(pill).borderTopStyle : 'none';
      });
      assert.notEqual(b, 'none', 'pills keep a border');
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      assert.notEqual(ring, 'none', 'focus ring survives');
      await page.context().close();
    });
  } finally {
    await stopFixture();
  }
});
