'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const {
  PAGETURN_MARKER,
  PAGETURN_SCRIPT,
  transformPageTurn,
  applyPageTurn,
} = require('../src/build/pageturn');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pageturn-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- Page shape builders --------------------------------------------------------------------

function basePage({ landing } = {}) {
  const heroDiv = landing ? '<div class="landing-hero"><h1>Welcome</h1></div>' : '<p>Body.</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
<header class="top-nav">
  <a href="index.html" class="nav-brand">Site</a>
</header>
<main class="content">
${heroDiv}
</main>
</body>
</html>`;
}

function fourOhFourPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="css/style.css">
  <style>.four-oh-four-hero { text-align: center; }</style>
</head>
<body>
<header class="site-header">
  <h1><a href="index.html">Site</a></h1>
</header>
<main class="content">
  <div class="four-oh-four-hero"><p>Not found.</p></div>
</main>
</body>
</html>`;
}

// -- transformPageTurn: base script insertion ------------------------------------------------

test('base.js-shaped page: script appears exactly once, immediately before the first </head>, no async/defer/type=', () => {
  const html = basePage();
  const out = transformPageTurn(html);
  assert.notEqual(out, null);
  assert.equal((out.match(new RegExp(PAGETURN_MARKER, 'g')) || []).length, 1);

  const scriptAt = out.indexOf(`<script ${PAGETURN_MARKER}>`);
  const headCloseAt = out.indexOf('</head>');
  assert.ok(scriptAt !== -1 && headCloseAt !== -1);
  assert.ok(scriptAt < headCloseAt, 'the script must sit before </head>');
  // Nothing but whitespace/newline between the script's closing tag and </head>.
  const between = out.slice(out.indexOf('</script>', scriptAt) + '</script>'.length, headCloseAt);
  assert.match(between, /^\s*$/);

  assert.doesNotMatch(out, /<script[^>]*\basync\b/);
  assert.doesNotMatch(out, /<script[^>]*\bdefer\b/);
  assert.doesNotMatch(out, /<script[^>]*\btype=/);
});

test('404-shaped page (no .top-nav, own <style> block): still gets the script, no .vt-fx', () => {
  const html = fourOhFourPage();
  const out = transformPageTurn(html);
  assert.notEqual(out, null);
  assert.equal((out.match(new RegExp(PAGETURN_MARKER, 'g')) || []).length, 1);
  assert.doesNotMatch(out, /class="vt-fx"/);
  // Inserted immediately before </head>, so after the page-local <style> block in source order.
  const scriptAt = out.indexOf(PAGETURN_MARKER);
  const styleAt = out.indexOf('<style>');
  const headCloseAt = out.indexOf('</head>');
  assert.ok(styleAt < scriptAt && scriptAt < headCloseAt);
});

test('the <header class="top-nav"> is not mistaken for <head> when finding the insertion point', () => {
  const html = basePage();
  const out = transformPageTurn(html);
  // There must be exactly one <head ...> match consumed correctly: the script sits inside
  // <head>...</head>, never inside <header>.
  const headOpenAt = out.indexOf('<head>');
  const headerAt = out.indexOf('<header class="top-nav">');
  const scriptAt = out.indexOf(PAGETURN_MARKER);
  assert.ok(headOpenAt !== -1 && headerAt !== -1 && scriptAt !== -1);
  assert.ok(headOpenAt < scriptAt && scriptAt < headerAt);
});

test('idempotent: a second pass returns null', () => {
  const once = transformPageTurn(basePage());
  assert.notEqual(once, null);
  assert.equal(transformPageTurn(once), null);
});

test('a page with no </head> is left untouched', () => {
  const html = '<html><body><main class="content">hi</main></body></html>';
  assert.equal(transformPageTurn(html), null);
});

