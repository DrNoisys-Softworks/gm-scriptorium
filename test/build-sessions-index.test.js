'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeSessionsIndex } = require('../src/build/sessions-index');
const { ScriptoriumError } = require('../src/util/errors');
const { runAtomicBuild } = require('../src/build/run');

const ROOT = path.join(__dirname, '..');
const GENERATOR_DIR = path.join(ROOT, 'node_modules', 'gm-apprentice-publish');
const STORY_VAULT = path.join(__dirname, 'fixtures', 'story-vault');
const STORY_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'));

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sessions-index-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A minimal but shape-accurate donor page: nav above <main class="content">, breadcrumb and
// body content inside it, footer/scripts below </main>. Modelled on a real generator build's
// sessions/session-01.html (mini-vault fixture, checked by hand against the pinned generator).
function donorHtml({ title = 'Session One', siteTitle = 'Mini Vault', body = '<p>The party arrived.</p>' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — ${siteTitle}</title>
  <link rel="stylesheet" href="../css/style.css">
</head>
<body>

<header class="top-nav">
  <a href="../index.html" class="nav-brand">${siteTitle}</a>
  <nav class="nav-groups"><a href="index.html">Sessions</a></nav>
</header>

<main class="content">
<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="../index.html">Home</a><span class="sep">&rsaquo;</span>Sessions<span class="sep">&rsaquo;</span>${title}</nav>
<h1 class="page-title">${title}</h1>
${body}
</main>

<button class="back-to-top">&#8593;</button>
<script src="../js/nav.js"></script>

<p class="scriptorium-notice-link" style="font-size:0.8em;opacity:0.7"><a href="../NOTICE.txt">Third-party notices</a></p>
</body>
</html>`;
}

test('no-sessions-dir when <siteRoot>/sessions is absent', () => {
  withTmpDir((dir) => {
    const result = writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });
    assert.deepEqual(result, { written: false, reason: 'no-sessions-dir', entries: 0 });
    assert.equal(fs.existsSync(path.join(dir, 'sessions')), false);
  });
});

test('no-sessions-dir when sessions/ exists but has no donor .html files', () => {
  withTmpDir((dir) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const result = writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });
    assert.deepEqual(result, { written: false, reason: 'no-sessions-dir', entries: 0 });
  });
});

test('already-generated when sessions/index.html pre-exists, and it is left byte-identical (the escape hatch)', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), donorHtml());
    const marker = '<!-- PRE-SEEDED-MARKER-DO-NOT-TOUCH -->';
    fs.writeFileSync(path.join(sessionsDir, 'index.html'), marker);

    const result = writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });

    assert.deepEqual(result, { written: false, reason: 'already-generated', entries: 0 });
    assert.equal(fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8'), marker);
  });
});

test('writes sessions/index.html from the donor: nav/footer preserved, title rewritten, entries listed, donor breadcrumb gone', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), donorHtml({ title: 'Session One' }));
    fs.writeFileSync(path.join(sessionsDir, 'session-02.html'), donorHtml({ title: 'Session Two' }));

    const result = writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });

    assert.deepEqual(result, { written: true, reason: null, entries: 2 });

    const html = fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8');

    // Nav and footer come from the donor's own shell, untouched.
    assert.match(html, /<a href="\.\.\/index\.html" class="nav-brand">Mini Vault<\/a>/);
    assert.match(html, /<script src="\.\.\/js\/nav\.js">/);
    assert.match(html, /<p class="scriptorium-notice-link"/);

    // Title rewritten, not the donor's own.
    assert.match(html, /<title>Sessions — Mini Vault<\/title>/);
    assert.doesNotMatch(html, /<title>Session One/);

    // Both entries listed, sorted by filename, titles stripped of the " — siteTitle" suffix.
    assert.match(html, /href="session-01\.html"><h4>Session One/);
    assert.match(html, /href="session-02\.html"><h4>Session Two/);
    const posOne = html.indexOf('session-01.html');
    const posTwo = html.indexOf('session-02.html');
    assert.ok(posOne < posTwo, 'entries must be sorted by filename');

    // No leftover breadcrumb from the donor (SD-4: the whole span between <main> and </main> is
    // replaced, so the donor's own breadcrumb cannot leak through).
    assert.doesNotMatch(html, /class="breadcrumbs"/);
    assert.doesNotMatch(html, /The party arrived/);
  });
});

test('a lone session produces a singular entry count and escapes an entry title with markup-like characters', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), donorHtml({ title: 'A & B <Test>' }));

    const result = writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });
    assert.deepEqual(result, { written: true, reason: null, entries: 1 });

    const html = fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8');
    assert.match(html, /1 session</);
    assert.match(html, /A &amp; B &lt;Test&gt;/);
    assert.doesNotMatch(html, /<h4>A & B <Test><\/h4>/);
  });
});

test('two builds of an unchanged donor set produce identical index.html', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), donorHtml());

    writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });
    const first = fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8');
    fs.unlinkSync(path.join(sessionsDir, 'index.html'));

    writeSessionsIndex(dir, { siteTitle: 'Mini Vault' });
    const second = fs.readFileSync(path.join(sessionsDir, 'index.html'), 'utf8');

    assert.equal(first, second);
  });
});

test('throws a ScriptoriumError, and writes nothing, when the donor has no <main class="content">', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const mutated = donorHtml().replace('<main class="content">', '<main class="mutated">');
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), mutated);

    assert.throws(
      () => writeSessionsIndex(dir, { siteTitle: 'Mini Vault' }),
      ScriptoriumError,
    );
    assert.equal(fs.existsSync(path.join(sessionsDir, 'index.html')), false);
  });
});

test('throws a ScriptoriumError, and writes nothing, when the donor has no </main>', () => {
  withTmpDir((dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const mutated = donorHtml().replace('</main>', '</div>');
    fs.writeFileSync(path.join(sessionsDir, 'session-01.html'), mutated);

    assert.throws(
      () => writeSessionsIndex(dir, { siteTitle: 'Mini Vault' }),
      ScriptoriumError,
    );
    assert.equal(fs.existsSync(path.join(sessionsDir, 'index.html')), false);
  });
});

// -- change detector: the pin's baseShell must still emit exactly the two literal strings this
// -- module splices around, in the idiom of test/build-site-mirror.test.js:135-153. If a future
// -- pin changes its shell markup, this fails loudly instead of writeSessionsIndex silently
// -- producing a malformed sessions/index.html.

test('the pin\'s baseShell still emits <main class="content"> and </main> (SD-4 donor-transform assumption)', () => {
  const baseSource = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'templates', 'base.js'), 'utf8');
  assert.match(
    baseSource,
    /<main class="content">/,
    'the pin no longer emits <main class="content">; update the donor-transform assumption in src/build/sessions-index.js',
  );
  assert.match(
    baseSource,
    /<\/main>/,
    'the pin no longer emits a literal </main>; update the donor-transform assumption in src/build/sessions-index.js',
  );
});

// -- FR-07 (ADR 0006 addendum, R1 repin): the ADR addendum's claim that this module's own
// -- existence check makes the retirement automatic must be a real test, not prose alone. A real
// -- build of story-vault (real Sessions content) against the installed v1.11.40 pin, through the
// -- ordinary runAtomicBuild path -- not a synthetic writeSessionsIndex() call.

test('FR-07: a real build of story-vault at publish-v1.11.40 gives already-generated, because the pin now writes sessions/index.html itself', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-sessions-index-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...STORY_SITE_CONFIG, vaultPath: STORY_VAULT };
    const finalOut = path.join(scratch, 'out');

    const buildResult = runAtomicBuild({
      vaultPath: STORY_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'story-vault-sessions-index',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));

    // The pin's own lib/build.js writes sessions/index.html (DIR_LABELS-driven, unconditional)
    // before this module ever runs, so the existence check trips and it is a no-op.
    assert.deepEqual(buildResult.sessionsIndex, { written: false, reason: 'already-generated', entries: 0 });
    assert.equal(fs.existsSync(path.join(finalOut, 'sessions', 'index.html')), true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
