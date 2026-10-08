'use strict';

/*
 * "Start a new campaign" in browser setup, in real browsers (Chromium and Firefox via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core, found beside
 * PLAYWRIGHT_MODULE or via AXE_CORE_PATH). The real bin runs in setup mode with an isolated config
 * and the starter built into this build. Ports: 9486 and 9487 for the panels that only look, 9488
 * and 9489 for the ones that commit (override the first with NEWVAULT_UI_TEST_PORT; the others are
 * that plus 1, 2 and 3). Expected texts are written out by hand. The screens are compared with the
 * approved mock by the screenshot gate, which is not part of npm test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { SAMPLE } = require('./helpers/setup-fixtures');

const REPO = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.NEWVAULT_UI_TEST_PORT || 9486);

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
  const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'newvault-ui-')));
  const C = path.join(H, 'Campaigns');
  fs.mkdirSync(C);
  const dir = (rel, files) => {
    const d = path.join(C, rel);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files || []) fs.writeFileSync(path.join(d, f), 'x');
    return d;
  };
  const fx = { H, C, configPath: path.join(H, 'cfg', 'config.toml') };
  fx.empty = dir('Empty Folder');
  fx.litter = dir('Litter Folder');
  fs.writeFileSync(path.join(fx.litter, 'desktop.ini'), 'x');
  fs.mkdirSync(path.join(fx.litter, '.obsidian'));
  fx.repo = dir('Repo Folder');
  fs.mkdirSync(path.join(fx.repo, '.git'));
  fx.notEmpty = dir('Old notes', ['a.md', 'b.md', 'c.md']);
  fx.file = path.join(C, 'notes.txt');
  fs.writeFileSync(fx.file, 'x');
  fs.mkdirSync(path.join(H, 'target'));
  fx.link = path.join(C, 'Shared');
  fs.symlinkSync(path.join(H, 'target'), fx.link, 'dir');
  fx.host = path.join(C, 'Long Lease');
  fs.cpSync(SAMPLE, fx.host, { recursive: true });
  fs.mkdirSync(path.join(H, 'OneDrive', 'Campaigns'), { recursive: true });
  fx.env = { ...process.env, OneDrive: path.join(H, 'OneDrive'), XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
  return fx;
}

async function typeInto(page, selector, text) {
  await page.focus(selector);
  await page.fill(selector, '');
  await page.keyboard.type(text);
}
const statusText = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);
async function waitStatus(page, id, needle) {
  await page.waitForFunction(([i, n]) => document.getElementById(i) && document.getElementById(i).textContent.includes(n), [id, needle]);
}
async function tabTo(page, selector, limit = 80) {
  for (let i = 0; i < limit; i++) {
    const hit = await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector);
    if (hit) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${selector}`);
}
async function h1Focused(page, text) {
  await page.waitForFunction((want) => document.activeElement && document.activeElement.tagName === 'H1' && document.activeElement.textContent === want, text);
}
const nextEnabled = (page) => page.evaluate(() => !document.querySelector('[data-part="next"]').disabled);

/** From the start screen of the new-campaign path to the new vault question, name typed. */
async function toNewFolder(page) {
  await page.click('label.su-path:has(input[value="new"])');
  await page.click('.su-foot .a1-btn.primary');
  await typeInto(page, '#su-name', 'ember-road');
  await waitStatus(page, 'su-name-st', 'works.');
  await page.click('[data-part="next"]');
  await page.waitForSelector('#su-newvault');
}