test('a </head>-shaped comment appearing later in the body does not move the insertion point', () => {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body>
<header class="top-nav"></header>
<main class="content"><!-- a stray </head> in a comment --></main>
</body></html>`;
  const out = transformPageTurn(html);
  assert.notEqual(out, null);
  const scriptAt = out.indexOf(PAGETURN_MARKER);
  const firstHeadCloseAt = out.indexOf('</head>');
  assert.ok(scriptAt < firstHeadCloseAt, 'must insert before the FIRST </head>, not a later look-alike');
});

// -- E-3: .vt-fx insertion ---------------------------------------------------------------------

test('.vt-fx is inserted exactly once, immediately before the first </main>, on a base.js page with .top-nav', () => {
  const out = transformPageTurn(basePage());
  assert.equal((out.match(/class="vt-fx"/g) || []).length, 1);
  const fxAt = out.indexOf('<div class="vt-fx" aria-hidden="true"></div>');
  const mainCloseAt = out.indexOf('</main>');
  assert.ok(fxAt !== -1 && fxAt < mainCloseAt);
});

test('.vt-fx is NOT inserted on a landing-shaped page (has .top-nav AND .landing-hero); it still gets the script', () => {
  const out = transformPageTurn(basePage({ landing: true }));
  assert.notEqual(out, null);
  assert.doesNotMatch(out, /class="vt-fx"/);
  assert.match(out, new RegExp(PAGETURN_MARKER));
});

test('.vt-fx is NOT inserted on a 404-shaped page (no .top-nav); it still gets the script', () => {
  const out = transformPageTurn(fourOhFourPage());
  assert.doesNotMatch(out, /class="vt-fx"/);
  assert.match(out, new RegExp(PAGETURN_MARKER));
});

// rc.2 Windows follow-ups, item 2 (the Windows verifier's retracted "events\index.html has no vt-fx"
// anomaly, docs/HANDOVER-WINDOWS.md C31): the pin's own lib/build.js (~line 887) writes
// events/index.html as a bare redirect stub straight to the timeline whenever a timeline exists,
// with no <header class="top-nav"> and no <main class="content">...</main> at all -- so it never
// matches AMENDMENT E-3's leaf-page test above and correctly gets no .vt-fx. Pinned here so a
// future change to either the pin's redirect shape or this transform's leaf test cannot silently
// reintroduce (or silently keep) the mismatch without a test noticing.
test('.vt-fx is NOT inserted on the pin\'s events/index.html redirect stub (no .top-nav, no <main>); it still gets the script', () => {
  const redirectStub =
    '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=../campaign/timeline.html">' +
    '<link rel="canonical" href="../campaign/timeline.html"></head>' +
    '<body><a href="../campaign/timeline.html">Timeline</a></body></html>';
  const out = transformPageTurn(redirectStub);
  assert.notEqual(out, null, 'the redirect stub still has a <head>...</head>, so it still gets the direction/scrolled script');
  assert.match(out, new RegExp(PAGETURN_MARKER));
  assert.doesNotMatch(out, /class="vt-fx"/);
});

test('a second pass inserts no second .vt-fx (guarded by the same script marker)', () => {
  const once = transformPageTurn(basePage());
  assert.equal((once.match(/class="vt-fx"/g) || []).length, 1);
  assert.equal(transformPageTurn(once), null);
});

test('with two </main> in a page, .vt-fx lands before the FIRST one after the FIRST <main class="content">', () => {
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body>
<header class="top-nav"></header>
<main class="content"><p>one</p></main>
<main class="content"><p>two</p></main>
</body></html>`;
  const out = transformPageTurn(html);
  const firstMainOpenAt = out.indexOf('<main class="content">');
  const firstMainCloseAt = out.indexOf('</main>', firstMainOpenAt);
  const fxAt = out.indexOf('<div class="vt-fx"');
  assert.ok(fxAt > firstMainOpenAt && fxAt < firstMainCloseAt);
  assert.equal((out.match(/class="vt-fx"/g) || []).length, 1);
});

// -- writeSessionsIndex output (real donor splice) ---------------------------------------------

test('a real writeSessionsIndex output gets both the script and .vt-fx', () => {
  withTmpDir((dir) => {
    const { writeSessionsIndex } = require('../src/build/sessions-index');
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'recap-01.html'), basePage());
    writeSessionsIndex(dir, { siteTitle: 'Test Site' });

    const indexHtml = fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8');
    const out = transformPageTurn(indexHtml);
    assert.notEqual(out, null);
    assert.equal((out.match(new RegExp(PAGETURN_MARKER, 'g')) || []).length, 1);
    assert.equal((out.match(/class="vt-fx"/g) || []).length, 1);
  });
});

// -- applyPageTurn / walk, fxInserted counting --------------------------------------------------

