'use strict';

/*
 * Editing a vault whose settings live in _meta/vault-config.yaml, in a real browser (Playwright via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core beside it or
 * AXE_CORE_PATH). The vault is a copy of the sample that the pin's own move ran on with the pack
 * folded in, so the yaml holds the title, the tagline and every setting the panel edits.
 *
 * The vault-config.yaml screen: the fields show what the generator says each one does, a field save,
 * a restore of that save's backup and a text save each land in the yaml. Title & tagline: both
 * values go in one review and one request, and show again after the reload. A page loaded before
 * the settings went back to vault-config.md is refused with the server's message and writes
 * nothing. Chromium and Firefox, each on a fresh copy. Port from testPort(7946).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { testPort } = require('./helpers/ports');
const { moveVaultCopy, assertMovedLayout } = require('./helpers/moved-vault');

const REPO = path.join(__dirname, '..');
const SAMPLE = path.join(REPO, 'examples', 'the-long-lease');
const PORT = String(testPort(7946));

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

const TITLE_SAVED_NOTE = "Saved in the vault's settings file, _meta/vault-config.yaml.";
const BACK_SINCE_LOADED =
  "This vault's settings are in _meta/vault-config.md again since the page loaded. Nothing was saved. Reload to edit them there.";
const MOVED_TITLE_LEDE = 'The name and one-line tagline on your landing page. This vault keeps both in _meta/vault-config.yaml.';
const MOVED_VC_LEDE = "Your vault's own settings file, _meta/vault-config.yaml. gm-apprentice and GM-Scriptorium both read it.";
const FOLDERS_DOES = 'Vault folders never published';
const NEW_TITLE = 'The Short Lease';
const NEW_TAGLINE = 'A smaller valley, a smaller dragon, the same rent.';

const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

async function axeViolations(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] }, rules: { region: { enabled: true } } });
    const out = [];
    r.violations.forEach((v) => v.nodes.forEach((n) => out.push(v.id + ':' + n.target.join(' '))));
    return out;
  });
}

/** Every line of `b` but the ones in `skip` (indexes) equals the same line of `a`. */
function linesEqualExcept(a, b, skip) {
  const la = a.split('\n');
  const lb = b.split('\n');
  assert.equal(la.length, lb.length, 'the same number of lines');
  la.forEach((line, i) => {
    if (!skip.includes(i)) assert.equal(lb[i], line, `line ${i + 1} is unchanged`);
  });
}

