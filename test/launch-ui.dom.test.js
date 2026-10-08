'use strict';

/*
 * Launch mode in real browsers (Chromium and Firefox via PLAYWRIGHT_MODULE; skips, loudly, without
 * it; the axe checks also need axe-core, found beside PLAYWRIGHT_MODULE or via AXE_CORE_PATH).
 *
 * The launcher file is written by the code under test (runLaunch, in process, with an injected
 * opener that only records the file it is handed: openFile: below never starts a program), and the
 * test browser opens it as a file: page, exactly as the operating system's default browser would.
 * The "stopped" page is also checked against a real `serve --admin` process that receives SIGTERM
 * (ports 9443 for Chromium and 9444 for Firefox; override the first with LAUNCH_UI_TEST_PORT).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { startAdminServer, stopChild } = require('./helpers/admin-server');
const { SAMPLE } = require('./helpers/setup-fixtures');

const { runLaunch } = require('../src/cli/launch');
const { startAdminPanel } = require('../src/cli/serve-admin');

const REPO = path.join(__dirname, '..');
const BASE_PORT = Number(process.env.LAUNCH_UI_TEST_PORT || 9443);

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

async function until(fn, what, ms = 8000) {
  const started = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Runs launch mode in process (setup mode, or with one campaign) and hands back the launcher file. */