test('applyPageTurn patches every .html and counts fxInserted correctly', () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, 'index.html'), basePage({ landing: true }));
    fs.writeFileSync(path.join(dir, '404.html'), fourOhFourPage());
    fs.mkdirSync(path.join(dir, 'characters'));
    fs.writeFileSync(path.join(dir, 'characters', 'grix.html'), basePage());

    const result = applyPageTurn(dir);
    assert.equal(result.pagesPatched, 3);
    assert.equal(result.fxInserted, 1); // only characters/grix.html qualifies

    const second = applyPageTurn(dir);
    assert.equal(second.pagesPatched, 0);
  });
});

// -- Real runAtomicBuild -------------------------------------------------------------------------

test('runAtomicBuild (real pinned generator build): every .html gets exactly one marker; leaf pages get exactly one .vt-fx; index.html/404.html get none', () => {
  const { runAtomicBuild } = require('../src/build/run');
  const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
  const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pageturn-build-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...PIN_SITE_CONFIG, vaultPath: PIN_VAULT };
    const finalOut = path.join(scratch, 'out');

    const result = runAtomicBuild({
      vaultPath: PIN_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'pageturn-e2e',
      force: true, // this fixture vault deliberately carries withheld-name leaks
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
    assert.ok(result.pageTurn);

    const htmlFiles = [];
    (function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.html')) htmlFiles.push(full);
      }
    })(finalOut);
    assert.ok(htmlFiles.length > 0);
    assert.equal(result.pageTurn.pagesPatched, htmlFiles.length);

    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      assert.equal((html.match(new RegExp(PAGETURN_MARKER, 'g')) || []).length, 1, `${file} must carry exactly one marker`);
    }

    const indexHtml = fs.readFileSync(path.join(finalOut, 'index.html'), 'utf8');
    assert.doesNotMatch(indexHtml, /class="vt-fx"/);
    const four04Html = fs.readFileSync(path.join(finalOut, '404.html'), 'utf8');
    assert.doesNotMatch(four04Html, /class="vt-fx"/);

    const leafFiles = htmlFiles.filter((f) => f !== path.join(finalOut, 'index.html') && f !== path.join(finalOut, '404.html'));
    assert.ok(leafFiles.length > 0);
    for (const file of leafFiles) {
      const html = fs.readFileSync(file, 'utf8');
      assert.equal((html.match(/class="vt-fx"/g) || []).length, 1, `${file} must carry exactly one .vt-fx`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ================================================================================================
// vm behaviour: run the head script's literal source against a fake browser environment.
// ================================================================================================

function extractScriptBody(scriptTag) {
  return scriptTag.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
}

function makeMemoryStorage() {
  const store = new Map();
  return {
    setItem(k, v) { store.set(k, String(v)); },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    removeItem(k) { store.delete(k); },
    _store: store,
  };
}

function makeThrowingStorage() {
  return {
    setItem() { throw new Error('boom'); },
    getItem() { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); },
  };
}

// Builds a fresh sandbox and runs the script body inside it, registering its addEventListener
// calls into `listeners`. Every global the script references bare (addEventListener, document,
// sessionStorage, window, navigation, performance) is provided.
function makeSandbox(opts = {}) {
  const listeners = {};
  const mobileNav = { classList: { removed: false, remove() { this.removed = true; } } };
  const attrs = {};
  const querySelectorAllImpl = opts.querySelectorAll || (() => []);

  const sandbox = {
    addEventListener(type, fn) { listeners[type] = fn; },
    document: {
      documentElement: { attrs, setAttribute(k, v) { attrs[k] = v; } },
      getElementById(id) { return id === 'mobile-nav' ? mobileNav : null; },
      querySelectorAll(sel) { return querySelectorAllImpl(sel); },
    },
    sessionStorage: opts.sessionStorage || makeMemoryStorage(),
    window: { scrollY: opts.scrollY || 0, innerHeight: opts.innerHeight || 800, navigation: opts.navigation },
    navigation: opts.navigation,
    performance: opts.performance || { getEntriesByType: () => [] },
    location: opts.location || { href: 'https://x/a.html' },
  };

  vm.createContext(sandbox);
  vm.runInContext(extractScriptBody(PAGETURN_SCRIPT), sandbox);

  return { sandbox, listeners, mobileNav, attrs };
}

function fakeTypes() {
  const added = [];
  return { added, add(x) { added.push(x); } };
}

test('vm: a breadcrumb href match stores "up"', () => {
  const { listeners, sandbox } = makeSandbox({
    querySelectorAll: (sel) => (sel === '.breadcrumbs a' ? [{ href: 'https://x/page.html' }] : []),
  });
  listeners.pageswap({ viewTransition: {}, activation: { entry: { url: 'https://x/page.html' } } });
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-dir'), 'up');
});

test('vm: a first-child .story-nav match stores "back"', () => {
  const { listeners, sandbox } = makeSandbox({
    querySelectorAll: (sel) => (sel === '.story-nav a:first-child' ? [{ href: 'https://x/prev.html' }] : []),
  });
  listeners.pageswap({ viewTransition: {}, activation: { entry: { url: 'https://x/prev.html' } } });
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-dir'), 'back');
});

test('vm: precedence -- when both breadcrumb and story-nav match, "up" wins', () => {
  const { listeners, sandbox } = makeSandbox({
    querySelectorAll: () => [{ href: 'https://x/page.html' }],
  });
  listeners.pageswap({ viewTransition: {}, activation: { entry: { url: 'https://x/page.html' } } });
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-dir'), 'up');
});

test('vm: a history traverse to a lower index adds "back"', () => {
  const { listeners } = makeSandbox({
    navigation: { activation: { navigationType: 'traverse', from: { index: 5 }, entry: { index: 2 } } },
  });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('back'));
});

