'use strict';

/*
 * ADR 0054 sections 3, 5 and 7: the sign-in page in real browsers (Chromium and Firefox via
 * PLAYWRIGHT_MODULE; skips, loudly, without it; the axe checks also need axe-core, found beside
 * PLAYWRIGHT_MODULE or via AXE_CORE_PATH).
 *
 * The page and its scripts are the real embedded assets, served by a stub on a free port with the
 * real admin headers (so the real CSP is enforced and an inline script or a form post would be
 * blocked). The stub only answers POST /auth/password with a canned answer: what the SERVER does with
 * a sign-in is proved over real sockets in test/remote-signin-accounts.test.js. What is proved here is
 * the PAGE: labels, autocomplete, what is cleared and kept, where it navigates, and accessibility.
 *
 * NOT proved here, and recorded OPEN instead: that Chrome, Edge and Firefox actually OFFER to save the
 * login and fill it later (the Windows runbook, and the owner acceptance table in ADR 0054).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { ADMIN_ASSET_ROUTES, readAdminAsset } = require('../src/admin/assets');
const respond = require('../src/admin/respond');

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

const GENERIC = "That didn't work. Check your username and password.";

/** A stub of the panel's sign-in side: the real page, assets and headers; a canned answer to the POST. */
async function startStub(t, { answer = 'fail', holdPanelMs = 0 } = {}) {
  const state = { posts: [], gets: [], signedIn: false, answer };
  const server = http.createServer((req, res) => {
    const url = req.url;
    if (req.method === 'POST' && url === '/auth/password') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const ok = state.answer === 'ok';
        if (ok) state.signedIn = true;
        respond.send(res, ok ? 200 : 403, respond.adminHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), ok ? '{"ok":true}' : JSON.stringify({ error: 'signin', message: GENERIC }));
      });
      return;
    }
    if (req.method === 'GET' && url.startsWith('/assets/')) {
      const name = url.slice('/assets/'.length);
      if (!Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, name)) {
        res.statusCode = 404;
        res.end('no');
        return;
      }
      respond.send(res, 200, respond.adminHeaders({ 'Content-Type': ADMIN_ASSET_ROUTES[name] }), readAdminAsset(name));
      return;
    }
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      state.gets.push(url);
      if (state.signedIn) {
        setTimeout(() => respond.send(res, 200, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), '<!doctype html><title>the panel</title><p>the panel</p>'), holdPanelMs);
        return;
      }
      respond.send(res, 403, respond.adminHeaders({ 'Content-Type': 'text/html; charset=utf-8' }), readAdminAsset('signin.html'));
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return state;
}

