'use strict';

/*
 * Keyboard focus is never hidden under the narrow window's bars (issue 178, docs/decisions/0070-focus-not-hidden-by-bars.md).
 * Runs the panel in this process on OS-chosen ports, on a scratch copy of the sample vault with a scratch config, and drives
 * real Chromium and Firefox with real key presses (PLAYWRIGHT_MODULE; skips, loudly, without it). The check is an injected
 * stand-in, so the browser and the server reach nothing but this computer.
 *
 * Forcing cases B1, B2, B3 and T1 press Tab (or Shift+Tab) from a fresh load until the intended control has focus, then
 * require that at least part of it sits between the top bar and the bottom edge. The bottom edge is the top of the bottom bar,
 * lowered to the top of the screen's unsaved-changes strip when that strip is shown and pinned and does not hold the control.
 * L1 (the Updates card landing) and W1 (the wide window's scroll padding) pass on main as well, so they prove nothing alone:
 * they guard what must not move. This file does not prove a real Windows browser, real zoom, WebKit, or controls that are only
 * partly hidden (see C215 in .agents/windows-verification.md and the limits in ADR 0070).
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
const SKIP = pw ? false : 'playwright not available (set PLAYWRIGHT_MODULE)';

const LONG_TITLE = 'The Very Long Winded Chronicle of the Seven Drowned Kingdoms and Their Many Feuds Z'.slice(0, 80);
const AVAILABLE = { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: 'unused' };
const MAX_PRESSES = 120;

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Each case names the control it must reach, written out by hand from the screens' markup.
const CASES = [
  { id: 'B1', screen: 'title', what: 'the Site title input', key: 'Tab', viewports: [[390, 600], [320, 568]], match: { id: 'pack-title-input' } },
  { id: 'B2', screen: 'title', what: 'the Landing tagline textarea', key: 'Tab', viewports: [[390, 844]], match: { id: 'pack-tagline-input' } },
  { id: 'B3', screen: 'vocab', what: 'the "Show the file" summary', key: 'Tab', viewports: [[390, 600], [320, 568]], match: { tag: 'SUMMARY', text: /Show the file/ } },
  { id: 'T1', screen: 'overview', what: 'the "Edit title and tagline" link', key: 'Shift+Tab', viewports: [[390, 844]], match: { tag: 'A', text: /Edit title and tagline/ } },
];

for (const browserName of ['chromium', 'firefox']) {
  /** Runs `fn` with a fresh in-process panel (one campaign, an 80-character site title, an update available) and a browser. */
  async function withPanel(t, fn) {
    const fx = makeCampaigns(t, ['alpha']);
    const vcj = path.join(fx.vaults.alpha, '_meta', 'scriptorium', 'vault.config.json');
    assert.equal(fs.existsSync(vcj), true, 'the scratch vault has a vault.config.json');
    const conf = JSON.parse(fs.readFileSync(vcj, 'utf8'));
    conf.siteTitle = LONG_TITLE;
    fs.writeFileSync(vcj, JSON.stringify(conf, null, 2));
    const result = await startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
      emit() {},
      startLocalListener,
      startPanelListener: async () => {
        throw new Error('no remote listener expected');
      },
      updateDeps: { isPkg: true, check: async () => AVAILABLE, currentVersion: '1.0.0' },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await settle();
    result.ctx.desktop = { ports: { panel: result.ctx.adminPort, preview: result.ctx.previewPort } };
    const base = `http://127.0.0.1:${result.ctx.adminPort}`;
    const browser = await pw[browserName].launch();
    try {
      /** A signed-in page loaded at `#/<screen>`, with the screen drawn and the web fonts in. */
      const open = async (width, height, screen) => {
        const bctx = await browser.newContext({ viewport: { width, height } });
        const page = await bctx.newPage();
        await page.goto(`${base}/auth?token=${result.token}`, { waitUntil: 'load' });
        await page.waitForSelector('[data-screen="overview"]');
        // One real navigation. A hash-only goto from "/" is same-document, and a reload after it can reload the "/" entry in Firefox under load, losing the hash.
        // The query makes the URL differ from "/" so the load is a full document load; the panel ignores it.
        await page.goto(`${base}/?s=${screen}#/${screen}`, { waitUntil: 'load' });
        // A screen may extend its own hash (vocab rewrites it to #/vocab/<tab>), so accept the screen's own sub-paths.
        await page.waitForFunction((h) => location.hash === h || location.hash.startsWith(h + '/'), `#/${screen}`, { timeout: 5000 });
        await page.waitForSelector(`[data-screen="${screen}"]`);
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        await page.evaluate(() => document.fonts.ready);
        return page;
      };
      await fn({ open });
    } finally {
      await browser.close();
      await result.stop();
    }
  }

  /** Presses `key` until the case's control has focus. Returns the press count and the geometry the contract needs. */
  async function pressTo(page, c) {
    const m = { id: c.match.id || null, tag: c.match.tag || null, text: c.match.text ? c.match.text.source : null };
    for (let n = 1; n <= MAX_PRESSES; n++) {
      await page.keyboard.press(c.key);
      const hit = await page.evaluate((want) => {
        const e = document.activeElement;
        if (!e || e === document.body) return false;
        if (want.id) return e.id === want.id;
        return e.tagName === want.tag && new RegExp(want.text).test(e.textContent);
      }, m);
      if (hit) return n;
    }
    return null;
  }

  /** The control's rect, the top bar's bottom, and the lowest edge the control may reach (the assertion contract). */
  function measure(page) {
    return page.evaluate(() => {
      const e = document.activeElement;
      const r = e.getBoundingClientRect();
      const topBar = document.querySelector('[data-role="top-bar"]');
      const bottomBar = document.querySelector('[data-role="bottom-bar"]');
      const topEdge = topBar.getBoundingClientRect().bottom;
      let bottomEdge = bottomBar.getBoundingClientRect().top;
      const screenEl = document.querySelector('[data-screen]:not([hidden])');
      const strip = screenEl && screenEl.querySelector('.a1-pending:not([hidden])');
      if (strip && getComputedStyle(strip).display !== 'none' && !strip.contains(e)) {
        const sr = strip.getBoundingClientRect();
        if (sr.height > 0 && Math.abs(sr.bottom - bottomBar.getBoundingClientRect().top) <= 1) bottomEdge = Math.min(bottomEdge, sr.top);
      }
      return { top: r.top, bottom: r.bottom, topEdge, bottomEdge, scrollY: window.scrollY };
    });
  }

  for (const c of CASES) {
    for (const [width, height] of c.viewports) {
      test(`${c.id} in ${browserName} at ${width}x${height}: ${c.key} to ${c.what} on #/${c.screen} leaves it between the bars`, { skip: SKIP, timeout: 240000 }, async (t) => {
        await withPanel(t, async ({ open }) => {
          const page = await open(width, height, c.screen);
          const presses = await pressTo(page, c);
          assert.notEqual(presses, null, `${c.what} was not reached within ${MAX_PRESSES} presses`);
          const g = await measure(page);
          t.diagnostic(`${c.id} ${browserName} ${width}x${height}: ${presses} presses, rect ${g.top.toFixed(1)}-${g.bottom.toFixed(1)}, edges ${g.topEdge.toFixed(1)}/${g.bottomEdge.toFixed(1)}, scrollY ${g.scrollY}`);
          assert.ok(
            g.bottom > g.topEdge && g.top < g.bottomEdge,
            `${c.what} is entirely under a bar: rect ${g.top.toFixed(1)}-${g.bottom.toFixed(1)}, top edge ${g.topEdge.toFixed(1)}, bottom edge ${g.bottomEdge.toFixed(1)}, after ${presses} presses`
          );
        });
      });
    }
  }

  test(`L1 in ${browserName}: "Turn off update checks" lands the Updates card 16 px below the narrow top bar`, { skip: SKIP, timeout: 240000 }, async (t) => {
    // ADR 0057 section 11 keeps 16 px of room above the card. The band allows for the engines' rounding.
    await withPanel(t, async ({ open }) => {
      const page = await open(390, 600, 'overview');
      await page.waitForSelector('#updates');
      await page.locator('[data-part="update-notice"] a', { hasText: 'Turn off update checks' }).click();
      await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-ctl') === 'switch');
      await page.evaluate(() => document.fonts.ready);
      const gap = await page.evaluate(() => document.getElementById('updates').getBoundingClientRect().top - document.querySelector('[data-role="top-bar"]').getBoundingClientRect().bottom);
      assert.ok(gap >= 15 && gap <= 17.5, `the card's top is ${gap} px below the top bar's bottom`);
    });
  });

  test(`W1 in ${browserName}: a window of 700 px or wider has no scroll padding`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, async ({ open }) => {
      for (const [width, height] of [[1280, 800], [700, 800]]) {
        const page = await open(width, height, 'title');
        const pad = await page.evaluate(() => {
          const s = getComputedStyle(document.documentElement);
          return { top: s.scrollPaddingTop, bottom: s.scrollPaddingBottom };
        });
        assert.deepEqual(pad, { top: 'auto', bottom: 'auto' }, `at ${width}x${height}`);
      }
    });
  });
}