test('vm: no navigation object, with back_forward in performance, adds "back"', () => {
  const { listeners } = makeSandbox({
    navigation: undefined,
    performance: { getEntriesByType: () => [{ type: 'back_forward' }] },
  });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('back'));
});

test('vm: #mobile-nav loses "open" in pageswap', () => {
  const { listeners, mobileNav } = makeSandbox();
  listeners.pageswap({ viewTransition: {} });
  assert.equal(mobileNav.classList.removed, true);
});

test('vm: pagereveal sets data-sc-vt-arrived on the documentElement', () => {
  const { listeners, attrs } = makeSandbox();
  listeners.pagereveal({ viewTransition: {} });
  assert.equal(attrs['data-sc-vt-arrived'], '');
});

test('vm: an event without viewTransition does nothing (no throw, no side effects)', () => {
  const { listeners, mobileNav, attrs, sandbox } = makeSandbox();
  assert.doesNotThrow(() => listeners.pageswap({}));
  assert.doesNotThrow(() => listeners.pagereveal({}));
  assert.equal(mobileNav.classList.removed, false);
  assert.equal(attrs['data-sc-vt-arrived'], undefined);
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-dir'), null);
});

test('vm: a throwing sessionStorage, or missing types, throws nothing', () => {
  const { listeners } = makeSandbox({ sessionStorage: makeThrowingStorage() });
  assert.doesNotThrow(() => listeners.pageswap({ viewTransition: {}, activation: { entry: { url: 'https://x/a.html' } } }));
  assert.doesNotThrow(() => listeners.pagereveal({ viewTransition: {} })); // no .types
});

// -- E-6: the scrolled guard ---------------------------------------------------------------------

test('vm: scrollY 1500 with innerHeight 900 at reveal adds both "forward" and "scrolled"', () => {
  const { listeners } = makeSandbox({ scrollY: 1500, innerHeight: 900 });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('forward'));
  assert.ok(types.added.includes('scrolled'));
});

test('vm: scrollY 300 (below half of the default 800 viewport) does not add "scrolled"', () => {
  const { listeners } = makeSandbox({ scrollY: 300, innerHeight: 800 });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(!types.added.includes('scrolled'));
});

test('vm: a "1" flag written by the old page adds "scrolled" even at scrollY 0 on reveal', () => {
  const storage = makeMemoryStorage();
  storage.setItem('sc-vt-scrolled', '1');
  const { listeners } = makeSandbox({ sessionStorage: storage, scrollY: 0, innerHeight: 800 });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('scrolled'));
});

test('vm: the sc-vt-scrolled flag is removed after being read at reveal', () => {
  const storage = makeMemoryStorage();
  storage.setItem('sc-vt-scrolled', '1');
  const { listeners } = makeSandbox({ sessionStorage: storage, scrollY: 0, innerHeight: 800 });
  listeners.pagereveal({ viewTransition: { types: fakeTypes() } });
  assert.equal(storage.getItem('sc-vt-scrolled'), null);
});

