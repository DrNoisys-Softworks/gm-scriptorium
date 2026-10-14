'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const preview = require('../src/admin/preview');
const previewstrip = require('../src/admin/previewstrip');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');

/*
 * The "not your live site" strip (docs/decisions/0035-preview-in-a-frame.md, addendum "The not-live
 * strip"). Every expected string is written out by hand, not read back from the module. Synthetic
 * cast only; test/fixtures/vocab-vault is copied to scratch first and never written in place.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');
const MARKER = 'data-scriptorium-preview-strip';
const DOCS_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/README.md';

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', ...opts });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  return res;
}

async function withVocabVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-strip-'));
  try {
    const vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    return await fn({ vaultPath, configPath }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeCtx(configPath) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  const ctx = createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
  ctx.adminPort = 4321;
  return ctx;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** A scratch preview tree with one HTML file per entry of `pages` (name > html). */
function withTree(pages, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-strip-tree-'));
  try {
    const previewDir = path.join(root, 'site');
    fs.mkdirSync(previewDir);
    for (const [name, html] of Object.entries(pages)) {
      fs.mkdirSync(path.dirname(path.join(previewDir, name)), { recursive: true });
      fs.writeFileSync(path.join(previewDir, name), html);
    }
    return fn({ previewRoot: root, previewDir, adminPort: 4321, access: null }, previewDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- the snippet --------------------------------------------------------------

test('the snippet: one marker, the agreed words, the two links, no script, no token', () => {
  const html = previewstrip.previewStripSnippet('http://127.0.0.1:4321/');
  assert.equal(count(html, MARKER), 1);
  assert.ok(html.includes('Preview only, not your live site.'));
  assert.ok(html.includes('Only you can see this page. Players see what you publish.'));
  assert.ok(html.includes('<a href="http://127.0.0.1:4321/">Back to the panel</a>'));
  assert.ok(html.includes(`href="${DOCS_URL}"`));
  assert.ok(html.includes('>How to publish</a>'));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(html, /token/i);
  assert.doesNotMatch(html, /—/, 'no em dash');
});

test('the snippet escapes the panel address it is given', () => {
  const html = previewstrip.previewStripSnippet('http://x/"><script>1</script>');
  assert.doesNotMatch(html, /<script>1/);
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('the publishing-guide address is one fixed constant', () => {
  assert.equal(previewstrip.PUBLISH_HELP_URL, DOCS_URL);
});

// --- injection ----------------------------------------------------------------

test('a plain <body> page gets the strip straight after the opening tag, once', () => {
  withTree({ 'index.html': '<!DOCTYPE html><html><head><title>t</title></head><body>\n<main>Hello</main>\n</body></html>' }, (ctx, dir) => {
    const res = previewstrip.injectPreviewStrips(ctx);
    assert.deepEqual(res, { pagesMarked: 1 });
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal(count(html, MARKER), 1);
    const open = html.indexOf('<body>') + '<body>'.length;
    assert.equal(html.slice(open, open + 9), '<aside cl', 'the strip begins right after <body>');
    assert.ok(html.indexOf(MARKER) < html.indexOf('<main>'));
    assert.ok(html.includes('<a href="http://127.0.0.1:4321/">Back to the panel</a>'));
  });
});

test('a <body> with attributes keeps them, and the strip still follows the whole tag', () => {
  withTree({ 'a.html': '<html><body class="theme-dark" data-x="a>b"><p>x</p></body></html>' }, (ctx, dir) => {
    previewstrip.injectPreviewStrips(ctx);
    const html = fs.readFileSync(path.join(dir, 'a.html'), 'utf8');
    assert.ok(html.startsWith('<html><body class="theme-dark" data-x="a>b"><aside'), html.slice(0, 80));
    assert.equal(count(html, MARKER), 1);
    assert.ok(html.indexOf('<aside') > html.indexOf('<body class="theme-dark"'));
    assert.ok(html.indexOf('<aside') < html.indexOf('<p>x</p>'));
  });
});

test('a <BODY> in capitals is found too', () => {
  withTree({ 'u.html': '<HTML><BODY ID=x><p>y</p></BODY></HTML>' }, (ctx, dir) => {
    assert.deepEqual(previewstrip.injectPreviewStrips(ctx), { pagesMarked: 1 });
    assert.equal(count(fs.readFileSync(path.join(dir, 'u.html'), 'utf8'), MARKER), 1);
  });
});

test('a second run adds nothing: every page keeps exactly one strip, bytes unchanged', () => {
  withTree({ 'index.html': '<body><p>a</p></body>', 'sub/b.html': '<body class="c"><p>b</p></body>' }, (ctx, dir) => {
    assert.deepEqual(previewstrip.injectPreviewStrips(ctx), { pagesMarked: 2 });
    const before = ['index.html', 'sub/b.html'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(previewstrip.injectPreviewStrips(ctx), { pagesMarked: 0 });
    const after = ['index.html', 'sub/b.html'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(after, before);
    for (const html of after) assert.equal(count(html, MARKER), 1);
  });
});

test('a page with no <body> is left alone, byte for byte; non-HTML files are never touched', () => {
  const bare = '<meta http-equiv="refresh" content="0;url=x.html">';
  withTree({ 'r.html': bare, 'data.json': '{"body":"<body>"}', 'note.txt': '<body>' }, (ctx, dir) => {
    assert.deepEqual(previewstrip.injectPreviewStrips(ctx), { pagesMarked: 0 });
    assert.equal(fs.readFileSync(path.join(dir, 'r.html'), 'utf8'), bare);
    assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), '{"body":"<body>"}');
    assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), '<body>');
  });
});

test('the word "body" in a head, a comment-free tag such as <bodyguard>, is not mistaken for <body>', () => {
  withTree({ 'x.html': '<html><head><bodyguard></bodyguard></head><body><p>z</p></body></html>' }, (ctx, dir) => {
    previewstrip.injectPreviewStrips(ctx);
    const html = fs.readFileSync(path.join(dir, 'x.html'), 'utf8');
    assert.ok(html.includes('<head><bodyguard></bodyguard></head><body><aside'));
  });
});

test('a symlinked HTML file is never followed or written', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-preview-strip-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previewDir = path.join(root, 'site');
  fs.mkdirSync(previewDir);
  const outside = path.join(root, 'outside.html');
  fs.writeFileSync(outside, '<body>o</body>');
  try {
    fs.symlinkSync(outside, path.join(previewDir, 'link.html'));
  } catch {
    t.skip('symlinks not available here');
    return;
  }
  assert.deepEqual(previewstrip.injectPreviewStrips({ previewRoot: root, previewDir, adminPort: 4321, access: null }), { pagesMarked: 0 });
  assert.equal(fs.readFileSync(outside, 'utf8'), '<body>o</body>');
});

test('preconditions fail closed: previewDir must be the "site" child of previewRoot, and adminPort a real port', () => {
  assert.throws(() => previewstrip.injectPreviewStrips({ previewRoot: '/a', previewDir: '/a/b/site', adminPort: 4321 }), /previewDir/);
  assert.throws(() => previewstrip.injectPreviewStrips({ previewRoot: '/a', previewDir: '/a/site', adminPort: 0 }), /adminPort/);
  assert.throws(() => previewstrip.injectPreviewStrips({ previewRoot: '/a', previewDir: '/a/site', adminPort: 70000 }), /adminPort/);
  assert.throws(() => previewstrip.injectPreviewStrips({ previewRoot: '/a', previewDir: '/a/site', adminPort: '4321' }), /adminPort/);
});

// --- links --------------------------------------------------------------------

test('"Back to the panel" follows the active mode; "How to publish" never changes', () => {
  const pages = { 'i.html': '<body></body>' };
  withTree(pages, (ctx, dir) => {
    previewstrip.injectPreviewStrips(ctx);
    const html = fs.readFileSync(path.join(dir, 'i.html'), 'utf8');
    assert.ok(html.includes('<a href="http://127.0.0.1:4321/">Back to the panel</a>'));
    assert.equal(count(html, DOCS_URL), 1);
  });
  withTree(pages, (ctx, dir) => {
    ctx.access = { remote: true, admin: { origin: 'https://panel.home.arpa' } };
    Object.assign(ctx, { publishUrl: 'https://example.invalid/other', docsUrl: 'https://example.invalid/other', howToPublishUrl: 'https://example.invalid/other' });
    ctx.ctxInfo = { publishUrl: 'https://example.invalid/other' };
    previewstrip.injectPreviewStrips(ctx);
    const html = fs.readFileSync(path.join(dir, 'i.html'), 'utf8');
    assert.ok(html.includes('<a href="https://panel.home.arpa/">Back to the panel</a>'));
    assert.equal(count(html, DOCS_URL), 1);
    assert.ok(!html.includes('example.invalid'));
  });
});

// --- through the real pipeline ------------------------------------------------

test('the real preview build: every page with a <body> has exactly one strip right after the opening tag, and the rest equals a fresh CLI build', async () => {
  await withVocabVault(async ({ configPath }, root) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const res = preview.buildPreviewWithGmLink(ctx);
      assert.equal(res.exitCode, 0, res.human);
      const freshOut = path.join(root, 'fresh-out');
      const fresh = run(['build', 'vocab', '--config', configPath, '--out', freshOut], { env: scratchEnv(root) });
      assert.equal(fresh.status, 0, fresh.stderr);

      const gmlink = require('../src/admin/gmlink');
      const gmSnippet = gmlink.gmLinkSnippet(gmlink.gmLinkHref(ctx.adminPort));
      const stripSnippet = previewstrip.previewStripSnippet(gmlink.gmLinkHref(ctx.adminPort));
      let pages = 0;
      assert.deepEqual(listFiles(ctx.previewDir), listFiles(freshOut));
      for (const rel of listFiles(ctx.previewDir)) {
        const p = fs.readFileSync(path.join(ctx.previewDir, rel));
        if (!rel.endsWith('.html')) {
          assert.deepEqual(p, fs.readFileSync(path.join(freshOut, rel)), `byte mismatch at ${rel}`);
          continue;
        }
        const text = p.toString('utf8');
        const freshText = fs.readFileSync(path.join(freshOut, rel), 'utf8');
        if (!/<body[\s>]/i.test(freshText)) {
          assert.equal(text, freshText);
          continue;
        }
        pages++;
        assert.equal(count(text, MARKER), 1, `expected one strip in ${rel}`);
        assert.equal(text.split(stripSnippet).join('').split(gmSnippet).join(''), freshText, `byte mismatch after removing both snippets at ${rel}`);
        const m = /<body(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>/i.exec(text);
        assert.ok(text.slice(m.index + m[0].length).startsWith(stripSnippet), `strip is not straight after <body> in ${rel}`);
      }
      assert.ok(pages > 0, 'the fixture must have at least one page with a <body>');
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('a refused preview build adds no strip (same rule as the GM link): the previous preview is untouched', async () => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      assert.equal(preview.buildPreviewWithGmLink(ctx).exitCode, 0);
      const before = new Map(listFiles(ctx.previewDir).map((rel) => [rel, fs.readFileSync(path.join(ctx.previewDir, rel))]));
      fs.writeFileSync(path.join(vaultPath, '_meta', 'stray.md'), '---\n---\n');
      const res = preview.buildPreviewWithGmLink(ctx);
      assert.equal(res.exitCode, 2);
      const after = listFiles(ctx.previewDir);
      assert.deepEqual(after, [...before.keys()]);
      for (const rel of after) {
        const bytes = fs.readFileSync(path.join(ctx.previewDir, rel));
        assert.ok(bytes.equals(before.get(rel)), `${rel} changed after a refused build`);
        if (rel.endsWith('.html') && /<body/i.test(bytes.toString('utf8'))) assert.equal(count(bytes.toString('utf8'), MARKER), 1, rel);
      }
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- AC-S7-02: never in a published build ---------------------------------------

test('AC-S7-02: a real CLI build of the sample vault carries zero strip bytes in any file; the preview of the same vault carries them (positive control)', async () => {
  await withVocabVault(async ({ configPath }, root) => {
    const out = path.join(root, 'published');
    const built = run(['build', 'vocab', '--config', configPath, '--out', out], { env: scratchEnv(root) });
    assert.equal(built.status, 0, built.stderr);
    const files = listFiles(out);
    assert.ok(files.length > 5, 'the build must have produced real output');
    const needles = [MARKER, 'scriptorium-preview-strip', 'Preview only, not your live site', 'Back to the panel', 'How to publish', DOCS_URL].map((n) => Buffer.from(n, 'utf8'));
    let hits = 0;
    for (const rel of files) {
      const bytes = fs.readFileSync(path.join(out, rel));
      for (const n of needles) if (bytes.includes(n)) hits++;
    }
    assert.equal(hits, 0, 'strip bytes found in a published build');

    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      assert.equal(preview.buildPreviewWithGmLink(ctx).exitCode, 0);
      let previewHits = 0;
      for (const rel of listFiles(ctx.previewDir)) {
        if (fs.readFileSync(path.join(ctx.previewDir, rel)).includes(needles[0])) previewHits++;
      }
      assert.ok(previewHits > 0, 'positive control: the preview must carry the marker');
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

test('runPreviewBuild alone adds nothing: only buildPreviewWithGmLink adds the strip', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      assert.equal(preview.runPreviewBuild(ctx).exitCode, 0);
      for (const rel of listFiles(ctx.previewDir).filter((f) => f.endsWith('.html'))) {
        assert.equal(count(fs.readFileSync(path.join(ctx.previewDir, rel), 'utf8'), MARKER), 0, rel);
      }
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});
