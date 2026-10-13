'use strict';

/*
 * ADR 0054 section 2 (mock frame G5): the accounts list on Setup > Remote access, in real browsers
 * (Chromium and Firefox via PLAYWRIGHT_MODULE; skips, loudly, without it; axe also needs axe-core).
 *
 * The real panel runs in process in local mode (loopback only, free ports), with accounts.json and an
 * audit log written beforehand, and the browser signs in with the one-time link like a person on the
 * machine would. The list is read-only: names and dates, no control that changes anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const pwLib = require('../src/remote/password');
const { writeAccounts } = require('../src/remote/passwordwrite');
const { createAuditLog } = require('../src/remote/audit');

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

async function startPanel(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-ras-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta', 'scriptorium'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Alpha Test' })}\n`);
  fs.writeFileSync(path.join(vault, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n'));
  const panelDir = path.join(root, 'panel');

  const record = await pwLib.hashPassword('a passphrase for the screen', { now: () => Date.UTC(2026, 8, 12, 21, 40) });
  const later = await pwLib.hashPassword('another passphrase here', { now: () => Date.UTC(2026, 9, 3, 9, 12) });
  writeAccounts(path.join(panelDir, 'accounts.json'), [
    { name: 'gm', record, fromEarlierPassword: true },
    { name: 'rook', record: later, fromEarlierPassword: false },
    { name: 'saffron', record: later, fromEarlierPassword: false },
  ]);
  const audit = createAuditLog({ file: path.join(panelDir, 'audit.log'), now: () => Date.now() - 3600000 });
  audit.append({ event: 'signin', method: 'password', result: 'ok', via: 'remote', from: '198.51.100.20', browser: 'Firefox', campaign: 'alpha', account: 'gm' });

  const emitted = [];
  const signals = new EventEmitter();
  const done = runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: (l) => emitted.push(l), signals });
  let result = null;
  done.then((r) => {
    result = r;
  });
  const started = Date.now();
  while (!emitted.some((l) => /token=/.test(l))) {
    if (result) throw new Error(`panel exited early: ${JSON.stringify(result)}`);
    if (Date.now() - started > 15000) throw new Error('panel did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  const line = emitted.find((l) => /token=/.test(l));
  const url = /(http:\/\/127\.0\.0\.1:\d+\/auth\?token=\S+)/.exec(line)[1];
  t.after(async () => {
    signals.emit('SIGINT');
    await done;
  });
  return { url, record, later };
}

for (const browserName of ['chromium', 'firefox']) {
  const open = async (t, { width = 1280, height = 900 } = {}) => {
    const panel = await startPanel(t);
    const browser = await pw[browserName].launch();
    t.after(() => browser.close());
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    await page.goto(panel.url);
    await page.goto(`${new URL(panel.url).origin}/#/remote`);
    await page.waitForSelector('.ga-acc');
    return { page, panel, problems };
  };

  test(`${browserName}: Remote access lists each account with when its password was set and its last sign-in, read-only`, { skip: SKIP }, async (t) => {
    const { page, panel, problems } = await open(t);
    const rows = await page.locator('.ga-acc tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    assert.deepEqual(rows, [
      ['gm from your earlier password', '12 Sep 2026, 21:40 UTC', rows[0][2]],
      ['rook', '03 Oct 2026, 09:12 UTC', 'Never'],
      ['saffron', '03 Oct 2026, 09:12 UTC', 'Never'],
    ]);
    assert.match(rows[0][2], /^(Today|Yesterday), \d\d:\d\d UTC$/, 'gm signed in an hour ago');
    assert.equal(await page.locator('.ga-acc button, .ga-acc input, .ga-acc a').count(), 0, 'no control inside the accounts list');
    assert.equal(await page.locator('.ga-acc .a1-pill').textContent(), 'from your earlier password');
    assert.equal(await page.locator('.ga-hint code').textContent(), 'gm-scriptorium remote ...');
    assert.equal(await page.locator('.ga-acc h2').textContent(), 'Accounts');
    assert.equal(await page.locator('.ga-acc .rm-note').first().textContent(), 'These people can sign in to the console. Every account has the same rights. This list is read-only.');
    const text = await page.locator('body').innerText();
    for (const secret of [panel.record.hash, panel.record.salt, panel.later.hash, panel.later.salt]) assert.ok(!text.includes(secret));
    assert.ok(/Accounts\s+3 set/.test(text.replace(/\s+/g, ' ')), 'the health pill says 3 set');
    assert.deepEqual(problems, []);
  });

  test(`${browserName}: the accounts list passes axe at 1280 and 390 wide and in forced colours, and does not scroll the page sideways at 390`, { skip: SKIP_AXE }, async (t) => {
    for (const width of [1280, 390]) {
      const { page } = await open(t, { width, height: 1000 });
      assert.deepEqual(await axeViolations(page), [], `at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll at ${width}`);
      let forced = true;
      try {
        await page.emulateMedia({ forcedColors: 'active' });
      } catch (_) {
        forced = false;
      }
      if (forced) assert.deepEqual(await axeViolations(page), [], `forced colours at ${width}`);
    }
  });
}