test('vm: pageswap writes sc-vt-scrolled from the live scrollY (>half viewport -> "1")', () => {
  const { sandbox, listeners } = makeSandbox({ scrollY: 1000, innerHeight: 800 });
  listeners.pageswap({ viewTransition: {} }); // no activation -> returns early after the write
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-scrolled'), '1');
});

test('vm: pageswap writes sc-vt-scrolled "0" when scrollY is at or below half the viewport', () => {
  const { sandbox, listeners } = makeSandbox({ scrollY: 100, innerHeight: 800 });
  listeners.pageswap({ viewTransition: {} });
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-scrolled'), '0');
});

// -- B-1 (Reviewer rework): the scrolled guard on a history traverse, via a URL-keyed store ------
//
// Chromium 140 reads window.scrollY as 0 at pagereveal on a history traverse (scroll restoration
// has not been applied yet), so the live scrollY check alone misses a deep-scrolled page reached
// via Back. Real scenario: page A (scrolled 1500) -> forward navigation to page B -> Back to A.
// pageswap on A (leaving it, forward) must record A's own scrollY under a key naming A's URL;
// pagereveal on A (arriving via the Back traverse) must recognise the traverse and look its own
// URL up in that store.

test('vm: pageswap records the outgoing page\'s own scrollY under a key naming its own URL', () => {
  const { sandbox, listeners } = makeSandbox({
    scrollY: 1500,
    innerHeight: 900,
    location: { href: 'https://x/a.html' },
  });
  listeners.pageswap({ viewTransition: {} });
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-scroll:https://x/a.html'), '1500');
});

test('vm: a traverse back to a URL with a stored deep scrollY adds "scrolled", even though live scrollY reads 0 at reveal and the single-flag mechanism has since been overwritten', () => {
  // The full real sequence, not just the two ends of it -- B-1's own bug only shows up because an
  // intermediate pageswap (leaving B, not scrolled) overwrites the OLD single "sc-vt-scrolled"
  // flag before arriving back at A, so a test that skips straight from "leave A" to "arrive at A"
  // would still see the stale old flag and pass for the wrong reason (caught by hand: an earlier
  // draft of this test did exactly that, and a wrong-storage-key mutation slipped through it).
  const storage = makeMemoryStorage();

  // 1. Leave A (scrolled 1500), forward, to B. Records A's own depth under A's own URL.
  const onA = makeSandbox({ sessionStorage: storage, scrollY: 1500, innerHeight: 900, location: { href: 'https://x/a.html' } });
  onA.listeners.pageswap({ viewTransition: {} });

  // 2. Arrive at B (forward, not scrolled).
  const onB = makeSandbox({ sessionStorage: storage, scrollY: 0, innerHeight: 900, location: { href: 'https://x/b.html' } });
  onB.listeners.pagereveal({ viewTransition: { types: fakeTypes() } });

  // 3. Leave B (not scrolled), for Back. This overwrites the old single sc-vt-scrolled flag to
  // '0' -- the OLD mechanism alone would now say "not scrolled" by the time step 4 reads it.
  onB.listeners.pageswap({ viewTransition: {} });

  // 4. Traverse back to A: scrollY reads 0 at reveal time (restoration not yet applied). Only the
  // URL-keyed store (still holding A's own 1500 from step 1) can recover "scrolled" here.
  const onReturnToA = makeSandbox({
    sessionStorage: storage,
    scrollY: 0,
    innerHeight: 900,
    location: { href: 'https://x/a.html' },
    navigation: { activation: { navigationType: 'traverse', from: { index: 1 }, entry: { index: 0 } } },
  });
  const types = fakeTypes();
  onReturnToA.listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('scrolled'));
  assert.ok(types.added.includes('back'));
});

test('vm: the same traverse-back scenario via the Safari performance fallback (no navigation object)', () => {
  const storage = makeMemoryStorage();
  const onA = makeSandbox({ sessionStorage: storage, scrollY: 1500, innerHeight: 900, location: { href: 'https://x/a.html' } });
  onA.listeners.pageswap({ viewTransition: {} });
  const onB = makeSandbox({ sessionStorage: storage, scrollY: 0, innerHeight: 900, location: { href: 'https://x/b.html' } });
  onB.listeners.pagereveal({ viewTransition: { types: fakeTypes() } });
  onB.listeners.pageswap({ viewTransition: {} }); // overwrites the old single flag to '0'

  const onReturnToA = makeSandbox({
    sessionStorage: storage,
    scrollY: 0,
    innerHeight: 900,
    location: { href: 'https://x/a.html' },
    navigation: undefined,
    performance: { getEntriesByType: () => [{ type: 'back_forward' }] },
  });
  const types = fakeTypes();
  onReturnToA.listeners.pagereveal({ viewTransition: { types } });
  assert.ok(types.added.includes('scrolled'));
});

