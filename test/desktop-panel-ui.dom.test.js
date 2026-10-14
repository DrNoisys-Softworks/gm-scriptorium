'use strict';

/*
 * S5, "the panel knows the desktop app", in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE;
 * skips, loudly, without it; the axe checks also need axe-core, found via AXE_CORE_PATH). The panel runs
 * in this process on OS-chosen ports on a scratch copy of the sample vault; "desktop" is the same field
 * the desktop host sets (ctx.desktop). Every expected string is written out by hand (ADR 0028 section 7,
 * ADR 0057 sections 5 and 11). Nothing here reaches beyond this computer: the preview navigation is
 * answered by a stub route, so no page is loaded from any other origin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const { makeCampaigns } = require('./helpers/campaigns-panel');
const { startAdminPanel } = require('../src/cli/serve-admin');
const { startLocalListener } = require('../src/serve/server');
const { addPending } = require('../src/admin/welcome');

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
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

const WELCOME_DESKTOP = `This is your panel. Closing this tab doesn't stop GM-Scriptorium: it keeps running in the system tray, and its icon opens the panel again. Three good next steps:`;
const WELCOME_PLAIN = 'This is your panel. It runs on this computer while GM-Scriptorium is open. Three good next steps:';
const STOPPED_DESKTOP = 'Start it again from the GM-Scriptorium icon in the system tray, or from the Start menu.';
const STOPPED_PLAIN = 'Start it again to carry on.';
const HINT_BANNER_DESKTOP = 'To update, run the new installer, or choose Open command line (Advanced) from the tray menu and run gm-scriptorium update.';
const HINT_BANNER_PLAIN = 'To update, run the new installer, or gm-scriptorium update.';

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const FULL = { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: 'unused' };

for (const browserName of ['chromium', 'firefox']) {
  /** Runs `fn` with a fresh in-process panel (desktop or not) and a browser. */
  async function withPanel(t, { desktop }, fn) {
    const fx = makeCampaigns(t, ['alpha']);
    addPending(fx.panelDir, 'alpha');
    const result = await startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
      emit() {},
      startLocalListener,
      startPanelListener: async () => {
        throw new Error('no remote listener expected');
      },
      updateDeps: { isPkg: true, check: () => Promise.resolve(FULL), currentVersion: '1.0.0' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await settle();
    if (desktop) result.ctx.desktop = { ports: { panel: result.ctx.adminPort, preview: result.ctx.previewPort } };
    let stopped = false;
    const stopPanel = async () => {
      if (stopped) return;
      stopped = true;
      await result.stop();
    };
    const base = `http://127.0.0.1:${result.ctx.adminPort}`;
    const browser = await pw[browserName].launch();
    try {
      const open = async (size = WIDTHS[0], { waitCard = true, hash = '' } = {}) => {
        const bctx = await browser.newContext({ viewport: size });
        const page = await bctx.newPage();
        const problems = [];
        page.on('console', (m) => {
          if (m.type() === 'error') problems.push(m.text());
        });
        page.on('pageerror', (e) => problems.push(String(e)));
        page.problems = problems;
        await page.goto(`${base}/auth?token=${result.token}`, { waitUntil: 'load' });
        if (hash) await page.evaluate((h) => { window.location.hash = h; }, hash);
        await page.waitForFunction(() => document.querySelector('[data-screen="overview"]') !== null || window.location.hash !== '#/overview');
        if (waitCard) await page.waitForSelector('#updates');
        return page;
      };
      await fn({ fx, ctx: result.ctx, open, base, stopPanel });
    } finally {
      await browser.close();
      await stopPanel();
    }
  }

  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  for (const desktop of [true, false]) {
    const label = desktop ? 'under the desktop app' : 'without it';

    test(`the welcome line ${label} in ${browserName}, at 1280 and 390, axe clean`, { skip: SKIP, timeout: 240000 }, async (t) => {
      await withPanel(t, { desktop }, async ({ open }) => {
        for (const size of WIDTHS) {
          const page = await open(size);
          await page.waitForSelector('[data-part="welcome"]');
          const line = await page.locator('[data-part="welcome"] p').innerText();
          assert.equal(line, desktop ? WELCOME_DESKTOP : WELCOME_PLAIN);
          assert.equal(await noHScroll(page), true, `no horizontal scroll at ${size.width}`);
          if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
          assert.deepEqual(page.problems, [], 'no console errors or CSP violations');
        }
      });
    });

    test(`the update hint ${label} in ${browserName}: banner and card`, { skip: SKIP, timeout: 120000 }, async (t) => {
      await withPanel(t, { desktop }, async ({ open }) => {
        const page = await open();
        await page.waitForSelector('[data-part="update-notice"]');
        const banner = await page.locator('[data-part="update-notice"]').innerText();
        assert.ok(banner.includes(desktop ? HINT_BANNER_DESKTOP : HINT_BANNER_PLAIN), banner);
        await page.locator('#updates [role="switch"]').click();
        await page.waitForFunction(() => document.querySelector('#updates [role="switch"]').getAttribute('aria-checked') === 'false');
        const card = await page.locator('#updates').innerText();
        const off = desktop
          ? 'You can still update whenever you like: choose Open command line (Advanced) from the tray menu and run gm-scriptorium update.'
          : 'You can still run gm-scriptorium update whenever you like.';
        assert.ok(card.includes(off), card);
      });
    });

    test(`the stopped page ${label} in ${browserName}, at 1280 and 390, axe clean`, { skip: SKIP, timeout: 240000 }, async (t) => {
      for (const size of WIDTHS) {
        // A stopped panel stays stopped, so each width gets its own panel.
        await withPanel(t, { desktop }, async ({ open, stopPanel }) => {
          const page = await open(size);
          await stopPanel(); // nothing can be asked of the panel from here on
          await page.waitForSelector('main.stop', { timeout: 20000 });
          assert.equal(await page.locator('main.stop h1').innerText(), 'GM-Scriptorium has stopped');
          assert.equal(await page.locator('main.stop p.a1-fine').innerText(), desktop ? STOPPED_DESKTOP : STOPPED_PLAIN);
          assert.equal(await noHScroll(page), true, `no horizontal scroll at ${size.width}`);
          if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
          assert.deepEqual(page.problems.filter((p) => !/Failed to load resource|ERR_CONNECTION|NetworkError|Failed to fetch/i.test(p)), []);
        });
      }
    });
  }

  test(`the updates landing in ${browserName}: Overview, the Updates card in view, its switch focused once; a reload does not land again`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      for (const size of WIDTHS) {
        const page = await open(size, { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        ctx.launchLanding = { to: 'updates', expiresAt: Date.now() + 15000 };
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#updates');
        await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-ctl') === 'switch');
        assert.equal(await page.evaluate(() => window.location.hash), '#/overview');
        const inView = await page.evaluate(() => {
          const r = document.getElementById('updates').getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight;
        });
        assert.equal(inView, true, 'the card is scrolled into view');
        assert.equal(ctx.launchLanding, null, 'the server cleared it');

        await page.evaluate(() => { window.location.hash = '#/images'; });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.location.hash === '#/images');
        assert.equal(await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-ctl')) || ''), '', 'a reload lands nowhere');
      }
    });
  });

  test(`the preview landing in ${browserName}: the tab goes to the preview origin from the session (stubbed navigation, http and https)`, { skip: SKIP, timeout: 240000 }, async (t) => {
    for (const scheme of ['http', 'https']) {
      await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
        const page = await open(WIDTHS[0]);
        const target = `${scheme}://127.0.0.1:${ctx.previewPort}/`;
        const hits = [];
        await page.route(`${scheme}://127.0.0.1:${ctx.previewPort}/**`, (route) => {
          hits.push(route.request().url());
          route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>preview stub</title><p>stub</p>' });
        });
        ctx.access = { ...ctx.access, loopbackScheme: scheme };
        ctx.launchLanding = { to: 'preview', expiresAt: Date.now() + 15000 };
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction((u) => window.location.href === u, target);
        assert.deepEqual(hits, [target]);
        assert.equal(ctx.launchLanding, null);
      });
    }
  });

  test(`an expired landing is not followed in ${browserName}`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      const page = await open(WIDTHS[0], { hash: '#/images', waitCard: false });
      ctx.launchLanding = { to: 'updates', expiresAt: Date.now() - 1 };
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.location.hash === '#/images');
      await settle();
      assert.equal(await page.evaluate(() => window.location.hash), '#/images');
    });
  });
}
