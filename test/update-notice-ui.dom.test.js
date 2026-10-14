'use strict';

/*
 * The Overview update banner and the Updates card in real browsers (Chromium and Firefox via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core, found beside
 * PLAYWRIGHT_MODULE or via AXE_CORE_PATH). The panel runs in this process on OS-chosen ports, on a
 * scratch copy of the sample vault with a scratch config, and the check is an injected stand-in, so
 * the browser and the server reach nothing but this computer. Every expected string is written out
 * by hand (docs/decisions/0028-installer-and-first-run.md, addendum "The update notice").
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
const { readState } = require('../src/admin/updatenotice');

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
  { width: 390, height: 844 },
];
const TAG_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1.0.1';
const APOS = '’';

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function stubCheck(reply) {
  const calls = [];
  const check = (args) => {
    calls.push({ channel: args.channel, currentVersion: args.currentVersion });
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(typeof reply === 'function' ? reply(args) : reply);
  };
  check.calls = calls;
  return check;
}

for (const browserName of ['chromium', 'firefox']) {
  /** Runs `fn` with a fresh in-process panel and a browser. */
  async function withPanel(t, { updateText, reply, currentVersion = '1.0.0' }, fn) {
    const fx = makeCampaigns(t, ['alpha']);
    if (updateText) fs.appendFileSync(fx.configPath, `\n${updateText}\n`);
    const check = stubCheck(reply);
    const result = await startAdminPanel({ admin: true, config: fx.configPath }, undefined, {
      emit() {},
      startLocalListener,
      startPanelListener: async () => {
        throw new Error('no remote listener expected');
      },
      updateDeps: { isPkg: true, check, currentVersion },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    await settle();
    const base = `http://127.0.0.1:${result.ctx.adminPort}`;
    const browser = await pw[browserName].launch();
    try {
      const open = async (size = WIDTHS[0]) => {
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
        await page.waitForSelector('#updates');
        return page;
      };
      await fn({ fx, check, ctx: result.ctx, open, base });
    } finally {
      await browser.close();
      await result.stop();
    }
  }

  const BETA = { state: 'available', tag: 'v1.1.0-rc.4', prerelease: true, notesUrl: 'unused' };
  const FULL = { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: 'unused' };

  const bannerText = (page) => page.locator('[data-part="update-notice"]').innerText();
  const cardText = (page) => page.locator('#updates').innerText();
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test(`the banner and card in ${browserName}: a beta build with a prerelease available, at 1440 and 390, axe clean, no horizontal scroll`, { skip: SKIP, timeout: 240000 }, async (t) => {
    await withPanel(t, { reply: BETA, currentVersion: '1.0.0-rc.3' }, async ({ open }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        const banner = page.locator('[data-part="update-notice"]');
        assert.equal(await banner.count(), 1);
        assert.equal(await banner.getAttribute('role'), 'status');
        const text = await bannerText(page);
        assert.match(text, /GM-Scriptorium 1\.1\.0-rc\.4 is available \(beta\)/);
        assert.match(text, /You have 1\.0\.0-rc\.3\./);
        assert.ok(text.includes(`What${APOS}s new`));
        assert.match(text, /To update, run the new installer, or gm-scriptorium update\./);
        assert.match(text, /Not now hides this until a newer version comes out on your channel\. Turn off update checks/);
        const link = banner.locator('a', { hasText: 'new' });
        assert.equal(await link.getAttribute('href'), 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1.1.0-rc.4');
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        const heroFollows = await page.evaluate(() => document.querySelector('[data-part="update-notice"]').nextElementSibling.matches('header.a1-hero'));
        assert.equal(heroFollows, true, 'the banner sits immediately above the hero');
        assert.equal(await page.locator('[data-part="update-notice"] button').getAttribute('type'), 'button');

        const card = await cardText(page);
        assert.match(card, /^Updates/);
        assert.match(card, /Check for updates once a day/);
        assert.match(card, /Update channel/);
        assert.match(card, /Stable\s+Full releases only\. Recommended for most GMs\./);
        assert.match(card, /Beta\s+Also try prereleases early\. Expect rough edges\./);
        assert.match(card, /You are running 1\.0\.0-rc\.3, a prerelease build, so Beta is selected for you\. Saved as \[update\] channel in config\.toml\./);
        assert.match(card, /GM-Scriptorium only tells you about updates\. It never installs one by itself\./);
        assert.match(card, /Last checked today at \d{1,2}:\d{2} (am|pm)\. A newer version, 1\.1\.0-rc\.4, was found\./);
        assert.match(card, /Privacy\. When this is on, GM-Scriptorium asks GitHub about once a day whether a newer version is out, and once more when you change the channel\. If a check fails it tries again the next time it starts\./);
        assert.match(card, /Saved as \[update\] check = true in .*config\.toml\. Turning it off takes effect straight away\./);
        assert.equal(await page.locator('#updates [role="switch"]').getAttribute('aria-checked'), 'true');
        assert.equal(await page.locator('input[name="upd-channel"][value="beta"]').isChecked(), true);
        assert.equal(await page.locator('input[name="upd-channel"][value="stable"]').isChecked(), false);
        assert.equal(await noHScroll(page), true, `no horizontal scroll at ${size.width}`);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
        assert.deepEqual(page.problems, [], 'no console errors or CSP violations');
      }
    });
  });

  test(`the banner on a stable build in ${browserName}: no channel word, Stable selected`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open }) => {
      const page = await open();
      const text = await bannerText(page);
      assert.match(text, /GM-Scriptorium 1\.0\.1 is available\n/);
      assert.doesNotMatch(text, /\(beta\)/);
      assert.match(text, /You have 1\.0\.0\./);
      assert.equal(await page.locator('input[name="upd-channel"][value="stable"]').isChecked(), true);
      assert.match(await cardText(page), /You are running 1\.0\.0, a stable build, so Stable is selected for you\./);
      assert.equal((await page.locator('[data-part="update-notice"] a').first().getAttribute('href')), TAG_URL);
    });
  });

  test(`Not now in ${browserName} removes the banner, persists in update-check.json, and survives a reload`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open, fx }) => {
      const page = await open();
      await page.locator('[data-part="update-notice"] button', { hasText: 'Not now' }).click();
      await page.waitForFunction(() => document.querySelector('[data-part="update-notice"]') === null);
      assert.equal(readState(fx.panelDir).dismissed, 'v1.0.1');
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#updates');
      assert.equal(await page.locator('[data-part="update-notice"]').count(), 0);
      assert.match(await cardText(page), /A newer version, 1\.0\.1, was found\./, 'the card still says what was found');
    });
  });

  test(`the switch in ${browserName}: turning it off removes the banner, locks the channel, says so, and saves check = false`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open, fx, check }) => {
      const page = await open();
      assert.equal(check.calls.length, 1);
      await page.locator('#updates [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-part="update-notice"]') === null);
      assert.equal(await page.locator('#updates [role="switch"]').getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('input[name="upd-channel"][value="beta"]').isDisabled(), true);
      assert.equal(await page.locator('input[name="upd-channel"][value="stable"]').isDisabled(), true);
      const card = await cardText(page);
      assert.match(card, /Update checks are off\. Last checked today at/);
      assert.match(card, /When this is off, GM-Scriptorium makes no internet requests on its own\./);
      assert.match(card, /Saved as \[update\] check = false in/);
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^\[update\]\ncheck = false$/m);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-ctl')), 'switch', 'the switch keeps focus');

      await page.locator('#updates [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('#updates [role="switch"]').getAttribute('aria-checked') === 'true');
      assert.match(await cardText(page), /Update checks are on\. The next check is tomorrow\./);
      assert.equal(await page.locator('input[name="upd-channel"][value="beta"]').isDisabled(), false);
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^check = true$/m);
      assert.equal(check.calls.length, 1, 'turning it back on does not check at once');
    });
  });

  test(`choosing Beta in ${browserName} saves channel = "beta" and checks once for beta`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: (args) => (args.channel === 'beta' ? BETA : FULL) }, async ({ open, fx, check }) => {
      const page = await open();
      await page.locator('input[name="upd-channel"][value="beta"]').check();
      await page.waitForFunction(() => /1\.1\.0-rc\.4/.test((document.querySelector('[data-part="update-notice"]') || { textContent: '' }).textContent), null, { timeout: 15000 });
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^channel = "beta"$/m);
      assert.deepEqual(check.calls.map((c) => c.channel), ['stable', 'beta']);
      assert.match(await bannerText(page), /\(beta\)/);
      assert.match(await cardText(page), /You chose Beta\. Saved as \[update\] channel in config\.toml\./);
    });
  });

  test(`an unreadable [update] entry in ${browserName}: both controls locked, the note names the config path, no check`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL, updateText: '[update]\ncheck = "yes"' }, async ({ open, fx, check }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        assert.equal(check.calls.length, 0);
        assert.equal(await page.locator('[data-part="update-notice"]').count(), 0);
        const sw = page.locator('#updates [role="switch"]');
        assert.equal(await sw.getAttribute('aria-disabled'), 'true');
        assert.equal(await page.locator('input[name="upd-channel"][value="stable"]').isDisabled(), true);
        assert.equal(await page.locator('input[name="upd-channel"][value="beta"]').isDisabled(), true);
        const before = fs.readFileSync(fx.configPath);
        await sw.click({ force: true });
        await settle();
        assert.deepEqual(fs.readFileSync(fx.configPath), before, 'a click on the locked switch writes nothing');
        const card = await cardText(page);
        assert.match(card, /Update checks are off\./);
        assert.match(card, /Both choices are locked until the file is fixed\./);
        assert.ok(card.includes(`that this version can${APOS}t read, so update checks are off and the channel is locked. Nothing is sent to GitHub.`));
        assert.ok(card.includes(fx.configPath), 'the real config path is named');
        assert.equal(await noHScroll(page), true);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
      }
    });
  });

  test(`a failed check in ${browserName}: no banner, one calm line in the card`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: new Error('down') }, async ({ open }) => {
      for (const size of WIDTHS) {
        const page = await open(size);
        assert.equal(await page.locator('[data-part="update-notice"]').count(), 0);
        const quiet = page.locator('[data-part="update-quiet"]');
        assert.equal(await quiet.count(), 1);
        assert.equal(await quiet.innerText(), `Couldn${APOS}t check for updates just now. GM-Scriptorium will try again tomorrow.`);
        assert.equal(await page.locator('#updates [role="alert"]').count(), 0);
        assert.equal(await noHScroll(page), true);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], `axe at ${size.width}`);
      }
    });
  });

  test(`nothing newer in ${browserName}: no banner and the newest-version line`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: { state: 'current' } }, async ({ open }) => {
      const page = await open();
      assert.equal(await page.locator('[data-part="update-notice"]').count(), 0);
      assert.match(await cardText(page), /Last checked today at .*\. You have the newest version on your channel\./);
    });
  });

  test(`"Turn off update checks" in ${browserName} scrolls to the card and focuses the switch without changing the address`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open }) => {
      const page = await open({ width: 390, height: 500 });
      const before = page.url();
      await page.locator('[data-part="update-notice"] a', { hasText: 'Turn off update checks' }).click();
      assert.equal(page.url(), before, 'the address did not change');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ctl')), 'switch');
      assert.equal(await page.locator('#updates [role="switch"]').isVisible(), true);
    });
  });

  test(`the banner and card come back from the cached answer on a re-render, without a second GET, in ${browserName}`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open }) => {
      const page = await open();
      let gets = 0;
      page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/api/update') gets++;
      });
      await page.evaluate(() => {
        location.hash = '#/vocab';
      });
      await page.waitForFunction(() => location.hash === '#/vocab');
      await page.evaluate(() => {
        location.hash = '#/overview';
      });
      await page.waitForFunction(() => location.hash === '#/overview');
      await page.waitForSelector('#updates');
      assert.equal(await page.locator('[data-part="update-notice"]').count(), 1);
      assert.equal(await page.locator('#updates').count(), 1);
      assert.equal(gets, 0);
    });
  });

  test(`whenText in ${browserName}: same local day gives "today at", another day gives "on D Mon YYYY"`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: { state: 'current' } }, async ({ open }) => {
      const page = await open();
      const out = await page.evaluate(() => {
        const w = window.ScriptoriumAdmin.updates.whenText;
        const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
        return [
          w(at(2026, 9, 14, 9, 14), at(2026, 9, 14, 17, 0)),
          w(at(2026, 9, 14, 0, 5), at(2026, 9, 14, 17, 0)),
          w(at(2026, 9, 14, 12, 0), at(2026, 9, 14, 17, 0)),
          w(at(2026, 9, 14, 23, 59), at(2026, 9, 14, 23, 59)),
          w(at(2026, 9, 10, 9, 14), at(2026, 9, 14, 17, 0)),
          w(at(2025, 0, 3, 18, 30), at(2026, 9, 14, 17, 0)),
          w(at(2026, 9, 13, 23, 59), at(2026, 9, 14, 0, 1)),
        ];
      });
      assert.deepEqual(out, ['today at 9:14 am', 'today at 12:05 am', 'today at 12:00 pm', 'today at 11:59 pm', 'on 10 Oct 2026', 'on 3 Jan 2025', 'on 13 Oct 2026']);
    });
  });

  test(`a config that changed under the page in ${browserName}: the switch says so and a second try works`, { skip: SKIP, timeout: 120000 }, async (t) => {
    await withPanel(t, { reply: FULL }, async ({ open, fx }) => {
      const page = await open();
      fs.appendFileSync(fx.configPath, '\n# edited in a terminal\n');
      await page.locator('#updates [role="switch"]').click();
      await page.waitForSelector('#updates [role="alert"]');
      assert.equal(await page.locator('#updates [role="alert"]').innerText(), 'Your settings changed outside the panel. Reload and try again.');
      assert.doesNotMatch(fs.readFileSync(fx.configPath, 'utf8'), /\[update\]/);
      await page.locator('#updates [role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('#updates [role="switch"]').getAttribute('aria-checked') === 'false');
      assert.match(fs.readFileSync(fx.configPath, 'utf8'), /^check = false$/m);
    });
  });
}
