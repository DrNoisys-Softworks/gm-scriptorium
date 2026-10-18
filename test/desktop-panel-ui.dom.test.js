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
  async function withPanel(t, { desktop, check }, fn) {
    const fx = makeCampaigns(t, ['alpha']);
    addPending(fx.panelDir, 'alpha');
    const result = await startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
      emit() {},
      startLocalListener,
      startPanelListener: async () => {
        throw new Error('no remote listener expected');
      },
      updateDeps: { isPkg: true, check: check || (() => Promise.resolve(FULL)), currentVersion: '1.0.0' },
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
      const open = async (size = WIDTHS[0], { waitCard = true, hash = '', prepare } = {}) => {
        const bctx = await browser.newContext({ viewport: size });
        const page = await bctx.newPage();
        const problems = [];
        page.on('console', (m) => {
          if (m.type() === 'error') problems.push(m.text());
        });
        page.on('pageerror', (e) => problems.push(String(e)));
        page.problems = problems;
        if (prepare) page.prepared = await prepare(page);
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

  /**
   * Runs `go` (a reload) and waits until the page has booted far enough for a landing to have happened:
   * the session answered, the Updates card and the welcome are in the page (attached; the Overview is
   * hidden on the Images screen), and the web fonts are in, which is what the landing waits for.
   */
  async function bootedWithoutLanding(page, go) {
    const session = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session');
    await go();
    await session;
    await page.waitForSelector('#updates', { state: 'attached' });
    await page.waitForSelector('[data-part="welcome"]', { state: 'attached' });
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    await page.evaluate(() => document.fonts.ready);
  }

  test(`the updates landing in ${browserName}: Overview, the Updates card in view, its switch focused once; a reload does not land again`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      for (const size of WIDTHS) {
        const page = await open(size, { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        await armLanding(ctx, page, { to: 'updates', expiresAt: Date.now() + 15000 });
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
        await bootedWithoutLanding(page, () => page.reload({ waitUntil: 'load' }));
        assert.equal(await page.evaluate(() => window.location.hash), '#/images', 'the address is still the Images screen after boot');
        assert.equal(await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-ctl')) || ''), '', 'a reload lands nowhere');
      }
    });
  });

  // Test-only counters for the landing: how often the card is scrolled to, how often its switch takes
  // focus, and whether the GM's input reached the page. Everything calls through.
  const LANDING_COUNTERS = () => {
    window.__n = { si: 0, sw: 0, input: 0 };
    const osi = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) {
      window.__n.si++;
      return osi.apply(this, a);
    };
    document.addEventListener('focusin', (e) => {
      if (e.target.closest && e.target.closest('#updates') && e.target.getAttribute('data-ctl') === 'switch') window.__n.sw++;
    }, true);
    for (const type of ['wheel', 'keydown']) window.addEventListener(type, () => { window.__n.input++; }, true);
  };

  /** Holds every request that matches `glob` until release(); `seen` resolves on the first one held. */
  async function holdRequests(page, glob) {
    let released = false;
    const held = [];
    let seen;
    const first = new Promise((resolve) => { seen = resolve; });
    await page.route(glob, (route) => {
      if (released) return route.continue();
      held.push(route);
      seen();
    });
    return {
      seen: first,
      release: async () => {
        released = true;
        for (const r of held.splice(0)) await r.continue();
      },
    };
  }

  const restOrder = (page) => page.evaluate(() => [...document.querySelector('[data-part="ov-rest"]').children].map((c) => c.getAttribute('data-part') || c.tagName.toLowerCase()));
  const cardInView = (page) => page.evaluate(() => {
    const r = document.getElementById('updates').getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  });
  const switchFocused = (page) => page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-ctl') === 'switch');
  const fontsLoaded = (page) => page.waitForFunction(() => document.fonts.status === 'loaded');

  /**
   * Hands the tray's one-shot landing to the panel for the NEXT load. The server gives it to whichever page
   * asks for its session first, so the opened page must have had its own session answer before this arms it.
   */
  async function armLanding(ctx, page, landing) {
    // The Overview is built only after the page's own session answer, so its presence is that answer. Keep this the first line: the assignment below must wait for it.
    await page.waitForSelector('[data-screen="overview"]', { state: 'attached' });
    ctx.launchLanding = landing;
  }

  test(`the landing is armed only after the opened page has its own session answer in ${browserName}`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      const landing = { to: 'updates', expiresAt: Date.now() + 15000 };
      const page = await open(WIDTHS[0], { hash: '#/images', waitCard: false, prepare: (p) => holdRequests(p, '**/api/session') });
      await page.prepared.seen;
      const armed = armLanding(ctx, page, landing);
      assert.equal(ctx.launchLanding ?? null, null, 'nothing is armed while the opened page waits for its session answer');
      await page.prepared.release();
      await armed;
      assert.deepEqual(ctx.launchLanding, landing, 'the opened page booted without taking it');
      await page.reload({ waitUntil: 'load' });
      await switchFocused(page);
      assert.equal(ctx.launchLanding, null, 'the reload took it');
    });
  });

  /** The tray's landing on a fresh load, with the web fonts held back. Resolves once the Overview is drawn in full. */
  async function landWithFontsHeld(ctx, page) {
    // The page from open() has taken its session answer once the frame is built; until then it could take the landing meant for the reload.
    await page.waitForSelector('[data-screen="overview"]', { state: 'attached' });
    await page.addInitScript(LANDING_COUNTERS);
    const fonts = await holdRequests(page, '**/assets/fonts/**');
    ctx.launchLanding = { to: 'updates', expiresAt: Date.now() + 15000 };
    await page.reload({ waitUntil: 'load' });
    await fonts.seen;
    await page.waitForSelector('#updates');
    await page.waitForSelector('[data-part="welcome"]');
    await page.waitForSelector('#desktop-ports');
    return fonts;
  }

  test(`the landing after late web fonts in ${browserName}: the card ends in view and its switch focused once`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      for (const size of WIDTHS) {
        const page = await open(size, { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        const fonts = await landWithFontsHeld(ctx, page);
        const orderBefore = await restOrder(page);
        await fonts.release();
        await fontsLoaded(page);
        await switchFocused(page);
        const inView = await page.evaluate(() => {
          const r = document.getElementById('updates').getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight;
        });
        assert.equal(inView, true, `the card is scrolled into view at ${size.width}`);
        assert.deepEqual(await page.evaluate(() => ({ si: window.__n.si, sw: window.__n.sw })), { si: 1, sw: 1 }, 'one scroll, one focus');
        assert.deepEqual(await restOrder(page), orderBefore, 'the landing moved no node');

        await page.evaluate(() => {
          const A = window.ScriptoriumAdmin;
          A.store.set({ busy: !A.store.get().busy });
          A.store.set({ busy: !A.store.get().busy });
        });
        assert.equal(await page.evaluate(() => window.__n.si), 1, 'drawing the Overview again does not land again');
        const order = await restOrder(page);
        assert.ok(order.indexOf('update-setting') >= 0 && order.indexOf('desktop-slot') > order.indexOf('update-setting'), JSON.stringify(order));
      }
    });
  });

  test(`a card taller than the window in ${browserName}: the landing puts its top in view`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      const page = await open({ width: 390, height: 600 }, { hash: '#/images', waitCard: false });
      await page.waitForFunction(() => window.location.hash === '#/images');
      const fonts = await landWithFontsHeld(ctx, page);
      await fonts.release();
      await fontsLoaded(page);
      await switchFocused(page);
      const tall = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().height > window.innerHeight);
      assert.equal(tall, true, 'the card is taller than this window');
      const inView = await page.evaluate(() => {
        const r = document.getElementById('updates').getBoundingClientRect();
        return r.top >= 0 && r.top < window.innerHeight;
      });
      assert.equal(inView, true, 'the top of the card is in view');
      const below = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().top >= document.querySelector('[data-role="top-bar"]').getBoundingClientRect().bottom);
      assert.equal(below, true, 'the top edge is below the top bar');
    });
  });

  test(`the landing in ${browserName} keeps the Updates card's top edge below the narrow top bar`, { skip: SKIP, timeout: 240000 }, async (t) => {
    // 844 is a usual narrow window. 760 is a band height: the card is 722 to 723 px tall at 390 wide, so 760
    // leaves 36 to 38 px, under the 59 px (the 75 px top bar less 16 px) inside which centring the card with
    // the space kept above it would put its top under the bar.
    await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
      for (const size of [{ width: 390, height: 844 }, { width: 390, height: 760 }]) {
        const page = await open(size, { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        const fonts = await landWithFontsHeld(ctx, page);
        await fonts.release();
        await fontsLoaded(page);
        await switchFocused(page);
        await page.evaluate(() => document.fonts.ready);
        if (size.height === 760) {
          const slack = await page.evaluate(() => 760 - document.getElementById('updates').getBoundingClientRect().height);
          assert.ok(slack > 0 && slack < 59, `760 is a band height for this card (${slack} px to spare)`);
        }
        const inView = await page.evaluate(() => {
          const r = document.getElementById('updates').getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight;
        });
        assert.equal(inView, true, `the top of the card is in view at ${size.height}`);
        const below = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().top >= document.querySelector('[data-role="top-bar"]').getBoundingClientRect().bottom);
        assert.equal(below, true, `the top edge is below the top bar at ${size.height}`);
      }
    });
  });

  /**
   * The tray's landing on a fresh load when the ports answer comes first: the update answer is held until
   * the welcome and the ports card are in, so the Updates card is drawn last. Resolves once the switch has
   * focus (the landing's last act) and the web fonts are in (the landing's own condition, checked again here).
   */
  async function landWithPortsAnswerFirst(ctx, page) {
    await page.waitForSelector('[data-screen="overview"]', { state: 'attached' });
    await page.addInitScript(LANDING_COUNTERS);
    const update = await holdRequests(page, '**/api/update');
    ctx.launchLanding = { to: 'updates', expiresAt: Date.now() + 15000 };
    await page.reload({ waitUntil: 'load' });
    await update.seen;
    await page.waitForSelector('[data-part="welcome"]');
    await page.waitForSelector('#desktop-ports');
    await update.release();
    await page.waitForSelector('[data-part="update-setting"]');
    await switchFocused(page);
    await fontsLoaded(page);
    await page.evaluate(() => document.fonts.ready);
  }

  for (const shape of [
    { size: { width: 390, height: 600 }, narrow: true },
    { size: { width: 1280, height: 400 }, narrow: false },
  ]) {
    test(`a tall Updates card when the ports answer comes first in ${browserName} at ${shape.size.width}x${shape.size.height}: drawn above the ports card, the landing keeps room above it${shape.narrow ? ' and below the top bar' : ''}`, { skip: SKIP, timeout: 240000 }, async (t) => {
      await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
        const page = await open(shape.size, { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        await landWithPortsAnswerFirst(ctx, page);
        assert.deepEqual(await restOrder(page), ['div', 'section', 'update-setting', 'desktop-slot'], 'the Updates card is drawn above the ports card');
        const tall = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().height > window.innerHeight);
        assert.equal(tall, true, 'the card is taller than this window');
        const inView = await page.evaluate(() => {
          const r = document.getElementById('updates').getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight;
        });
        assert.equal(inView, true, 'the top of the card is in view');
        if (!shape.narrow) {
          // ADR 0057 section 11: 16 px of room; a whole-pixel scroll position can take up to half a pixel.
          const room = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().top);
          assert.ok(room >= 15, `the card keeps its room above it (${room} px)`);
        }
        if (shape.narrow) {
          const below = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().top >= document.querySelector('[data-role="top-bar"]').getBoundingClientRect().bottom);
          assert.equal(below, true, 'the top edge is below the top bar');
        }
        assert.deepEqual(await page.evaluate(() => ({ si: window.__n.si, sw: window.__n.sw })), { si: 1, sw: 1 }, 'one scroll, one focus');
      });
    });
  }

  const CARD_FIRST = ['div', 'section', 'update-setting', 'desktop-slot'];

  /** Opens the Overview once the Updates card and the ports card are both drawn. */
  async function openWithPortsDrawn(open) {
    const page = await open(WIDTHS[0], { prepare: (p) => holdRequests(p, '**/api/desktop') });
    await page.prepared.release();
    await page.waitForSelector('#desktop-ports');
    return page;
  }

  test(`the Updates switch in ${browserName} redraws the card where it was, above the ports card`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { desktop: true }, async ({ open }) => {
      const page = await openWithPortsDrawn(open);
      assert.deepEqual(await restOrder(page), CARD_FIRST, 'the Updates card is drawn above the ports card');
      await page.locator('#updates [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('#updates [role="switch"]').getAttribute('aria-checked') === 'false');
      assert.deepEqual(await restOrder(page), CARD_FIRST, 'the redrawn Updates card is still above the ports card');
    });
  });

  test(`a poll while the update check runs in ${browserName} redraws the card where it was, above the ports card`, { skip: SKIP, timeout: 240000 }, async (t) => {
    let finish;
    const held = new Promise((resolve) => { finish = resolve; });
    try {
      await withPanel(t, { desktop: true, check: () => held }, async ({ open, ctx }) => {
        const page = await openWithPortsDrawn(open);
        assert.deepEqual(await restOrder(page), CARD_FIRST, 'the Updates card is drawn above the ports card');
        assert.equal(ctx.updateNotice.snapshot().state, 'checking');
        const polled = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/update');
        finish(FULL);
        await polled;
        // The banner is drawn in the same pass as the card, so it is the real sign of the poll's redraw.
        await page.waitForSelector('[data-part="update-notice"]');
        assert.deepEqual(await restOrder(page), CARD_FIRST, 'the card the poll redrew is still above the ports card');
      });
    } finally {
      finish(FULL);
    }
  });

  test(`the landing in ${browserName} leaves the page alone when the GM scrolls or moves focus before the fonts arrive`, { skip: SKIP, timeout: 240000 }, async (t) => {
    for (const act of ['wheel', 'tab', 'focus']) {
      await withPanel(t, { desktop: true }, async ({ open, ctx }) => {
        const page = await open(WIDTHS[1], { hash: '#/images', waitCard: false });
        await page.waitForFunction(() => window.location.hash === '#/images');
        const fonts = await landWithFontsHeld(ctx, page);
        if (act === 'wheel') {
          await page.mouse.move(200, 300);
          await page.mouse.wheel(0, 200);
        } else if (act === 'tab') {
          await page.keyboard.press('Tab');
        } else {
          await page.evaluate(() => document.querySelector('[data-part="welcome"] a, [data-part="welcome"] button').focus());
        }
        if (act !== 'focus') await page.waitForFunction(() => window.__n.input > 0);
        await fonts.release();
        await fontsLoaded(page);
        await page.evaluate(() => document.fonts.ready);
        assert.deepEqual(await page.evaluate(() => ({ si: window.__n.si, sw: window.__n.sw })), { si: 0, sw: 0 }, `no scroll and no focus after a ${act}`);
      });
    }
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
      await armLanding(ctx, page, { to: 'updates', expiresAt: Date.now() - 1 });
      await bootedWithoutLanding(page, () => page.reload({ waitUntil: 'load' }));
      assert.equal(await page.evaluate(() => window.location.hash), '#/images', 'the address is still the Images screen after boot');
      assert.equal(await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-ctl')) || ''), '', 'an expired landing focuses nothing');
    });
  });
}
