'use strict';

/*
 * The desktop ports card ("This PC's addresses") in real browsers (Chromium and Firefox via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core, found beside
 * PLAYWRIGHT_MODULE or via AXE_CORE_PATH). The panel runs in this process on OS-chosen ports, on a
 * scratch copy of the sample vault with a scratch config, and the desktop host is a stand-in that
 * records the restart it is asked for, so nothing here restarts a real panel. Every expected string
 * is written out by hand (docs/decisions/0057-windows-desktop-app.md, section 8).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const { makeCampaigns } = require('./helpers/campaigns-panel');
const { testPort } = require('./helpers/ports');
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

// The ports typed into the card. Nothing binds them (the desktop host is a stand-in), but a fixed port comes only from testPort().
const PA = testPort(9760);
const PB = testPort(9761);

const WIDTHS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

for (const browserName of ['chromium', 'firefox']) {
  /** Runs `fn` with a fresh in-process panel and a browser. `desktop` false leaves the panel as a plain one. */
  async function withPanel(t, { desktop = true, mode = 'local', updates = false }, fn) {
    const fx = makeCampaigns(t, ['alpha']);
    const result = await startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
      emit() {},
      startLocalListener,
      startPanelListener: async () => {
        throw new Error('no remote listener expected');
      },
      updateDeps: updates ? { isPkg: true, check: () => Promise.resolve({ state: 'current' }), currentVersion: '1.0.0' } : { isPkg: false },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await settle();
    const restarts = [];
    if (desktop) {
      result.ctx.desktop = {
        requestRestart: (opts) => {
          restarts.push(opts);
          return Promise.resolve();
        },
        ports: { panel: result.ctx.adminPort, preview: result.ctx.previewPort },
      };
    }
    if (mode !== 'local') result.ctx.remote = { ...result.ctx.remote, settings: { ...result.ctx.remote.settings, mode } };
    const base = `http://127.0.0.1:${result.ctx.adminPort}`;
    const browser = await pw[browserName].launch();
    try {
      const open = async (size = WIDTHS[0], { card = true } = {}) => {
        const ctx = await browser.newContext({ viewport: size });
        const page = await ctx.newPage();
        const problems = [];
        page.on('console', (m) => {
          if (m.type() === 'error') problems.push(m.text());
        });
        page.on('pageerror', (e) => problems.push(String(e)));
        page.problems = problems;
        await page.goto(`${base}/auth?token=${result.token}`, { waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelector('[data-screen="overview"]') !== null);
        if (card) await page.waitForSelector('#desktop-ports');
        return page;
      };
      await fn({ fx, ctx: result.ctx, restarts, open, base });
    } finally {
      await browser.close();
      await result.stop();
    }
  }

  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const cardText = (page) => page.locator('#desktop-ports').innerText();
  const NOTE = 'Saving restarts GM-Scriptorium on the new ports and opens the panel there in a new tab. Bookmarks to the old address stop working.';

  test(`the card in ${browserName}: closed, then open, at 1280 and 390, axe clean, no horizontal scroll`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, {}, async ({ ctx, open }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        assert.equal(await page.locator('#desktop-ports').count(), 1, 'exactly one card');
        assert.equal(await page.locator('#desktop-ports h2').innerText(), "This PC's addresses");
        const closed = await cardText(page);
        assert.ok(closed.includes(`Panel\nhttp://127.0.0.1:${ctx.adminPort}`), closed);
        assert.ok(closed.includes(`Preview\nhttp://127.0.0.1:${ctx.previewPort}`), closed);
        assert.equal(await page.locator('#desktop-ports [data-ctl="change"]').count(), 1);
        assert.equal(await page.locator('#desktop-ports input').count(), 0, 'the fields are closed until Change');

        await page.locator('#desktop-ports [data-ctl="change"]').click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'pt-a', 'focus moves to the first field');
        assert.equal(await page.locator('#pt-a').inputValue(), String(ctx.adminPort));
        assert.equal(await page.locator('#pt-b').inputValue(), String(ctx.previewPort));
        assert.equal(await page.locator('label[for="pt-a"]').innerText(), 'Panel port');
        assert.equal(await page.locator('label[for="pt-b"]').innerText(), 'Preview port');
        const open2 = await cardText(page);
        assert.ok(open2.includes(NOTE), open2);
        assert.ok(open2.includes('Save and restart') && open2.includes('Cancel'), open2);
        assert.equal(await noHScroll(page), true, `no horizontal scroll at ${size.width}`);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);

        await page.locator('#desktop-ports [data-ctl="cancel"]').click();
        assert.equal(await page.locator('#desktop-ports input').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ctl')), 'change', 'Cancel gives focus back to Change');
        assert.deepEqual(page.problems, [], 'no console errors or CSP violations');
      }
    });
  });

  test(`a good save in ${browserName} writes the ports, asks for one restart and says so`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, {}, async ({ fx, restarts, open }) => {
      const page = await open();
      await page.locator('#desktop-ports [data-ctl="change"]').click();
      await page.locator('#pt-a').fill(String(PA));
      await page.locator('#pt-b').fill(String(PB));
      await page.locator('#desktop-ports [data-ctl="save"]').click();
      await page.waitForSelector('#desktop-ports [data-ctl="status"]');
      assert.equal(
        await page.locator('#desktop-ports [data-ctl="status"]').innerText(),
        `Saved. GM-Scriptorium is restarting on ports ${PA} and ${PB}, and a new tab opens there. You can close this one.`,
      );
      assert.equal(await page.locator('#desktop-ports [data-ctl="status"]').getAttribute('role'), 'status');
      assert.equal(await page.locator('#desktop-ports input').count(), 0);
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), new RegExp(`\\[desktop\\]\\s*\\nport = ${PA}\\s*\\npreview_port = ${PB}`));
      await settle();
      assert.deepEqual(restarts, [{ open: true }]);
      assert.deepEqual(page.problems, []);
    });
  });

  test(`ports the card refuses in ${browserName} send nothing and say why`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, {}, async ({ fx, restarts, open }) => {
      const before = fs.readFileSync(fx.configPath);
      const page = await open();
      const posts = [];
      page.on('request', (r) => {
        if (r.method() === 'POST') posts.push(r.url());
      });
      await page.locator('#desktop-ports [data-ctl="change"]').click();
      const cases = [
        ['', String(PB), 'Ports are whole numbers from 1 to 65535.'],
        ['abc', String(PB), 'Ports are whole numbers from 1 to 65535.'],
        [String(PA), '1e3', 'Ports are whole numbers from 1 to 65535.'],
        ['0', String(PB), 'Ports are whole numbers from 1 to 65535.'],
        ['70000', String(PB), 'Ports are whole numbers from 1 to 65535.'],
        [String(PA), String(PA), 'The panel and the preview need different ports.'],
      ];
      for (const [a, b, message] of cases) {
        await page.locator('#pt-a').fill(a);
        await page.locator('#pt-b').fill(b);
        await page.locator('#desktop-ports [data-ctl="save"]').click();
        assert.equal(await page.locator('#desktop-ports [role="alert"]').innerText(), message, `${a} / ${b}`);
      }
      assert.deepEqual(posts, []);
      assert.deepEqual(fs.readFileSync(fx.configPath), before);
      assert.deepEqual(restarts, []);
    });
  });

  test(`a refusal from the server in ${browserName} is shown and the card stays open`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, {}, async ({ fx, restarts, open }) => {
      const page = await open();
      await page.locator('#desktop-ports [data-ctl="change"]').click();
      fs.appendFileSync(fx.configPath, '\n# edited elsewhere\n');
      await page.locator('#pt-a').fill(String(PA));
      await page.locator('#pt-b').fill(String(PB));
      await page.locator('#desktop-ports [data-ctl="save"]').click();
      await page.waitForSelector('#desktop-ports [role="alert"]');
      assert.equal(await page.locator('#desktop-ports [role="alert"]').innerText(), 'Your settings changed outside the panel. Reload and try again.');
      assert.equal(await page.locator('#pt-a').inputValue(), String(PA), 'what was typed is kept');
      // The state was read again, so the same save now goes through.
      await page.locator('#desktop-ports [data-ctl="save"]').click();
      await page.waitForSelector('#desktop-ports [data-ctl="status"]');
      await settle();
      assert.deepEqual(restarts, [{ open: true }]);
    });
  });

  test(`in a remote mode the card in ${browserName} is read-only and names the remote ports`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { mode: 'tailscale' }, async ({ ctx, open }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        const text = await cardText(page);
        assert.ok(text.includes(`Panel\nhttp://127.0.0.1:${ctx.adminPort}`), text);
        assert.ok(text.includes(`Preview\nhttp://127.0.0.1:${ctx.previewPort}`), text);
        assert.ok(text.includes('Remote access uses its own ports. Change them with gm-scriptorium remote set.'), text);
        assert.equal(await page.locator('#desktop-ports button').count(), 0, 'no Change button');
        assert.equal(await page.locator('#desktop-ports input').count(), 0);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
      }
    });
  });

  test(`outside the desktop app the Overview in ${browserName} has no ports card`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { desktop: false }, async ({ open }) => {
      const page = await open(WIDTHS[0], { card: false });
      await page.waitForSelector('[data-part="ov-rest"] *');
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#desktop-ports').count(), 0);
      assert.equal(await page.locator('[data-part="desktop-slot"]').innerHTML(), '', 'the slot stays empty');
      assert.equal((await page.locator('body').innerText()).includes("This PC's addresses"), false);
    });
  });

  test(`the card in ${browserName} survives the Overview being drawn again: still one card, below Updates, with what was typed`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { updates: true }, async ({ open }) => {
      const page = await open();
      await page.waitForSelector('#updates');
      await page.locator('#desktop-ports [data-ctl="change"]').click();
      await page.locator('#pt-b').fill('7499');
      await page.evaluate(() => {
        const A = window.ScriptoriumAdmin;
        A.store.set({ busy: !A.store.get().busy });
        A.store.set({ busy: !A.store.get().busy });
      });
      await settle();
      assert.equal(await page.locator('#desktop-ports').count(), 1);
      assert.equal(await page.locator('[data-part="desktop-slot"]').count(), 1);
      assert.equal(await page.locator('#pt-b').inputValue(), '7499');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'pt-b', 'focus came back to the field it was in');
      const order = await page.evaluate(() => {
        const rest = document.querySelector('[data-part="ov-rest"]');
        return [...rest.children].map((c) => c.getAttribute('data-part') || c.tagName.toLowerCase());
      });
      const slotAt = order.indexOf('desktop-slot');
      assert.ok(slotAt >= 0, JSON.stringify(order));
      const updatesAt = order.indexOf('update-setting');
      assert.ok(updatesAt >= 0, JSON.stringify(order));
      assert.ok(slotAt > updatesAt, JSON.stringify(order));
    });
  });
}