for (const browserName of ['chromium', 'firefox']) {
  const offset = browserName === 'firefox' ? 1 : 0;
  test(`start a new campaign, browsing in ${browserName}`, { skip: SKIP, timeout: 420000 }, async (t) => {
    const fx = makeFixture();
    const srv = await startAdminServer(['serve', '--admin', '--port', String(BASE_PORT + offset), '--config', fx.configPath], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const browser = await pw[browserName].launch();
    t.after(async () => {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    });
    const open = async (width) => {
      const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 1000 } });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${BASE_PORT + offset}/auth?token=${srv.token}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-role="setup-root"] h1');
      return page;
    };

    await t.test('the start screen offers two ways in, with the owner\u2019s wording, and the pick changes the questions', async () => {
      const page = await open(1280);
      assert.equal(await page.isChecked('input[name="su-way"][value="have"]'), true, 'today\u2019s path is the default');
      assert.match(await page.textContent('.su-intro .a1-lede'), /^Five questions\./);
      assert.deepEqual(await page.$$eval('.su-rail button span:nth-child(2), .su-rail li button > span:nth-of-type(2)', (els) => els.map((e) => e.textContent)).then((x) => [...new Set(x)]), ['Campaign name', 'Vault folder', 'Output folder', 'Site title', 'Theme', 'Review']);
      await page.click('label.su-path:has(input[value="new"])');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'new', 'the pick keeps the keyboard where it was');
      assert.match(await page.textContent('.su-intro .a1-lede'), /^Six questions\./);
      assert.deepEqual(await page.$$eval('.su-rail li button > span:nth-of-type(2)', (els) => els.map((e) => e.textContent)), ['Campaign name', 'New vault folder', 'Site title', 'Game system', 'Output folder', 'Theme', 'Review']);
      const cards = await page.$$eval('.su-need > div', (els) => els.map((e) => [e.querySelector('b').textContent, e.querySelector('p').textContent]));
      assert.deepEqual(cards[0], ['An empty folder', 'Or a new one. Setup makes the vault there and touches nothing else.']);
      assert.deepEqual(cards[1], [
        'Where the player site goes.',
        'A separate folder from your vault, so the site never mixes with your notes. We\u2019ll suggest one in the same parent folder as your vault. For example, if your vault is D:\\Campaigns\\Long Lease, we\u2019ll suggest D:\\Campaigns\\long-lease-site. You can pick anywhere else.',
      ]);
      assert.deepEqual(cards[2], ['About two minutes', 'Then a first preview that only you can see.']);
      assert.equal(await page.textContent('.su-top-eyebrow, .su-mt .l').catch(() => 'Getting started'), 'Getting started');
      await page.click('label.su-path:has(input[value="have"])');
      assert.match(await page.textContent('.su-intro .a1-lede'), /^Five questions\./);
      assert.equal((await page.$$eval('.su-need > div b', (els) => els[0].textContent)), 'Your vault folder');
      await page.context().close();
    });

    await t.test('the two-way pick works from the keyboard alone', async () => {
      const page = await open(1280);
      await tabTo(page, 'input[name="su-way"]');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'have');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'new');
      assert.equal(await page.isChecked('input[name="su-way"][value="new"]'), true);
      assert.match(await page.textContent('.su-intro .a1-lede'), /^Six questions\./);
      await page.context().close();
    });

    await t.test('the vault question\u2019s two dead ends offer the way across, and the folder goes with you', async () => {
      const page = await open(1280);
      await page.click('.su-foot .a1-btn.primary');
      await typeInto(page, '#su-name', 'ember-road');
      await waitStatus(page, 'su-name-st', 'works.');
      await page.click('[data-part="next"]');
      await typeInto(page, '#su-vault', fx.notEmpty);
      await waitStatus(page, 'su-vault-st', 'isn\u2019t a vault');
      assert.ok(await page.$('#su-vault-st button:has-text("Start a new campaign here instead")'));
      const missing = path.join(fx.C, 'Ember Road');
      await typeInto(page, '#su-vault', missing);
      await waitStatus(page, 'su-vault-st', 'Can\u2019t find that folder');
      assert.ok(await page.$('#su-vault-st button:has-text("Check again")'));
      await page.click('#su-vault-st button:has-text("Start a new campaign here instead")');
      await page.waitForSelector('#su-newvault');
      assert.equal(await page.inputValue('#su-newvault'), missing);
      await waitStatus(page, 'su-newvault-st', 'A new folder will be created');
      assert.equal(await nextEnabled(page), true);
      assert.deepEqual(await page.$$eval('.su-rail li button > span:nth-of-type(2)', (els) => els.map((e) => e.textContent)), ['Campaign name', 'New vault folder', 'Site title', 'Game system', 'Output folder', 'Theme', 'Review']);
      assert.equal(await page.textContent('.a1-eyebrow'), 'Question 2 of 6');
      await page.context().close();
    });

    await t.test('every state of the new vault folder question, with the server\u2019s own rule word for word', async () => {
      const page = await open(1280);
      await toNewFolder(page);
      const st = () => statusText(page, 'su-newvault-st');
      const check = async (value, needle) => {
        await typeInto(page, '#su-newvault', value);
        await waitStatus(page, 'su-newvault-st', needle);
        return st();
      };

      let text = await check(path.join(fx.C, 'Ember Road'), 'A new folder will be created');
      assert.match(text, /Not inside a vaultNo _meta\/vault-config\.md in any folder above it/);
      assert.match(text, /Nothing is created yetSetup makes the folder on the last screen/);
      assert.equal(await nextEnabled(page), true);
      assert.equal(await page.getAttribute('#su-newvault', 'class'), 'a1-in mono ok');

      text = await check(fx.empty, 'Folder is empty');
      assert.match(text, /The new vault goes straight into it/);

      text = await check(fx.litter, 'never reads or changes');
      assert.match(text, /Apart from \.obsidian\/, desktop\.ini, which setup never reads or changes/);
      assert.equal(await nextEnabled(page), true);

      text = await check(fx.repo, 'never reads or changes');
      assert.match(text, /Folder is emptyApart from \.git\/, which setup never reads or changes/);
      assert.equal(await nextEnabled(page), true, 'a folder that is already a git repository is allowed');

      text = await check(fx.notEmpty, 'isn\u2019t empty');
      assert.match(text, /Not emptyHas 3 items already/);
      assert.match(text, new RegExp(`refusing to create a vault in ${fx.notEmpty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: it is not empty \\(it holds a\\.md, b\\.md, c\\.md\\)`));
      assert.equal(await nextEnabled(page), false);
      assert.equal(await page.getAttribute('#su-newvault', 'class'), 'a1-in mono bad');

      text = await check(fx.file, 'file, not a folder');
      assert.match(text, new RegExp(`refusing to create a vault in ${fx.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: it is a file`));
      assert.equal(await nextEnabled(page), false);

      text = await check(fx.link, 'is a link');
      assert.match(text, /A link to another folderShortcuts, symlinks and junctions can\u2019t be used/);
      assert.match(text, /it is a link or junction/);
      assert.equal(await nextEnabled(page), false);

      const inside = path.join(fx.host, 'Ember Road');
      text = await check(inside, 'inside a vault');
      assert.match(text, /Inside an existing vault/);
      assert.match(text, new RegExp(`it is inside the vault at ${fx.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(await nextEnabled(page), false);

      const deep = path.join(fx.H, 'Games', 'Campaigns', 'Ember Road');
      text = await check(deep, 'Folders above it will be created first');
      assert.ok(text.includes(path.join(fx.H, 'Games')) && text.includes(path.join(fx.H, 'Games', 'Campaigns')), 'the folders above it are listed');
      assert.equal(await nextEnabled(page), true, 'missing parent folders are allowed; they are made on the last screen');
      assert.equal(fs.existsSync(path.join(fx.H, 'Games')), false, 'checking creates nothing');

      text = await check(path.join(fx.H, 'OneDrive', 'Campaigns', 'Ember Road'), 'syncs with OneDrive');
      assert.match(text, /In OneDriveOneDrive will sync the new vault/);
      assert.match(text, /If it adds a desktop\.ini, setup leaves it alone\./);
      assert.equal(await nextEnabled(page), true);

      await typeInto(page, '#su-newvault', '//fileserver/campaigns/Ember Road');
      await waitStatus(page, 'su-newvault-st', 'looks like a network path');
      assert.equal(await nextEnabled(page), true);
      await page.keyboard.press('Tab');
      await waitStatus(page, 'su-newvault-st', 'On a network share');
      text = await st();
      assert.match(text, /This folder is on a network share\. Setup never runs git for you\./);
      assert.deepEqual(await page.$$eval('#su-newvault-st .su-cmd code', (els) => els.map((e) => e.textContent)), ['git init', 'git add -A', 'git commit -m "New campaign vault"']);

      await check('relative/path', 'Use the full folder path');
      assert.equal(await nextEnabled(page), false);
      await page.context().close();
    });

    await t.test('the new vault question has a Browse button that fills the field and runs the same check', async () => {
      const page = await open(1280);
      await toNewFolder(page);
      assert.ok(await page.$('.su-row button:has-text("Browse")'));
      assert.equal(await page.getAttribute('.su-row button:has-text("Browse")', 'aria-expanded'), 'false');
      await typeInto(page, '#su-newvault', fx.empty);
      await waitStatus(page, 'su-newvault-st', 'Folder is empty');
      await page.click('.su-row button:has-text("Browse")');
      await page.waitForSelector('.pk .pk-opt, .pk .pk-path');
      assert.equal(await page.textContent('.pk-title'), 'Choose the new vault folder');
      assert.equal(await page.locator('.pk button:has-text("New folder")').count(), 0, 'a vault is made on the last screen, so this field never makes a folder');
      await typeInto(page, '.pk input[id$="-loc"]', fx.C);
      await page.keyboard.press('Enter');
      await page.waitForFunction((p) => document.querySelector('.pk-path') && document.querySelector('.pk-path').textContent === p, fx.C);
      await page.click('.pk >> text=Choose this folder');
      assert.equal(await page.inputValue('#su-newvault'), fx.C);
      await waitStatus(page, 'su-newvault-st', 'isn\u2019t empty');
      await page.context().close();
    });

    await t.test('the game system question: four radios with their ids, a request link, and the keyboard', async () => {
      const page = await open(1280);
      await toNewFolder(page);
      await typeInto(page, '#su-newvault', path.join(fx.C, 'Ember Road'));
      await waitStatus(page, 'su-newvault-st', 'A new folder will be created');
      await page.click('[data-part="next"]');
      await page.waitForSelector('#su-title');
      await page.waitForFunction(() => document.getElementById('su-title').value !== '');
      assert.equal(await page.inputValue('#su-title'), 'ember-road', 'the title starts as the campaign name');
      assert.equal(await page.textContent('.a1-hint'), 'Also used as the campaign name inside the new vault.');
      await typeInto(page, '#su-title', 'Say "hi"');
      await waitStatus(page, 'su-title-st', 'That title can\u2019t be used.');
      assert.match(await statusText(page, 'su-title-st'), /site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes/);
      assert.equal(await nextEnabled(page), false);
      await typeInto(page, '#su-title', 'The Ember Road');
      await waitStatus(page, 'su-title-st', 'Players will see');
      await page.click('[data-part="next"]');
      await h1Focused(page, 'Which game system?');
      const rows = await page.$$eval('.su-opt', (els) => els.map((e) => [e.querySelector('.nm').textContent, e.querySelector('.id').textContent, e.querySelector('input').checked]));
      assert.deepEqual(rows, [['None', 'none', true], ['D&D 5e (2024)', 'dnd-5e-2024', false], ['Pathfinder 2e', 'pf2e', false], ['Forged in the Dark', 'fitd', false]]);
      assert.equal(await page.textContent('.su-opt .d'), 'No system templates. Fits any game.');
      assert.equal(await page.textContent('.su-sys + .a1-hint'), 'More systems are on the way. Ask for yours');
      const link = await page.$eval('.su-sys + .a1-hint a', (a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.textContent]);
      assert.deepEqual(link, ['https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/new?template=game_system_request.yml', '_blank', 'noopener noreferrer', 'Ask for yours']);
      await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
      await tabTo(page, 'input[name="su-sys"]');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'none');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.value), 'dnd-5e-2024');
      assert.equal(await page.$eval('.su-opt.sel .id', (e) => e.textContent), 'dnd-5e-2024');
      assert.equal(await page.textContent('.su-rail button[aria-current="step"] span:nth-of-type(2)'), 'Game system');
      await page.context().close();
    });

    await t.test('the suggested output folder follows the vault folder when you go back and change it, and a folder you typed yourself does not', async () => {
      const page = await open(1280);
      await toNewFolder(page);
      const goOutput = async () => {
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-title');
        await page.waitForFunction(() => !!document.getElementById('su-title') && document.getElementById('su-title').value !== '');
        await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
        await page.click('[data-part="next"]');
        await page.waitForSelector('input[name="su-sys"]');
        await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-out');
        await page.waitForFunction(() => document.getElementById('su-out').value !== '');
      };
      const backToVault = async () => {
        for (let i = 0; i < 3; i++) await page.click('.su-foot .a1-btn:not(.primary)');
        await page.waitForSelector('#su-newvault');
      };
      const setVault = async (dir) => {
        await typeInto(page, '#su-newvault', dir);
        await waitStatus(page, 'su-newvault-st', 'A new folder will be created');
      };
      const first = path.join(fx.C, 'Ember Road');
      const second = path.join(fx.H, 'OneDrive', 'Campaigns', 'Second Road');
      await setVault(first);
      await goOutput();
      assert.equal(await page.inputValue('#su-out'), path.join(fx.C, 'ember-road-site'));
      await backToVault();
      await setVault(second);
      await goOutput();
      assert.equal(await page.inputValue('#su-out'), path.join(fx.H, 'OneDrive', 'Campaigns', 'ember-road-site'), 'an untouched suggestion follows the vault');
      const mine = path.join(fx.H, 'my-own-site');
      await typeInto(page, '#su-out', mine);
      await waitStatus(page, 'su-out-st', 'Outside the vault');
      await backToVault();
      await setVault(first);
      await goOutput();
      assert.equal(await page.inputValue('#su-out'), mine, 'a folder you typed is never replaced');
      await page.context().close();
    });

    await t.test('every new screen and state has no axe violations at 1280 and 390', { skip: SKIP_AXE }, async () => {
      for (const width of [1280, 390]) {
        const page = await open(width);
        const clean = async (what) => assert.deepEqual(await axeViolations(page), [], `${what} at ${width}`);
        await page.click('label.su-path:has(input[value="new"])');
        await clean('start, new campaign');
        await page.click('.su-foot .a1-btn.primary');
        await typeInto(page, '#su-name', 'ember-road');
        await waitStatus(page, 'su-name-st', 'works.');
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-newvault');
        const states = [
          [path.join(fx.C, 'Ember Road'), 'A new folder will be created', 'new folder'],
          [fx.litter, 'never reads or changes', 'litter'],
          [fx.notEmpty, 'isn\u2019t empty', 'not empty'],
          [fx.file, 'file, not a folder', 'a file'],
          [fx.link, 'is a link', 'a link'],
          [path.join(fx.host, 'Ember Road'), 'inside a vault', 'inside a vault'],
          [path.join(fx.H, 'Games', 'Campaigns', 'Ember Road'), 'Folders above it will be created first', 'folders above it'],
          [path.join(fx.H, 'OneDrive', 'Campaigns', 'Ember Road'), 'syncs with OneDrive', 'OneDrive'],
        ];
        for (const [value, needle, what] of states) {
          await typeInto(page, '#su-newvault', value);
          await waitStatus(page, 'su-newvault-st', needle);
          await clean(`new vault folder, ${what}`);
        }
        await typeInto(page, '#su-newvault', '//fileserver/campaigns/Ember Road');
        await waitStatus(page, 'su-newvault-st', 'looks like a network path');
        await clean('new vault folder, typing a share');
        await page.keyboard.press('Tab');
        await waitStatus(page, 'su-newvault-st', 'On a network share');
        await clean('new vault folder, share');
        await typeInto(page, '#su-newvault', path.join(fx.C, 'Ember Road'));
        await waitStatus(page, 'su-newvault-st', 'A new folder will be created');
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-title');
        await page.waitForFunction(() => document.getElementById('su-title').value !== '');
        await clean('site title, new campaign');
        await typeInto(page, '#su-title', 'Say "hi"');
        await waitStatus(page, 'su-title-st', 'That title can\u2019t be used.');
        await clean('site title, refused');
        await typeInto(page, '#su-title', 'The Ember Road');
        await waitStatus(page, 'su-title-st', 'Players will see');
        await page.click('[data-part="next"]');
        await page.waitForSelector('input[name="su-sys"]');
        await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
        await clean('game system');
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-out');
        await page.waitForFunction(() => document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
        await page.click('[data-part="next"]');
        await page.waitForSelector('#su-title, .su-themes');
        await page.waitForSelector('input[name="su-theme"]');
        await page.click('[data-part="next"]');
        await page.waitForSelector('.a1-slip');
        await clean('review, new vault');
        await page.click('details.su-tree summary');
        await clean('review, new vault, full list open');
        await page.context().close();
      }
    });
  });

  test(`start a new campaign, committing in ${browserName}`, { skip: SKIP, timeout: 420000 }, async (t) => {
    const fx = makeFixture();
    const port = BASE_PORT + 2 + offset;
    const srv = await startAdminServer(['serve', '--admin', '--port', String(port), '--config', fx.configPath], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env: fx.env });
    const browser = await pw[browserName].launch();
    t.after(async () => {
      await browser.close();
      await stopChild(srv.child);
      fs.rmSync(fx.H, { recursive: true, force: true });
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    await page.goto(`http://127.0.0.1:${port}/auth?token=${srv.token}`, { waitUntil: 'load' });
    await page.waitForSelector('[data-role="setup-root"] h1');
    const vault = path.join(fx.H, 'Games', 'Ember Road');

    await t.test('a folder that fills up between the check and the review is refused with the writer\u2019s own words, and nothing else is written', async () => {
      assert.equal(await h1Focused(page, 'Let\u2019s set up your first campaign').then(() => true), true);
      await tabTo(page, 'input[name="su-way"]');
      await page.keyboard.press('ArrowRight');
      await tabTo(page, '.su-foot .a1-btn.primary');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'What should we call this campaign?');
      await tabTo(page, '#su-name');
      await page.keyboard.type('ember-road');
      await waitStatus(page, 'su-name-st', 'works.');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Where should the new vault go?');
      await tabTo(page, '#su-newvault');
      await page.keyboard.type(vault);
      await waitStatus(page, 'su-newvault-st', 'Folders above it will be created first');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'What\u2019s the site called?');
      await page.waitForFunction(() => document.getElementById('su-title') && document.getElementById('su-title').value === 'ember-road');
      await typeInto(page, '#su-title', 'The Ember Road');
      await waitStatus(page, 'su-title-st', 'Players will see The Ember Road');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Which game system?');
      await page.waitForFunction(() => !document.querySelector('[data-part="next"]').disabled);
      await tabTo(page, 'input[name="su-sys"]');
      await page.keyboard.press('ArrowDown'); // dnd-5e-2024
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Where should the built site go?');
      await page.waitForFunction(() => document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.includes('Outside the vault'));
      assert.equal(await page.inputValue('#su-out'), path.join(fx.H, 'Games', 'ember-road-site'), 'the default sits next to the new vault, named after the campaign');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Pick a look for the player site');
      await tabTo(page, '[data-part="next"]');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Check your answers');
      const rows = await page.$$eval('.su-sum > div', (els) => els.map((e) => [e.querySelector('.k').textContent, e.querySelector('.v').textContent.replace(/\s+/g, ' ').trim()]));
      assert.deepEqual(rows, [
        ['Campaign name', 'ember-road'],
        ['New vault', `${vault} new folder`],
        ['Site title', 'The Ember Road'],
        ['Game system', 'D&D 5e (2024)'],
        ['Output folder', path.join(fx.H, 'Games', 'ember-road-site')],
        ['Theme', 'gloam'],
      ]);
      const steps = await page.$$eval('.su-do > li', (els) => els.map((e) => e.firstChild.textContent + (e.querySelector('code') ? e.querySelector('code').textContent : '')));
      assert.equal(steps[0].startsWith('Create the folders above it, one at a time: '), true);
      assert.ok((await page.textContent('.su-do')).includes(path.join(fx.H, 'Games')));
      assert.match(await page.textContent('.su-do'), /A welcome page, _Campaign[\\/]Welcome\.md\. It is the only page on the site at first\./);
      assert.match(await page.textContent('.su-do'), /NOTICE\.txt, crediting gm-apprentice \(CC BY-SA 4\.0\)\./);
      assert.equal(await page.textContent('.cf-note'), 'Setup never deletes anything. If it stops partway, it lists exactly what it made, and writes nothing else.');
      await page.click('details.su-tree summary');
      const listed = await page.$$eval('.su-tree li', (els) => els.map((e) => e.textContent));
      assert.ok(listed.includes(`_meta${path.sep}NOTICE.txt`) && listed.includes(`_Templates${path.sep}pc-dnd-5e-2024.md`) && listed.includes(`Factions & Organizations${path.sep}`), 'the full list comes from the starter');
      assert.equal(fs.existsSync(path.join(fx.H, 'Games')), false, 'nothing is written before the review is confirmed');
      assert.equal(fs.existsSync(fx.configPath), false);

      // someone puts a file in the new folder before the button is pressed
      fs.mkdirSync(vault, { recursive: true });
      fs.writeFileSync(path.join(vault, 'late.md'), 'x');
      await page.click('.cf-btns .a1-btn:not(.primary)');
      await page.waitForFunction(() => document.getElementById('su-commit-st').textContent.includes('Setup stopped before writing anything'));
      const msg = await statusText(page, 'su-commit-st');
      assert.ok(msg.includes('fix the new vault folder answer'), msg);
      assert.ok(msg.includes(`refusing to create a vault in ${vault}: it is not empty (it holds late.md)`), msg);
      assert.ok(await page.$('#su-commit-st button:has-text("Go to new vault folder")'));
      assert.equal(fs.existsSync(fx.configPath), false);
      assert.deepEqual(fs.readdirSync(vault), ['late.md']);
      fs.rmSync(path.join(vault, 'late.md'));
      fs.rmdirSync(vault);
      fs.rmdirSync(path.join(fx.H, 'Games'));
    });

    await t.test('then it creates the vault, builds a preview and lands on the ready screen with the git line and the next steps', async () => {
      await page.waitForSelector('.a1-slip');
      let release;
      const held = new Promise((resolve) => {
        page.route('**/api/preview', (route) => {
          release = () => route.continue();
          resolve();
        });
      });
      await tabTo(page, '.cf-btns .a1-btn.primary');
      await page.keyboard.press('Enter');
      await h1Focused(page, 'Building your first preview');
      await held;
      const prog = await page.textContent('.su-prog');
      assert.match(prog, /Created the new vault[\d.]+ sThe gm-apprentice starter, a welcome page and NOTICE\.txt, in /);
      assert.ok(prog.includes('(and the folders above it)'));
      assert.ok(prog.includes(vault));
      assert.match(prog, /Created 4 items[\d.]+ scss\/, images\/, pack\.toml, vault\.config\.json in /);
      assert.match(prog, /Registered ember-road[\d.]+ sYour default campaign/);
      assert.ok(await page.$('.su-prog .spin'));
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'build screen');
      release();
      await h1Focused(page, 'Your first preview is ready');

      assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
      assert.equal(fs.existsSync(path.join(vault, '_meta', 'NOTICE.txt')), true);
      assert.match(fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'), 'utf8'), /\n {2}site: true\n/);
      assert.equal(fs.existsSync(path.join(fx.H, 'Games', 'ember-road-site')), false, 'the output folder is never touched');
      assert.match(await page.textContent('.su-ready'), /Your new campaign has just a welcome page so far\. The preview shows the landing page with your title, and that one page\./);
      assert.equal(await page.textContent('.su-next h2'), 'Start writing in your vault');
      assert.equal(await page.$$eval('.su-next ol > li', (els) => els.length), 3);
      assert.ok((await page.textContent('.su-next ol > li')).includes(vault));
      assert.ok(await page.$('.su-next button:has-text("Copy folder path")'));
      const git = (await page.textContent('.a1-fine')).replace(/\s+/g, ' ').trim();
      assert.equal(git, 'Setup doesn\u2019t run git for you. Run git init in the new vault afterwards, or point setup at an empty folder you\u2019ve already made a git repo.');
      assert.equal(await page.textContent('.a1-fine code'), 'git init');
      assert.equal((await page.textContent('.su-ready')).includes('Commit your vault now'), false, 'the commit-first line belongs to an existing vault');
      if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'ready screen, new vault');
    });
  });
}