test('vm: a traverse to a URL with no stored depth (or a shallow one) does not add "scrolled"', () => {
  const storage = makeMemoryStorage();
  const { listeners } = makeSandbox({
    sessionStorage: storage,
    scrollY: 0,
    innerHeight: 900,
    location: { href: 'https://x/never-visited.html' },
    navigation: { activation: { navigationType: 'traverse', from: { index: 1 }, entry: { index: 0 } } },
  });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(!types.added.includes('scrolled'));
});

test('vm: a forward (non-traverse) navigation never consults the URL-keyed store', () => {
  // Same URL has a stored deep scrollY from a PRIOR visit, but this arrival is a plain forward
  // navigation (no navigation.activation, no back_forward performance entry) -- the store must
  // not be consulted at all for a forward arrival.
  const storage = makeMemoryStorage();
  storage.setItem('sc-vt-scroll:https://x/a.html', '1500');
  const { listeners } = makeSandbox({
    sessionStorage: storage,
    scrollY: 0,
    innerHeight: 900,
    location: { href: 'https://x/a.html' },
    navigation: undefined,
    performance: { getEntriesByType: () => [] },
  });
  const types = fakeTypes();
  listeners.pagereveal({ viewTransition: { types } });
  assert.ok(!types.added.includes('scrolled'));
  assert.ok(types.added.includes('forward'));
});

test('vm: the URL-keyed scroll index is capped at 20 entries, evicting the oldest', () => {
  const { sandbox, listeners } = makeSandbox({ scrollY: 50, innerHeight: 900, location: { href: 'https://x/page-0.html' } });
  for (let i = 0; i < 25; i++) {
    sandbox.location.href = `https://x/page-${i}.html`;
    listeners.pageswap({ viewTransition: {} });
  }
  const idx = JSON.parse(sandbox.sessionStorage.getItem('sc-vt-scroll-idx'));
  assert.equal(idx.length, 20);
  // The oldest five (page-0..page-4) were evicted, key and all.
  for (let i = 0; i < 5; i++) {
    assert.equal(sandbox.sessionStorage.getItem(`sc-vt-scroll:https://x/page-${i}.html`), null);
  }
  assert.equal(sandbox.sessionStorage.getItem('sc-vt-scroll:https://x/page-24.html'), '50');
});

test('vm: a throwing sessionStorage during the URL-keyed store write throws nothing', () => {
  const { listeners } = makeSandbox({ sessionStorage: makeThrowingStorage(), scrollY: 1500, innerHeight: 900 });
  assert.doesNotThrow(() => listeners.pageswap({ viewTransition: {} }));
});

// -- Mutation proofs (recorded manually in the Engineer report; this suite is the gate) -----------
// remove the marker guard: idempotency tests (both the base script and the .vt-fx second-pass
//   test) go red.
// insert at lastIndexOf('</head>'): the "stray </head> in a comment" test goes red.
// add defer: the "no async/defer/type=" assertion goes red.
// gate the whole script (not just .vt-fx) on TOP_NAV_MARKER: the 404-shaped-page script test goes
//   red.
// swap the up/back precedence: the "both match -> up wins" precedence test goes red.
// invert the landing check: the landing-shaped-page .vt-fx test goes red.
// >= 0 as the scrolled threshold: the scrollY-300 "does not add scrolled" test goes red.
// drop the pageswap sc-vt-scrolled write: the pageswap-writes-scrolled tests go red.
// insert at the last </main> of a page with two: the two-</main> test goes red.
// B-1: drop the isTraverse gate (always consult the URL-keyed store): the "forward navigation
//   never consults the store" test goes red.
// B-1: key the store by the destination URL instead of the outgoing page's own URL: the
//   traverse-back tests go red (nothing is ever stored under the URL being returned to).
// B-1: drop the 20-entry cap: the eviction test's page-0..page-4 assertions go red.