async function startLaunch({ withCampaign = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ui-')));
  const configPath = path.join(root, 'cfg', 'config.toml');
  if (withCampaign) {
    const vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = '${vault}'`, `output = '${path.join(root, 'site')}'`, ''].join('\n'));
  }
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.resume();
  const signals = new EventEmitter();
  const opened = [];
  let panel = null;
  const run = runLaunch(
    { config: configPath },
    {
      input,
      output,
      signals,
      platform: 'linux',
      env: { PATH: '/nonexistent' },
      openFile: async (opts) => {
        opened.push(opts.target);
        return { outcome: 'exited', exitCode: 0, signal: null };
      },
      killAll: async () => {},
      startPanel: async (...a) => {
        panel = await startAdminPanel(...a);
        return panel;
      },
      version: '0.0.0-test',
      reportError: () => 1,
    },
  );
  await until(() => opened.length >= 1, 'the launcher to be opened');
  const launcher = opened[0];
  return {
    root,
    launcher,
    code: /name="code" value="([A-Za-z0-9_-]+)"/.exec(fs.readFileSync(launcher, 'utf8'))[1],
    port: panel.ctx.adminPort,
    input,
    signals,
    run,
    base: `http://127.0.0.1:${panel.ctx.adminPort}`,
    opened,
    // Idempotent: also the cleanup for a failed test, so no panel is left listening.
    stop: async () => {
      signals.emit('SIGINT');
      await run;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const browserName of ['chromium', 'firefox']) {
  test(`launch mode in ${browserName}`, { skip: SKIP, timeout: 300000 }, async (t) => {
    const browser = await pw[browserName].launch();
    t.after(() => browser.close());

    await t.test('the launcher file lands on the panel, signed in, and the code is never in any URL', async () => {
      const h = await startLaunch();
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const urls = [];
        page.on('request', (r) => urls.push(r.url()));
        page.on('response', (r) => urls.push(r.url()));
        page.on('framenavigated', (f) => urls.push(f.url()));
        await page.goto(`file://${h.launcher}`, { waitUntil: 'load' }).catch(() => {});
        await page.waitForURL(`${h.base}/`, { timeout: 20000 });
        await page.waitForSelector('[data-role="setup-root"] h1');
        assert.equal(page.url(), `${h.base}/`);
        urls.push(page.url());
        for (const u of urls) assert.ok(!u.includes(h.code), `a URL contained the launch code: ${u.replace(h.code, '<code>')}`);
        assert.ok(urls.some((u) => u.endsWith('/auth/launch')), 'the form posted to /auth/launch');
        assert.ok(!urls.some((u) => /[?&#]code=/.test(u) || u.includes('token=')), 'no code or token in any URL');
        const cookies = await context.cookies(h.base);
        const cookie = cookies.find((c) => c.name === `scriptorium_admin_${h.port}`);
        assert.ok(cookie, 'the session cookie was stored');
        assert.equal(cookie.sameSite, 'Strict');
        assert.equal(cookie.httpOnly, true);
        assert.equal(fs.existsSync(h.launcher), false, 'the launcher file was removed once the code was spent');
        // The same launcher a second time is dead: the file is gone, and the code was single use.
        const again = await context.newPage();
        const res = await again.request.post(`${h.base}/auth/launch`, { headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, data: `code=${h.code}` });
        assert.equal(res.status(), 403);
        await context.close();
      } finally {
        await h.stop();
      }
    });

    await t.test('the interstitial, the locked page and the stopped page have no axe violations', { skip: SKIP_AXE }, async () => {
      const h = await startLaunch();
      try {
        // Interstitial: hold launch.js back so the page stays put long enough to be checked.
        const context = await browser.newContext();
        await context.route('**/assets/launch.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
        const page = await context.newPage();
        await page.goto(`file://${h.launcher}`, { waitUntil: 'load' }).catch(() => {});
        await page.waitForSelector('main.stop .a1-busy');
        assert.equal(await page.textContent('main.stop .a1-busy'), 'Signing you in…');
        assert.equal(page.url(), `${h.base}/auth/launch`);
        assert.deepEqual(await axeViolations(page), [], 'interstitial');
        await context.close();

        // Locked page (a spent or expired link), at desktop and phone widths.
        for (const width of [1280, 390]) {
          const c2 = await browser.newContext({ viewport: { width, height: 800 } });
          const p2 = await c2.newPage();
          await p2.goto(`${h.base}/`);
          assert.match(await p2.textContent('main'), /Press O in the GM-Scriptorium window to open the panel again\./);
          assert.deepEqual(await axeViolations(p2), [], `locked page at ${width}`);
          await c2.close();
        }

        // The stopped page, launch copy: press O for a fresh launcher (the first code was spent above),
        // land on the panel, then stop the process.
        h.input.write('o');
        await until(() => h.opened.length >= 2, 'the second launcher');
        const c3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const p3 = await c3.newPage();
        await p3.goto(`file://${h.opened[1]}`, { waitUntil: 'load' }).catch(() => {});
        await p3.waitForSelector('[data-role="setup-root"] h1');
        h.signals.emit('SIGTERM');
        await p3.waitForSelector('main.stop .stop-title', { timeout: 10000 });
        assert.equal(await p3.title(), 'GM-Scriptorium · stopped');
        assert.equal(await p3.textContent('main.stop .stop-title'), 'GM-Scriptorium has stopped');
        assert.match(await p3.textContent('main.stop'), /You closed its window, so the panel and your preview are off\. Everything you saved is on disk\./);
        assert.deepEqual(await axeViolations(p3), [], 'stopped page');
        await p3.setViewportSize({ width: 390, height: 800 });
        assert.deepEqual(await axeViolations(p3), [], 'stopped page, phone width');
        await c3.close();
      } finally {
        await h.stop();
      }
    });

    await t.test('SIGTERM to a launch process: the open tab of a campaign panel shows the stopped page within 10 seconds', async () => {
      const h = await startLaunch({ withCampaign: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`file://${h.launcher}`, { waitUntil: 'load' }).catch(() => {});
        await page.waitForURL(`${h.base}/`, { timeout: 20000 });
        await page.waitForSelector('[data-role="main"]', { timeout: 20000 });
        const started = Date.now();
        h.signals.emit('SIGTERM');
        await page.waitForSelector('main.stop .stop-title', { timeout: 10000 });
        assert.ok(Date.now() - started < 10000);
        assert.equal(await page.title(), 'GM-Scriptorium · stopped');
        assert.match(await page.textContent('main.stop'), /You closed its window/);
        await context.close();
      } finally {
        await h.stop();
      }
    });

    await t.test('SIGTERM to a real serve --admin process: the neutral stopped page appears within 10 seconds, and the poll touches only the public asset', async () => {
      const port = BASE_PORT + (browserName === 'firefox' ? 1 : 0);
      const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ui-serve-')));
      const env = { ...process.env, XDG_CONFIG_HOME: path.join(H, 'xdg'), APPDATA: path.join(H, 'ad'), SCRIPTORIUM_CONFIG: path.join(H, 'unused.toml') };
      const srv = await startAdminServer(['serve', '--admin', '--port', String(port), '--config', path.join(H, 'cfg', 'config.toml')], { bin: path.join(REPO, 'bin', 'scriptorium.js'), env });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/auth?token=${srv.token}`, { waitUntil: 'load' });
        await page.waitForSelector('[data-role="setup-root"] h1');
        // Two polls go by while the server is up; every request in that window is the public asset.
        const seen = [];
        page.on('request', (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
        let polls = 0;
        await page.waitForRequest((r) => {
          if (r.method() === 'HEAD') polls++;
          return polls >= 2;
        }, { timeout: 15000 });
        assert.ok(seen.length >= 2);
        assert.deepEqual([...new Set(seen)], ['HEAD /assets/favicon.svg']);

        const started = Date.now();
        srv.child.kill('SIGTERM');
        await page.waitForSelector('main.stop .stop-title', { timeout: 10000 });
        assert.ok(Date.now() - started < 10000);
        assert.match(await page.textContent('main.stop'), /The panel and your preview are off\. Everything you saved is on disk\./);
        assert.match(await page.textContent('main.stop'), /Start it again to carry on\./);
        assert.ok(!(await page.textContent('main.stop')).includes('Start menu'), 'the neutral copy outside launch mode');
        assert.equal(await page.title(), 'GM-Scriptorium · stopped');
        await context.close();
      } finally {
        await stopChild(srv.child);
        fs.rmSync(H, { recursive: true, force: true });
      }
    });
  });
}