for (const browserName of ['chromium', 'firefox']) {
  const run = async (t, fn, { width = 1280, height = 900, ...stubOpts } = {}) => {
    const browser = await pw[browserName].launch();
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    const stub = await startStub(t, stubOpts);
    try {
      await fn({ page, stub, problems });
    } finally {
      await browser.close();
    }
  };

  test(`${browserName}: the fields are labelled, named, typed and tagged for password managers`, { skip: SKIP }, async (t) => {
    await run(t, async ({ page, stub, problems }) => {
      await page.goto(`${stub.base}/`);
      const user = page.getByLabel('Username');
      const pass = page.getByLabel('Password');
      assert.equal(await user.count(), 1);
      assert.equal(await pass.count(), 1);
      assert.deepEqual(
        await user.evaluate((e) => [e.type, e.name, e.getAttribute('autocomplete'), e.getAttribute('autocapitalize'), e.spellcheck, e.required]),
        ['text', 'username', 'username', 'none', false, true],
      );
      assert.deepEqual(await pass.evaluate((e) => [e.type, e.name, e.getAttribute('autocomplete'), e.required]), ['password', 'password', 'current-password', true]);
      assert.equal(await page.locator('form').getAttribute('action'), '/auth/password');
      assert.equal(await page.locator('h1').textContent(), 'Sign in to the GM console');
      assert.equal(await page.getByRole('button', { name: 'Sign in' }).count(), 1);
      const text = await page.locator('body').innerText();
      assert.ok(text.includes('Five wrong tries for one username in ten minutes pause that username for fifteen minutes.'));
      assert.deepEqual(problems.filter((p) => !/403/.test(p)), [], 'no script error and no CSP violation (the 403 is the real refusal status of this page)');
    });
  });

  test(`${browserName}: a failed sign-in shows the one message, keeps the username, clears only the password, marks both fields and stays put`, { skip: SKIP }, async (t) => {
    await run(t, async ({ page, stub, problems }) => {
      await page.goto(`${stub.base}/`);
      await page.getByLabel('Username').fill('Rook');
      await page.getByLabel('Password').fill('a wrong passphrase');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForFunction(() => document.querySelector('[data-role="signin-message"]').textContent !== '');
      assert.deepEqual(stub.posts, [{ username: 'Rook', password: 'a wrong passphrase' }], 'the username is sent as typed; the server makes it canonical');
      assert.equal(await page.locator('[data-role="signin-message"]').textContent(), GENERIC);
      assert.equal(await page.getByLabel('Username').inputValue(), 'Rook');
      assert.equal(await page.getByLabel('Password').inputValue(), '');
      assert.equal(await page.getByLabel('Password').evaluate((e) => document.activeElement === e), true, 'focus goes to the password field');
      for (const label of ['Username', 'Password']) {
        assert.equal(await page.getByLabel(label).getAttribute('aria-invalid'), 'true');
        assert.equal(await page.getByLabel(label).getAttribute('aria-describedby'), 'signin-status');
      }
      assert.equal(await page.locator('[data-role="signin-icon"]').isVisible(), true, 'the failure icon is shown');
      assert.equal(await page.getByRole('button', { name: 'Sign in' }).isDisabled(), false);
      assert.equal(stub.gets.length, 1, 'it did not navigate');
      assert.deepEqual(problems.filter((p) => !/403/.test(p)), [], 'no script error and no CSP violation (the 403 is the deliberate refusal)');
      // a second try clears the message first
      await page.getByLabel('Password').fill('another try here');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForFunction(() => document.querySelector('[data-role="signin-message"]').textContent !== '');
      assert.equal(stub.posts.length, 2);
    });
  });

  test(`${browserName}: an empty field shows the same message without sending anything`, { skip: SKIP }, async (t) => {
    await run(t, async ({ page, stub }) => {
      await page.goto(`${stub.base}/`);
      await page.getByLabel('Password').fill('something here');
      // the username is empty: the browser's own required check would stop a native submit, so submit the form directly
      await page.evaluate(() => document.querySelector('[data-role="signin-form"]').dispatchEvent(new Event('submit', { cancelable: true })));
      assert.equal(await page.locator('[data-role="signin-message"]').textContent(), GENERIC);
      assert.deepEqual(stub.posts, []);
    });
  });

  test(`${browserName}: on success NEITHER field is cleared before the page leaves (so a password manager can capture them), and it goes to the panel root`, { skip: SKIP }, async (t) => {
    await run(
      t,
      async ({ page, stub }) => {
        await page.goto(`${stub.base}/`);
        // what each field holds at the moment the page is torn down, carried to the next page in window.name
        await page.evaluate(() => {
          window.addEventListener('pagehide', () => {
            window.name = JSON.stringify([document.getElementById('signin-username').value, document.getElementById('signin-password').value]);
          });
        });
        await page.getByLabel('Username').fill('rook');
        await page.getByLabel('Password').fill('the right passphrase');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.waitForSelector('text=the panel');
        assert.deepEqual(JSON.parse(await page.evaluate(() => window.name)), ['rook', 'the right passphrase']);
        assert.deepEqual(stub.gets, ['/', '/'], 'it asked for the panel root');
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/');
      },
      { answer: 'ok' },
    );
  });

  test(`${browserName}: the campaign hint is forwarded after sign-in only when it has the shape of a campaign name`, { skip: SKIP }, async (t) => {
    const cases = [
      ['/?campaign=alpha', '/?campaign=alpha'],
      ['/?campaign=my-campaign-2', '/?campaign=my-campaign-2'],
      ['/?campaign=Alpha', '/'],
      ['/?campaign=a&x=1', '/'],
      ['/?campaign=../a', '/'],
      ['/?campaign=', '/'],
      ['/?campaign=a%20b', '/'],
      ['/?campaign=-a', '/'],
      [`/?campaign=${'a'.repeat(64)}`, '/'],
      ['/?campaign=%3Cscript%3E', '/'],
      ['/', '/'],
    ];
    for (const [entry, expected] of cases) {
      await run(
        t,
        async ({ page, stub }) => {
          await page.goto(`${stub.base}${entry}`);
          await page.getByLabel('Username').fill('rook');
          await page.getByLabel('Password').fill('the right passphrase');
          await page.getByRole('button', { name: 'Sign in' }).click();
          await page.waitForSelector('text=the panel');
          assert.equal(stub.gets[stub.gets.length - 1], expected, `entered by ${entry}`);
        },
        { answer: 'ok' },
      );
    }
  });

  test(`${browserName}: axe finds nothing at 1280 and 390 wide, fresh and after a failed try, and in forced colours`, { skip: SKIP_AXE }, async (t) => {
    for (const width of [1280, 390]) {
      await run(
        t,
        async ({ page, stub }) => {
          await page.goto(`${stub.base}/`);
          assert.deepEqual(await axeViolations(page), [], `fresh at ${width}`);
          await page.getByLabel('Username').fill('rook');
          await page.getByLabel('Password').fill('a wrong passphrase');
          await page.getByRole('button', { name: 'Sign in' }).click();
          await page.waitForFunction(() => document.querySelector('[data-role="signin-message"]').textContent !== '');
          assert.deepEqual(await axeViolations(page), [], `after a failed try at ${width}`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll at ${width}`);
          let forced = true;
          try {
            await page.emulateMedia({ forcedColors: 'active' });
          } catch (_) {
            forced = false;
          }
          if (forced) {
            assert.deepEqual(await axeViolations(page), [], `forced colours at ${width}`);
            for (const label of ['Username', 'Password']) assert.equal(await page.getByLabel(label).isVisible(), true);
            assert.equal(await page.getByRole('button', { name: 'Sign in' }).isVisible(), true);
          }
        },
        { width },
      );
    }
  });
}
