'use strict';

/*
 * ADR 0049: the folder picker in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE; skips,
 * loudly, without it; the axe checks also need axe-core, found beside PLAYWRIGHT_MODULE or via
 * AXE_CORE_PATH). The real bin runs in setup mode against a scratch tree with an isolated config.
 * Ports: 9449 (Chromium) and 9450 (Firefox); override the first with PICKER_UI_TEST_PORT (the
 * second is that plus one). The picker is driven with the keyboard, because that is how it is
 * specified; clicking is covered once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { SAMPLE } = require('./helpers/setup-fixtures');

const REPO = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.PICKER_UI_TEST_PORT || 9449);

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
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'picker-ui-')));
  const vault = path.join(H, 'vault');
  fs.cpSync(SAMPLE, vault, { recursive: true });
  fs.rmSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true, force: true });
  const work = path.join(H, 'work');
  for (const d of ['Alpha', 'beta', '.git', path.join('Alpha', 'inner')]) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.writeFileSync(path.join(work, 'notes-SENTINEL.txt'), 'x');
  fs.symlinkSync(path.join(work, 'Alpha'), path.join(work, 'lnk'));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
  return { H, vault, work, configPath: path.join(H, 'cfg', 'config.toml'), env };
}

async function typeInto(page, selector, text) {
  await page.focus(selector);
  await page.fill(selector, '');
  await page.keyboard.type(text);
}

async function toVault(page) {
  await page.click('.su-foot .a1-btn.primary');
  await typeInto(page, '#su-name', 'lease');
  await page.waitForFunction(() => document.getElementById('su-name-st').textContent.includes('works.'));
  await page.click('[data-part="next"]');
  await page.waitForSelector('#su-vault');
}

async function toOutput(page, fx) {
  await toVault(page);
  await typeInto(page, '#su-vault', fx.vault);
  await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
  await page.click('[data-part="next"]');
  await page.waitForFunction(() => document.getElementById('su-out') && document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
}

const names = (page) => page.$$eval('.pk-opt .pk-name', (n) => n.map((x) => x.firstChild.textContent));
const pathShown = (page) => page.textContent('.pk-path');
const focusIsBrowse = (page) => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('pk-browse'));
const locInput = '.pk input[id$="-loc"]';

async function openPicker(page, value) {
  if (value !== undefined) await typeInto(page, '.su-row .a1-in', value);
  await page.click('.pk-browse');
  await page.waitForSelector('.pk .pk-opt');
}

async function gotoFolder(page, folder) {
  await typeInto(page, locInput, folder);
  await page.keyboard.press('Enter');
  await page.waitForFunction((p) => document.querySelector('.pk-path') && document.querySelector('.pk-path').textContent === p, folder);
}

for (const browserName of ['chromium', 'firefox']) {
  test(`the folder picker in ${browserName}`, { skip: SKIP, timeout: 420000 }, async (t) => {
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
      const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 900 : 1000 } });
      const page = await ctx.newPage();
      page.folderRequests = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/folders')) page.folderRequests.push(decodeURIComponent(r.url().slice(base.length)));
      });
      await page.goto(`${base}/auth?token=${srv.token}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-role="setup-root"] h1');
      return page;
    };

    await t.test('the vault question: Browse opens at the deepest existing folder, lists folders only, marks links, hides hidden ones, and has no New folder', async () => {
      const page = await open(1280);
      await toVault(page);
      await openPicker(page, path.join(fx.work, 'not', 'there'));
      assert.equal(await pathShown(page), fx.work);
      assert.deepEqual(await names(page), ['Alpha', 'beta', 'lnk']);
      const text = await page.textContent('.pk');
      assert.equal(text.includes('SENTINEL'), false);
      assert.match(await page.textContent('.pk-opt:has-text("lnk")'), /link/);
      assert.equal(await page.locator('.pk .pk-foot button:has-text("New folder")').count(), 0);
      await page.check('.pk input[type="checkbox"]');
      await page.waitForFunction(() => document.querySelectorAll('.pk-opt').length === 4);
      assert.match(await page.textContent('.pk-opt:has-text(".git")'), /hidden/);
      assert.match(await page.textContent('.pk-live'), /work, 4 folders/);
      await page.context().close();
    });

    await t.test('keyboard: Enter opens, Backspace and Alt+Up go to the parent, a link explains itself, Esc closes and returns focus to Browse', async () => {
      const page = await open(1280);
      await toVault(page);
      await typeInto(page, '.su-row .a1-in', path.join(fx.work, 'x'));
      await page.focus('.pk-browse');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.pk .pk-opt');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'listbox', 'focus lands in the list');
      const active = () => page.evaluate(() => document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).textContent);
      assert.match(await active(), /^Alpha/);
      await page.keyboard.press('ArrowDown');
      assert.match(await active(), /^beta/);
      await page.keyboard.press('End');
      assert.match(await active(), /^lnk/);
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, path.join(fx.work, 'Alpha'));
      assert.deepEqual(await names(page), ['inner']);
      await page.keyboard.press('Backspace');
      await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, fx.work);
      await page.keyboard.press('Enter');
      await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, path.join(fx.work, 'Alpha'));
      await page.keyboard.press('Alt+ArrowUp');
      await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, fx.work);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pk p[role="status"]') && document.querySelector('.pk p[role="status"]').textContent.includes('Links can’t be opened here. Type the path into the field instead.'));
      assert.equal(await pathShown(page), fx.work, 'a link is never entered');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.pk').count(), 0);
      assert.equal(await focusIsBrowse(page), true, 'M15: after Esc focus is on Browse');
      assert.equal(await page.getAttribute('.pk-browse', 'aria-expanded'), 'false');
      await page.context().close();
    });

    await t.test('M16 Choose fills the field with the open folder, closes, returns focus to Browse and runs the field’s own server check', async () => {
      const page = await open(1280);
      await toVault(page);
      await typeInto(page, '.su-row .a1-in', fx.work);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('isn’t a vault'));
      await openPicker(page);
      await gotoFolder(page, fx.vault);
      await page.click('.pk >> text=Choose this folder');
      assert.equal(await page.inputValue('#su-vault'), fx.vault);
      assert.equal(await page.locator('.pk').count(), 0);
      assert.equal(await focusIsBrowse(page), true);
      await page.waitForFunction(() => document.getElementById('su-vault-st').textContent.includes('A gm-apprentice vault'));
      await page.context().close();
    });

    await t.test('M14 a network path typed in the location box is never asked per keystroke, only on Enter', async () => {
      const page = await open(1280);
      await toVault(page);
      await openPicker(page, fx.work);
      page.folderRequests.length = 0;
      await typeInto(page, locInput, '\\\\host\\share\\x');
      // Positive control: ordinary text IS a debounced server-side filter, so by the time its request
      // has been seen, any request the UNC text would have caused came before it.
      await typeInto(page, locInput, 'Al');
      await page.waitForFunction(() => document.querySelectorAll('.pk-opt').length === 1);
      assert.ok(page.folderRequests.some((r) => r.includes('filter=Al')), 'the filter request happened');
      assert.equal(page.folderRequests.some((r) => r.includes('host')), false, 'no request named the share while typing');
      await typeInto(page, locInput, '\\\\host\\share\\x');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.pk p[role="status"]:not([hidden])');
      assert.equal(page.folderRequests.filter((r) => r.includes('path=') && r.includes('host')).length, 1, 'Enter asks exactly once');
      await page.context().close();
    });

    await t.test('the output question: New folder makes the folder at once, shows it just created and selected, refuses a bad name and an existing one, and Choose then finds it empty', async () => {
      const page = await open(1280);
      await toOutput(page, fx);
      await openPicker(page);
      await gotoFolder(page, fx.work);
      await page.click('.pk .pk-foot button:has-text("New folder")');
      await typeInto(page, '.pk-new input', '.drafts');
      await page.click('.pk-new >> text=Create folder');
      await page.waitForFunction(() => document.querySelector('.pk-new .pk-err'));
      assert.equal(await page.textContent('.pk-new .pk-err'), 'Folder name must not start with a dot.');
      assert.equal(fs.existsSync(path.join(fx.work, '.drafts')), false);
      await typeInto(page, '.pk-new input', 'Alpha');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pk-new .pk-err').textContent.includes('already exists'));
      assert.match(await page.textContent('.pk-new .pk-err'), /A folder called “Alpha” already exists here\. Nothing was changed\./);
      await typeInto(page, '.pk-new input', 'Session Art');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pk-opt[aria-selected="true"] .a1-pill.sage'));
      assert.equal(fs.statSync(path.join(fx.work, 'Session Art')).isDirectory(), true, 'it is on disk the moment it is made');
      assert.match(await page.textContent('.pk-opt[aria-selected="true"]'), /Session Art.*just created/);
      assert.match(await page.textContent('.pk p[role="status"]'), /Press Enter to open it, then Choose this folder/);
      await page.keyboard.press('Enter');
      await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, path.join(fx.work, 'Session Art'));
      await page.click('.pk >> text=Choose this folder');
      assert.equal(await page.inputValue('#su-out'), path.join(fx.work, 'Session Art'));
      assert.equal(await focusIsBrowse(page), true);
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Folder is free to use'));
      await page.context().close();
    });

    await t.test('the review says what the first build will create, and its lede is the new copy', async () => {
      const page = await open(1280);
      await toOutput(page, fx);
      await typeInto(page, '#su-out', path.join(fx.H, 'brand-new-site'));
      await page.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Created by the first build'));
      for (let i = 0; i < 3; i++) {
        await page.click('[data-part="next"]');
        await page.waitForTimeout(250);
      }
      await page.waitForSelector('.a1-slip');
      assert.match(await page.textContent('.su-do'), new RegExp(`Created by the first build: ${path.join(fx.H, 'brand-new-site').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(await page.textContent('.a1-lede'), /A folder you made with New folder is already on your disk\./);
      assert.match(await page.textContent('.a1-sidefoot'), /Files are written at the review\. New folder makes its folder at once\./);
      await page.context().close();
      const second = await open(1280);
      await toOutput(second, fx);
      await typeInto(second, '#su-out', path.join(fx.work, 'Session Art'));
      await second.waitForFunction(() => document.getElementById('su-out-st').textContent.includes('Folder is free to use'));
      for (let i = 0; i < 3; i++) {
        await second.click('[data-part="next"]');
        await second.waitForTimeout(250);
      }
      await second.waitForSelector('.a1-slip');
      assert.equal((await second.textContent('.su-do')).includes('Created by the first build'), false, 'an output that exists has no such line');
      await second.context().close();
    });

    await t.test('axe: the picker open, its list, its New folder form with an error, at 1280 and 390', { skip: SKIP_AXE }, async () => {
      for (const width of [1280, 390]) {
        const page = await open(width);
        await toOutput(page, fx);
        await openPicker(page);
        await gotoFolder(page, fx.work);
        assert.deepEqual(await axeViolations(page), [], `list at ${width}`);
        await page.click('.pk .pk-foot button:has-text("New folder")');
        await typeInto(page, '.pk-new input', '.bad');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.pk-new .pk-err'));
        assert.deepEqual(await axeViolations(page), [], `New folder error at ${width}`);
        await page.keyboard.press('Escape');
        await page.click('.pk >> text=Up');
        await page.waitForFunction((p) => document.querySelector('.pk-path').textContent === p, fx.H);
        assert.deepEqual(await axeViolations(page), [], `parent folder at ${width}`);
        await page.context().close();
      }
    });
  });
}