for (const browserName of ['chromium', 'firefox']) {
  test(`editing a moved vault's settings in the panel (${browserName})`, { skip: SKIP, timeout: 300000 }, async (t) => {
    const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moved-edit-dom-')));
    let child;
    let browser;
    try {
      const vault = moveVaultCopy(SAMPLE, H, { inVaultPack: true }).vaultPath;
      assertMovedLayout(vault);
      const yaml = path.join(vault, '_meta', 'vault-config.yaml');
      const md = path.join(vault, '_meta', 'vault-config.md');
      const original = fs.readFileSync(yaml, 'utf8');
      assert.ok(original.includes('    folders: ["_meta", "_Templates"]\n'), 'the folded yaml hides the two default folders');
      assert.ok(original.includes('    max_npcs: 8\n'));
      assert.ok(original.includes('  title: The Long Lease\n'), 'the fold put the title in the yaml');

      const cfgDir = path.join(H, 'cfg');
      fs.mkdirSync(cfgDir);
      const cfg = path.join(cfgDir, 'config.toml');
      fs.writeFileSync(cfg, `config_version = 1\ndefault_campaign = "lease"\n\n[campaigns.lease]\nvault = '${vault}'\noutput = '${H}/out'\n`);
      const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: cfg };
      const srv = await startAdminServer(['serve', '--admin', '--port', PORT, '--config', cfg, 'lease'], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env });
      child = srv.child;
      browser = await pw[browserName].launch();

      const openPage = async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
        const page = await ctx.newPage();
        const posts = [];
        page.on('request', (req) => {
          if (req.method() === 'POST' && req.url().includes('/api/')) posts.push({ path: new URL(req.url()).pathname, body: JSON.parse(req.postData() || '{}') });
        });
        await page.goto(`http://127.0.0.1:${PORT}/auth?token=${srv.token}`, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        return { page, posts };
      };
      const gotoScreen = async (page, id) => {
        await page.click(`[data-role="side"] a[data-nav="${id}"]`);
        await page.waitForTimeout(500);
      };
      const pickView = async (page, view) => {
        await page.click(`[data-switcher="vault-config"] [data-view-opt="${view}"]`);
        await page.waitForTimeout(300);
      };
      const saveInSlip = async (page) => {
        await page.waitForSelector('#admin-slip[open] button:has-text("Back up and save")');
        const tick = await page.$('#admin-slip .vc-saveack input');
        if (tick) await tick.check();
        await page.click('#admin-slip button:has-text("Back up and save")');
        await page.waitForSelector('#admin-slip :text("vault-config.yaml is updated")');
      };
      const closeDone = async (page) => {
        await page.click('#admin-slip button:has-text("Back to vault-config.yaml")');
        await page.waitForTimeout(600);
      };

      const vcScreen = '[data-screen="vault-config"]';
      let afterFields;
      let afterRestore;

      await t.test('vault-config.yaml screen: the fields say what they do, and a field save lands in the yaml', async () => {
        const { page, posts } = await openPage();
        await gotoScreen(page, 'vault-config');
        assert.equal((await texts(page, `${vcScreen} .a1-lede`))[0], MOVED_VC_LEDE);
        await pickView(page, 'vc3');
        await page.waitForSelector(`${vcScreen} .vc3-grid`);

        const row = `${vcScreen} .vc3-f[data-path="publish.exclude_dirs"]`;
        assert.equal((await texts(page, `${row} .vc3-lab small`))[0], 'player_site.hide.folders');
        assert.equal((await texts(page, `${row} [data-part="does"]`)).join('|'), FOLDERS_DOES);
        assert.deepEqual(await texts(page, `${row} [data-part="left-out"] code`), ['_meta', '_Templates']);
        assert.equal(await page.$$eval(`${row} [data-part="left-out"] code`, (els) => els[0].childNodes.length === 1 && els[0].firstChild.nodeType === 3), true, 'the code span holds one text node');
        const fine = (await texts(page, `${vcScreen} .vc3-grid ~ .a1-fine`))[0];
        assert.ok(!fine.includes('below the frontmatter'), 'the yaml has no notes below a frontmatter');
        assert.ok(!/\bversion\b/.test(fine), 'the format version is not listed as a setting');
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'axe, the fields of vault-config.yaml');

        await page.click(`${vcScreen} .vc-sw`);
        assert.match((await texts(page, 'dialog.vc3-drawer h2'))[0], /^Editing vault-config\.yaml /);
        await page.check('#vc3-ack');
        await page.click('dialog.vc3-drawer button:has-text("Unlock")');
        await page.waitForSelector(`${vcScreen} .vc3-tier.priv.is-live`);
        assert.equal((await texts(page, `${vcScreen} .vc-editing b`))[0], 'Editing vault-config.yaml');
        await page.click(`${row} .vc3-add`);
        await page.fill(`${row} .vc3-addrow input`, 'Secret');
        await page.keyboard.press('Enter');
        await page.click(`${vcScreen} .a1-pending .a1-btn.primary`);
        await page.waitForSelector('#admin-slip[open] button:has-text("Back up and save")');
        assert.deepEqual(await texts(page, '#admin-slip .cf-file code'), ['_meta/vault-config.yaml']);
        assert.equal((await texts(page, '#admin-slip .cf-title'))[0], 'Save vault-config.yaml');
        const review = posts.filter((p) => p.path === '/api/vault-config/fields');
        assert.equal(review.length, 1);
        assert.deepEqual(review[0].body, { baseSha256: review[0].body.baseSha256, dryRun: true, file: 'vault-config.yaml', set: { 'player_site.hide.folders': ['_meta', '_Templates', 'Secret'] } });
        await saveInSlip(page);

        afterFields = fs.readFileSync(yaml, 'utf8');
        const lines = original.split('\n');
        const at = lines.indexOf('    folders: ["_meta", "_Templates"]');
        assert.ok(afterFields.split('\n')[at].includes('Secret'), 'the hidden folders line gains Secret');
        linesEqualExcept(original, afterFields, [at]);
        assert.equal(posts.filter((p) => p.path.startsWith('/api/vault-config/') && p.body.file !== 'vault-config.yaml').length, 0, 'every settings request names the yaml');
        await closeDone(page);
        await page.context().close();
      });

      await t.test('vault-config.yaml screen: restore the one backup through the review', async () => {
        const { page, posts } = await openPage();
        await gotoScreen(page, 'vault-config');
        await pickView(page, 'vc1');
        await page.waitForSelector(`${vcScreen} .vc-backups-block .vc-bkrow`);
        assert.equal((await page.$$(`${vcScreen} .vc-backups-block .vc-bkrow`)).length, 1);
        await page.click(`${vcScreen} .vc-bkrow button:has-text("Restore")`);
        await page.waitForSelector('#admin-slip[open] button:has-text("Back up and save")');
        assert.equal((await texts(page, '#admin-slip .cf-title'))[0], 'Restore vault-config.yaml');
        assert.deepEqual(await texts(page, '#admin-slip .cf-file code'), ['_meta/vault-config.yaml']);
        assert.ok(!(await page.textContent('#admin-slip')).includes('frontmatter'), 'no frontmatter wording on the yaml');
        // A restore's save shows no Saved screen (on either layout): wait for the file instead.
        const tick = await page.$('#admin-slip .vc-saveack input');
        if (tick) await tick.check();
        await page.click('#admin-slip button:has-text("Back up and save")');
        for (let i = 0; i < 100 && fs.readFileSync(yaml, 'utf8') === afterFields; i++) await page.waitForTimeout(100);
        afterRestore = fs.readFileSync(yaml, 'utf8');
        assert.equal(afterRestore, original, 'the restore put the file back as it was before the field save');
        assert.notEqual(afterFields, afterRestore);
        const restores = posts.filter((p) => p.path === '/api/vault-config/restore');
        assert.equal(restores.length, 2, 'one dry run, one save');
        assert.ok(restores.every((p) => p.body.file === 'vault-config.yaml'));
        await page.context().close();
      });

      await t.test('vault-config.yaml screen: edit as text and save', async () => {
        const { page } = await openPage();
        await gotoScreen(page, 'vault-config');
        await pickView(page, 'vc1');
        await page.click(`${vcScreen} .vc-sw`);
        await page.check('#vc1-ack');
        await page.click('dialog.vc-dialog button:has-text("Edit the file")');
        await page.waitForSelector('#vc-text');
        const text = await page.inputValue('#vc-text');
        assert.ok(text.startsWith('version: 1\n'), 'the editor holds the whole yaml, with no fences');
        await page.fill('#vc-text', text.replace('    max_npcs: 8\n', '    max_npcs: 9\n'));
        await page.waitForSelector(`${vcScreen} .a1-pending .a1-btn.primary:not([disabled])`);
        assert.equal((await texts(page, `${vcScreen} .vc-status span`))[0], 'The file reads cleanly.');
        await page.click(`${vcScreen} .a1-pending .a1-btn.primary`);
        await saveInSlip(page);
        assert.equal(fs.readFileSync(yaml, 'utf8'), afterRestore.replace('    max_npcs: 8\n', '    max_npcs: 9\n'));
        await closeDone(page);
        await page.context().close();
      });

      await t.test('Title & tagline: both go in one review and one request, and show after the reload', async () => {
        const { page, posts } = await openPage();
        await gotoScreen(page, 'title');
        const screen = '[data-screen="title"]';
        assert.equal((await texts(page, `${screen} .a1-lede`))[0], MOVED_TITLE_LEDE);
        assert.deepEqual(await page.$eval('#pack-title-input', (e) => ({ value: e.value, readOnly: e.readOnly })), { value: 'The Long Lease', readOnly: false });
        assert.equal(await page.$eval('#pack-tagline-input', (e) => e.disabled), false);
        assert.equal((await texts(page, `${screen} [data-part="title-note"]`)).join('|'), TITLE_SAVED_NOTE);
        await page.fill('#pack-title-input', NEW_TITLE);
        await page.fill('#pack-tagline-input', NEW_TAGLINE);
        if (!SKIP_AXE) assert.deepEqual(await axeViolations(page), [], 'axe, Title & tagline with edits');
        const before = fs.readFileSync(yaml, 'utf8');
        await page.click(`${screen} .a1-pending .a1-btn.primary`);
        await page.waitForSelector('#admin-slip[open]');
        const dry = posts.filter((p) => ['/api/vault-config/title', '/api/vault-config/tagline', '/api/pack/settings'].includes(p.path));
        assert.equal(dry.length, 1, 'one request for both values');
        assert.equal(dry[0].path, '/api/vault-config/title');
        assert.deepEqual(Object.keys(dry[0].body).sort(), ['baseSha256', 'dryRun', 'file', 'tagline', 'title']);
        assert.equal(dry[0].body.file, 'vault-config.yaml');
        assert.deepEqual(await texts(page, '#admin-slip .cf-file code'), ['_meta/vault-config.yaml']);
        const slipText = await page.textContent('#admin-slip');
        assert.ok(slipText.includes(NEW_TITLE) && slipText.includes(NEW_TAGLINE), 'the slip shows both changes');
        assert.equal(fs.readFileSync(yaml, 'utf8'), before, 'the review writes nothing');
        await page.click('#admin-slip button:has-text("Back up and save vault-config.yaml")');
        await page.waitForSelector('#admin-slip :text("vault-config.yaml is updated")');
        const saved = fs.readFileSync(yaml, 'utf8');
        assert.ok(saved.includes(`  title: ${NEW_TITLE}\n`));
        assert.ok(saved.includes(NEW_TAGLINE));
        await page.keyboard.press('Escape');
        await page.waitForFunction((v) => document.querySelector('#pack-title-input').value === v, NEW_TITLE);
        await page.waitForTimeout(800);
        assert.equal(await page.inputValue('#pack-title-input'), NEW_TITLE);
        assert.equal(await page.inputValue('#pack-tagline-input'), NEW_TAGLINE);
        assert.equal((await texts(page, `${screen} [data-part="title-note"]`)).join('|'), TITLE_SAVED_NOTE);
        await page.context().close();
      });

      await t.test('a page loaded before the settings went back to vault-config.md is refused and writes nothing', async () => {
        const { page } = await openPage();
        await gotoScreen(page, 'title');
        const screen = '[data-screen="title"]';
        fs.renameSync(yaml, md);
        const mdBefore = fs.readFileSync(md);
        await page.fill('#pack-title-input', 'Another Lease');
        await page.click(`${screen} .a1-pending .a1-btn.primary`);
        await page.waitForSelector(`${screen} .pack-outcome[role="alert"]`);
        const alert = (await texts(page, `${screen} .pack-outcome[role="alert"]`)).join('|');
        assert.ok(alert.startsWith(BACK_SINCE_LOADED), alert);
        assert.deepEqual(fs.readFileSync(md), mdBefore, 'vault-config.md is unchanged');
        assert.equal(fs.existsSync(yaml), false, 'no vault-config.yaml was written');
        await page.context().close();
      });

      // Makes a missing axe-core show as a skip, since the axe checks above are guarded inline.
      await t.test('axe-core is loaded, so the axe checks above ran', { skip: SKIP_AXE }, () => {
        assert.ok(axeSource);
      });
    } finally {
      if (browser) await browser.close();
      if (child) await stopChild(child);
      fs.rmSync(H, { recursive: true, force: true });
    }
  });
}
