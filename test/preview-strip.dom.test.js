'use strict';

/*
 * The not-live strip in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE; skips, loudly,
 * without it; the axe check also needs axe-core, found beside PLAYWRIGHT_MODULE or via AXE_CORE_PATH).
 * The panel runs in this process on OS-chosen loopback ports, on a scratch copy of the sample vault
 * with a scratch config. The page under test is a real preview page, served by the real preview
 * listener (docs/decisions/0035-preview-in-a-frame.md, addendum "The not-live strip"; mock frame
 * B06). Every expected string is written out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const { makeCampaigns, startPanel, call } = require('./helpers/campaigns-panel');

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

/*
 * axe on the strip itself. The preview site around it is the published theme (its own heading-order
 * and landmark findings are not this slice's), so the run is scoped to the strip; the strip is
 * itself a landmark, so the region rule still applies to it. A second, whole-page run must not name
 * the strip in any finding.
 */
async function axeViolations(page, scoped) {
  await page.evaluate(axeSource);
  return page.evaluate(async (isScoped) => {
    const r = await window.axe.run(isScoped ? { include: [['[data-scriptorium-preview-strip]']] } : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] },
      rules: { region: { enabled: true } },
    });
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(`${v.id}:${n.target.join(' ')}`)));
    return out;
  }, scoped);
}

const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const DOCS_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md';

for (const browserName of ['chromium', 'firefox']) {
  test(`the strip on a real preview page in ${browserName}: words, links, look, at 1280 and 390, axe clean, no horizontal scroll`, { skip: SKIP, timeout: 240000 }, async (t) => {
    const fx = makeCampaigns(t, ['alpha']);
    const h = await startPanel(t, { config: fx.configPath });
    const built = await call(h, 'POST', '/api/preview');
    assert.equal(built.status, 200, built.text);
    assert.equal(built.json.exitCode, 0, built.text);
    const browser = await pw[browserName].launch();
    t.after(() => browser.close());

    for (const size of WIDTHS) {
      const ctx = await browser.newContext({ viewport: size, extraHTTPHeaders: { Cookie: h.previewCookie } });
      const page = await ctx.newPage();
      const problems = [];
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
      });
      page.on('pageerror', (e) => problems.push(String(e)));
      await page.goto(`http://127.0.0.1:${h.previewPort}/`, { waitUntil: 'load' });

      const strip = page.locator('aside[data-scriptorium-preview-strip]');
      assert.equal(await strip.count(), 1, 'exactly one strip');
      assert.equal(await page.locator('[data-scriptorium-preview-strip]').count(), 1);
      assert.equal(await page.evaluate(() => document.body.firstElementChild.hasAttribute('data-scriptorium-preview-strip')), true, 'first thing in the body');
      assert.equal(await strip.getAttribute('aria-label'), 'Preview notice');
      assert.equal(await strip.locator('span').innerText(), 'Only you can see this page. Players see what you publish.');
      assert.equal(await strip.locator('strong').innerText(), 'Preview only, not your live site.');
      const back = strip.locator('a', { hasText: 'Back to the panel' });
      assert.equal(await back.getAttribute('href'), `http://127.0.0.1:${h.port}/`);
      const how = strip.locator('a', { hasText: 'How to publish' });
      assert.equal(await how.getAttribute('href'), DOCS_URL);
      assert.equal(await how.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await strip.locator('script').count(), 0);

      const look = await strip.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const a = el.querySelector('a');
        return {
          color: cs.color,
          border: cs.borderBottomColor,
          bgImage: cs.backgroundImage,
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          linkColor: getComputedStyle(a).color,
          linkDecoration: getComputedStyle(a).textDecorationLine,
          font: cs.fontSize,
        };
      });
      assert.equal(look.color, 'rgb(31, 26, 14)');
      assert.equal(look.border, 'rgb(154, 107, 0)');
      assert.match(look.bgImage, /repeating-linear-gradient/);
      assert.equal(look.top, 0);
      assert.equal(look.left, 0);
      assert.equal(look.width, size.width);
      assert.equal(look.linkColor, 'rgb(31, 26, 14)');
      assert.equal(look.linkDecoration, 'underline');
      assert.equal(look.font, '14px');

      const backBox = await back.boundingBox();
      const textBox = await strip.locator('span').boundingBox();
      if (size.width >= 700) {
        assert.ok(backBox.y < textBox.y + textBox.height, 'links share the row with the words at 1280');
        assert.ok(backBox.x > textBox.x + textBox.width - 1, 'links sit to the right of the words at 1280');
      } else {
        assert.ok(backBox.y >= textBox.y + textBox.height - 1, 'links drop below the words at 390');
      }
      const navClear = await page.evaluate(() => {
        const nav = document.querySelector('.top-nav');
        const st = document.querySelector('[data-scriptorium-preview-strip]').getBoundingClientRect();
        return nav ? nav.getBoundingClientRect().top >= st.bottom - 1 : null;
      });
      assert.notEqual(navClear, false, `the site's top bar must not sit on top of the strip at ${size.width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal scroll at ${size.width}`);
      if (!SKIP_AXE) {
        assert.deepEqual(await axeViolations(page, true), [], `axe on the strip at ${size.width}`);
        assert.deepEqual((await axeViolations(page, false)).filter((v) => v.includes('scriptorium-preview-strip')), [], `axe whole page names the strip at ${size.width}`);
      }
      assert.deepEqual(problems, [], 'no console errors');
      await ctx.close();
    }
  });
}
