'use strict';

/*
 * The Story nav menu, proven against the REAL installed generator's output (ADR 0014 addendum).
 *
 * Up to publish-v1.12.3 the pin rendered the grouped Story toggle as <a class="nav-group-toggle"
 * href="story.html">, a link that navigated on the click that was meant to open the menu, and
 * src/build/storynav.js patched it. publish-v1.12.4 (#296/#304) renders it as a <button> that only
 * opens the menu, with "Story so far" as the menu's first entry. The retired transform's tests ran on
 * literal fixtures and stayed green after the match stopped firing, so nothing here uses a literal
 * nav fixture: the vault below is built through Scriptorium's own pipeline.
 *
 * Two tests. The first needs no browser (a change detector on the built markup). The second drives
 * Chromium at desktop width and skips, loudly, without Playwright (PLAYWRIGHT_MODULE). Own port 8681
 * (range 8680-8699, override STORYNAV_TEST_PORT).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const FIXTURES = path.join(__dirname, 'fixtures');
const PORT = Number(process.env.STORYNAV_TEST_PORT || 8681);

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

/**
 * A vault with both halves of a grouped Story menu: a session (the Sessions entry) and a PC with a
 * story companion (the pin's `hasStory`, which adds the "Story so far" entry).
 */
function buildStoryVaultSite() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-nav-pin-'));
  const vault = path.join(scratch, 'vault');
  fs.cpSync(path.join(FIXTURES, 'session-chain-vault'), vault, { recursive: true });
  fs.mkdirSync(path.join(vault, 'Characters', 'PCs'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'Characters', 'PCs', 'Rowan.md'),
    '---\ntype: pc\ntitle: Rowan\n---\n## Public Bio\nRowan grew up in the borderlands.\n'
  );
  fs.writeFileSync(
    path.join(vault, 'Characters', 'PCs', 'Rowan_Story.md'),
    '---\ntype: character-story\n---\nRowan walked into the hollow.\n'
  );
  const cfg = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'session-chain-vault-site-config.json'), 'utf8'));
  cfg.folderMap['Characters/PCs'] = 'characters/pcs';
  const siteDir = path.join(scratch, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const finalOut = path.join(scratch, 'out');
  const result = runAtomicBuild({
    vaultPath: vault,
    userJsonConfig: { ...cfg, vaultPath: vault },
    finalOut,
    siteDir,
    campaign: 'story-nav-pin',
    force: true,
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
  return { scratch, finalOut };
}

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

test('the built grouped Story toggle is a button whose menu starts with "Story so far" (pin change detector, no transform)', () => {
  const { scratch, finalOut } = buildStoryVaultSite();
  try {
    const BUTTON_FIRST = /<button class="nav-group-toggle">Story<\/button>\s*<div class="nav-dropdown">\s*<a href="([^"]*story\.html)">Story so far<\/a>/;
    let checked = 0;
    for (const file of walkHtml(finalOut)) {
      const html = fs.readFileSync(file, 'utf8');
      const rel = path.relative(finalOut, file);
      const navMatch = html.match(/<nav class="nav-groups">[\s\S]*?<\/nav>/);
      if (!navMatch) continue;
      const nav = navMatch[0];
      checked++;
      const m = nav.match(BUTTON_FIRST);
      assert.ok(m, `${rel}: the grouped Story toggle is no longer <button class="nav-group-toggle">Story</button> followed by a first entry "Story so far"`);
      // The link resolves to the Story landing from this page's depth.
      const depth = rel.split(path.sep).length - 1;
      assert.equal(m[1], '../'.repeat(depth) + 'story.html', `${rel}: "Story so far" does not point at the Story landing`);
      assert.doesNotMatch(nav, /<a class="nav-group-toggle" href="[^"]*">Story<\/a>/, `${rel}: the pin emits the old link-shaped Story toggle again`);
      assert.ok(!html.includes('data-scriptorium-storynav'), `${rel}: a retired Scriptorium Story transform marker is back`);
      assert.equal((html.match(/data-scriptorium-storyfocus/g) || []).length, 1, `${rel}: the focus shim is not linked exactly once`);
    }
    assert.ok(checked > 5, `positive control: only ${checked} pages carried a nav`);
    assert.ok(fs.existsSync(path.join(finalOut, 'story.html')), 'positive control: the build wrote no story.html');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('real browser: the Story label opens the menu on click and keeps it open, Escape closes it and keeps focus on the toggle, and the overview entry reads "Story so far"', { skip: pw ? false : 'playwright not available (set PLAYWRIGHT_MODULE)', timeout: 120000 }, async () => {
  const { scratch, finalOut } = buildStoryVaultSite();
  const server = http.createServer((req, res) => {
    let p = path.join(finalOut, decodeURIComponent(req.url.split('?')[0]));
    if (p.endsWith(path.sep)) p += 'index.html';
    if (!p.startsWith(finalOut)) {
      res.statusCode = 403;
      return res.end();
    }
    fs.readFile(p, (err, data) => {
      if (err) {
        res.statusCode = 404;
        return res.end();
      }
      const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      res.setHeader('content-type', type);
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await pw.chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });

    const state = () =>
      page.evaluate(() => {
        const g = [...document.querySelectorAll('.nav-group')].find((el) => el.querySelector('.nav-group-toggle') && el.querySelector('.nav-group-toggle').textContent.trim() === 'Story');
        return {
          open: g.classList.contains('open'),
          path: location.pathname,
          focusIsToggle: document.activeElement === g.querySelector('.nav-group-toggle'),
        };
      });

    // A click on the label opens the menu and does not navigate, and it is still open after a pause
    // (the pre-1.12.4 anchor loaded the landing, so the menu "opened and closed straight away").
    await page.click('.nav-group-toggle:text-is("Story")');
    await page.waitForTimeout(500);
    let s = await state();
    assert.equal(s.open, true, 'the Story menu is closed after a click on its label');
    assert.equal(s.path, '/index.html', 'a click on the Story label navigated away');

    // The overview entry is the menu's first entry, is visible while the menu is open and reaches the landing.
    const first = page.locator('.nav-group:has(> .nav-group-toggle:text-is("Story")) .nav-dropdown a').first();
    assert.equal((await first.textContent()).trim(), 'Story so far');
    assert.equal(await first.isVisible(), true, '"Story so far" is not visible while the menu is open');
    assert.equal(await first.getAttribute('href'), 'story.html');
    assert.equal(await page.locator('.nav-story-overview').count(), 0, 'the retired "Story overview" entry is still emitted');

    // Escape closes it, and focus (on the toggle after the click) stays on the toggle.
    await page.keyboard.press('Escape');
    s = await state();
    assert.equal(s.open, false, 'Escape did not close the Story menu');
    assert.equal(s.focusIsToggle, true, 'focus left the Story toggle on Escape');

    // The keyboard route: Enter opens it, and the overview entry navigates to the landing.
    await page.keyboard.press('Enter');
    s = await state();
    assert.equal(s.open, true, 'Enter on the focused Story toggle did not open the menu');
    await Promise.all([page.waitForURL('**/story.html'), first.click()]);
    assert.equal(new URL(page.url()).pathname, '/story.html');

    // Escape pressed with focus INSIDE the open dropdown closes it and returns focus to the toggle (the
    // pin's js/nav.js only closes it; the downstream shim src/build/storyfocus.js does the focus).
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.focus('.nav-group-toggle:text-is("Story")');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Story so far', 'Tab did not reach the first menu entry');
    await page.keyboard.press('Escape');
    s = await state();
    assert.equal(s.open, false, 'Escape inside the dropdown did not close it');
    assert.equal(s.focusIsToggle, true, 'Escape inside the dropdown did not return focus to the Story toggle');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

const { transformStoryFocus, STORYFOCUS_MARKER } = require('../src/build/storyfocus');

test('storyfocus shim: patches only pages with the grouped Story button, once, and skips the standalone link', () => {
  const grouped = '<nav class="nav-groups"><div class="nav-group"><button class="nav-group-toggle">Story</button>\n<div class="nav-dropdown"><a href="story.html">Story so far</a></div></div></nav></body>';
  const once = transformStoryFocus(grouped);
  assert.ok(once && once.includes(STORYFOCUS_MARKER));
  assert.equal(transformStoryFocus(once), null, 'not idempotent');
  assert.equal(transformStoryFocus('<div class="nav-group"><a class="nav-group-toggle" href="story.html">Story</a></div></body>'), null);
  assert.equal(transformStoryFocus('<button class="nav-group-toggle">Characters</button><div class="nav-dropdown"></div></body>'), null);
});
