'use strict';

/*
 * Issue #109 real-browser checks (Playwright via PLAYWRIGHT_MODULE; axe via AXE_CORE_PATH): the
 * five unbuilt screens sit in a "Coming later" nav group, each says what it will do and that it
 * is not built yet, and an unknown #/route shows a "Page not found" state with a way home. Port
 * 8741 (override with R109_TEST_PORT).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');

const REPO = path.join(__dirname, '..');
const PORT = String(process.env.R109_TEST_PORT || 8741);
const LATER = ['memory', 'publish', 'sessions', 'ai', 'storage'];

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
const SKIP = pw && axeSource ? false : 'playwright or axe-core not available (set PLAYWRIGHT_MODULE and AXE_CORE_PATH)';

let H;
let child;
let browser;
let token;

async function startFixture() {
  H = fs.mkdtempSync(path.join(os.tmpdir(), 'r109-dom-'));
  const vault = path.join(H, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\nbody\n');
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

async function openPage(width, hash) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 1000 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/auth?token=${token}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-role="side"]', { state: 'attached' });
  if (hash) {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
  }
  await page.waitForTimeout(400);
  return page;
}

async function axeViolations(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, rules: { region: { enabled: true } } });
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(v.id + ':' + n.target.join(' '))));
    return out;
  });
}

test('#109 roadmap browser checks', { skip: SKIP, timeout: 300000 }, async (t) => {
  await startFixture();
  try {
    await t.test('the sidebar groups the five unbuilt screens under a named "Coming later" group, last', async () => {
      const page = await openPage(1440);
      const g = await page.$eval('[data-role="side"] .a1-ng.is-roadmap', (e) => ({
        role: e.getAttribute('role'),
        label: e.getAttribute('aria-label'),
        heading: e.querySelector('.a1-ng-label').textContent,
        ids: [...e.querySelectorAll('[data-nav]')].map((a) => a.getAttribute('data-nav')),
        last: e === e.parentElement.lastElementChild,
        badges: [...e.querySelectorAll('.a1-ro')].map((b) => b.textContent),
      }));
      assert.equal(g.role, 'group');
      assert.equal(g.label, 'Coming later, not built yet');
      assert.equal(g.heading, 'Coming later');
      assert.deepEqual(g.ids, LATER);
      assert.equal(g.last, true);
      assert.deepEqual(g.badges, ['later', 'later', 'later', 'later', 'later']);
      const live = await page.$$eval('[data-role="side"] [data-nav]', (as) => as.filter((a) => !a.closest('.is-roadmap')).map((a) => a.getAttribute('data-nav')));
      assert.equal(live.length, 10); // ADR 0050 adds the Campaigns screen: 9 -> 10
      assert.ok(!live.some((id) => LATER.includes(id)));
      await page.context().close();
    });

    await t.test('the roadmap links stay keyboard reachable', async () => {
      const page = await openPage(1440);
      await page.focus('[data-role="side"] [data-nav="memory"]');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-nav')), 'memory');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => location.hash), '#/memory');
      await page.context().close();
    });

    await t.test('each placeholder shows its description and says it is not built yet', async () => {
      for (const id of LATER) {
        const page = await openPage(1440, `#/${id}`);
        const s = await page.$eval(`[data-screen="${id}"]`, (e) => ({
          hidden: e.hidden,
          eyebrow: e.querySelector('.a1-eyebrow').textContent,
          lede: e.querySelector('.a1-lede').textContent,
          note: e.querySelector('[data-role="roadmap-note"]').textContent,
        }));
        assert.equal(s.hidden, false, id);
        assert.equal(s.eyebrow, 'Roadmap, not built yet', id);
        assert.ok(s.lede.length > 20, id);
        assert.match(s.note, /^Not built yet\./, id);
        assert.ok(!/[—–]/.test(s.lede + s.note), id);
        await page.context().close();
      }
    });

    await t.test('an unknown route shows Page not found with a link back to Overview, not Overview', async () => {
      const page = await openPage(1440, '#/nonsense');
      const s = await page.evaluate(() => ({
        visible: [...document.querySelectorAll('[data-screen]')].filter((e) => !e.hidden).map((e) => e.getAttribute('data-screen')),
        h1: document.querySelector('[data-screen="notfound"] h1').textContent,
        title: document.title,
        current: document.querySelectorAll('[data-nav][aria-current="page"]').length,
      }));
      assert.deepEqual(s.visible, ['notfound']);
      assert.equal(s.h1, 'Page not found');
      assert.match(s.title, /^Page not found/);
      assert.equal(s.current, 0);
      await page.click('[data-role="notfound-home"]');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ hash: location.hash, visible: [...document.querySelectorAll('[data-screen]')].filter((e) => !e.hidden).map((e) => e.getAttribute('data-screen')) }));
      assert.equal(after.hash, '#/overview');
      assert.deepEqual(after.visible, ['overview']);
      await page.context().close();
    });

    await t.test('empty hash and a real route are not "not found"', async () => {
      const page = await openPage(1440);
      assert.equal(await page.$eval('[data-screen="notfound"]', (e) => e.hidden), true);
      assert.equal(await page.$eval('[data-screen="overview"]', (e) => e.hidden), false);
      await page.context().close();
    });

    await t.test('axe (wcag2a/aa plus region) is clean on the roadmap and not-found states at 1440 and 390', async () => {
      for (const width of [1440, 390]) {
        for (const hash of ['#/memory', '#/nonsense']) {
          const page = await openPage(width, hash);
          assert.deepEqual(await axeViolations(page), [], `${width} ${hash}`);
          await page.context().close();
        }
      }
    });

    await t.test('forced-colors: the roadmap group stays visible and bordered', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, forcedColors: 'active' });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/auth?token=${token}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-role="side"] .is-roadmap');
      const b = await page.$eval('[data-role="side"] .is-roadmap', (e) => ({ w: getComputedStyle(e).borderTopWidth, vis: e.getBoundingClientRect().height > 0 }));
      assert.equal(b.w, '1px');
      assert.equal(b.vis, true);
      await ctx.close();
    });
  } finally {
    await stopFixture();
  }
});
