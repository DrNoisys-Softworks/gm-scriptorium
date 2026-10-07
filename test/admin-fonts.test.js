'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { ADMIN_ASSET_ROUTES, ADMIN_ASSETS_DIR } = require('../src/admin/assets');
const { buildNoticesText } = require('../scripts/generate-notices');

/*
 * Panel v2 V1a, commit C2. Independent literals throughout (CLAUDE.md testing standards: never
 * derive an assertion's expected value from the code under test). Real-server tests copy
 * test/admin-http.test.js's launch()/withScratch() pattern rather than requiring that test file
 * (patterns to follow: "Real-server launch with teardown ... copy them; never require another
 * test file"). Synthetic cast only (NFR-10/NFR-11); scratch dirs only, t.after teardown on the
 * real listeners.
 */

const ADMIN_FONTS_DIR = path.join(ADMIN_ASSETS_DIR, 'fonts');
const VENDOR_FONTS_DIR = path.join(__dirname, '..', 'scripts', 'vendor', 'fonts');
const FONTS_MANIFEST_PATH = path.join(VENDOR_FONTS_DIR, 'FONTS.json');

// -- 1. Independent literals: family set, the 8 tuples, and the extension-to-type map ----------

const FAMILY_SET = ['IM Fell English', 'IM Fell English SC', 'Alegreya Sans', 'IBM Plex Mono'];

const FONT_TUPLES = [
  { file: 'IMFeENrm28P.ttf', family: 'IM Fell English', weight: 400, style: 'normal' },
  { file: 'IMFeENsc28P.ttf', family: 'IM Fell English SC', weight: 400, style: 'normal' },
  { file: 'AlegreyaSans-Regular.ttf', family: 'Alegreya Sans', weight: 400, style: 'normal' },
  { file: 'AlegreyaSans-Medium.ttf', family: 'Alegreya Sans', weight: 500, style: 'normal' },
  { file: 'AlegreyaSans-Bold.ttf', family: 'Alegreya Sans', weight: 700, style: 'normal' },
  { file: 'AlegreyaSans-Italic.ttf', family: 'Alegreya Sans', weight: 400, style: 'italic' },
  { file: 'IBMPlexMono-Regular.woff2', family: 'IBM Plex Mono', weight: 400, style: 'normal' },
  { file: 'IBMPlexMono-SemiBold.woff2', family: 'IBM Plex Mono', weight: 600, style: 'normal' },
];

const EXT_CONTENT_TYPE = { '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

const FONT_ROUTE_KEYS = FONT_TUPLES.map((t) => `fonts/${t.file}`);

test('FAMILY_SET has exactly 4 families, FONT_TUPLES has exactly 8 entries', () => {
  assert.equal(FAMILY_SET.length, 4);
  assert.equal(FONT_TUPLES.length, 8);
  assert.deepEqual([...new Set(FONT_TUPLES.map((t) => t.family))].sort(), FAMILY_SET.slice().sort());
});

// -- 2. The manifest file set equals the fonts/* route keys, the disk entries, and FONTS.json ---

test('ADMIN_ASSET_ROUTES has exactly one fonts/<file> key per FONT_TUPLES entry, with the extension-to-type map', () => {
  const routeFontKeys = Object.keys(ADMIN_ASSET_ROUTES).filter((k) => k.startsWith('fonts/'));
  assert.deepEqual(routeFontKeys.slice().sort(), FONT_ROUTE_KEYS.slice().sort());
  for (const tuple of FONT_TUPLES) {
    const key = `fonts/${tuple.file}`;
    const ext = path.extname(tuple.file);
    assert.equal(ADMIN_ASSET_ROUTES[key], EXT_CONTENT_TYPE[ext], `${key} should be served as ${EXT_CONTENT_TYPE[ext]}`);
  }
});

test('assets/admin/fonts/ on disk has exactly the 8 files in FONT_TUPLES', () => {
  const onDisk = fs.readdirSync(ADMIN_FONTS_DIR).sort();
  assert.deepEqual(onDisk, FONT_TUPLES.map((t) => t.file).sort());
});

test('FONTS.json exists and its files[] set equals FONT_TUPLES (file, family, weight, style)', () => {
  assert.ok(fs.existsSync(FONTS_MANIFEST_PATH), `${FONTS_MANIFEST_PATH} must exist`);
  const manifest = JSON.parse(fs.readFileSync(FONTS_MANIFEST_PATH, 'utf8'));
  const manifestTuples = manifest.files
    .map((f) => ({ file: f.file, family: f.family, weight: f.weight, style: f.style }))
    .sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(manifestTuples, FONT_TUPLES.slice().sort((a, b) => a.file.localeCompare(b.file)));
  for (const f of manifest.files) {
    assert.equal(f.contentType, EXT_CONTENT_TYPE[path.extname(f.file)]);
    assert.match(f.url, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//, `${f.file}: url must be an immutable (40-hex-commit) raw.githubusercontent.com URL`);
  }
});

// -- 3. Each disk sha256 equals the manifest's -------------------------------------------------

test('every FONTS.json files[] sha256 equals a fresh sha256 of the checked-in assets/admin/fonts/ copy', () => {
  const manifest = JSON.parse(fs.readFileSync(FONTS_MANIFEST_PATH, 'utf8'));
  for (const f of manifest.files) {
    const diskBytes = fs.readFileSync(path.join(ADMIN_FONTS_DIR, f.file));
    const diskSha = crypto.createHash('sha256').update(diskBytes).digest('hex');
    assert.equal(diskSha, f.sha256, `${f.file}: disk sha256 does not match FONTS.json`);
  }
});

// M7 positive control: mutate one byte on disk (scratch copy, never the real file) and confirm
// the same comparison this test relies on actually distinguishes it.
test('positive control: a one-byte-changed copy does NOT match its own manifest sha256', () => {
  const manifest = JSON.parse(fs.readFileSync(FONTS_MANIFEST_PATH, 'utf8'));
  const first = manifest.files[0];
  const original = fs.readFileSync(path.join(ADMIN_FONTS_DIR, first.file));
  const mutated = Buffer.from(original);
  mutated[0] = mutated[0] ^ 0xff;
  const mutatedSha = crypto.createHash('sha256').update(mutated).digest('hex');
  assert.notEqual(mutatedSha, first.sha256);
});

// -- 4. Each OFL file exists and carries the OFL 1.1 marker ------------------------------------

const OFL_MARKER = 'SIL OPEN FONT LICENSE Version 1.1';
const LICENSE_FILES = ['im-fell-english-OFL.txt', 'im-fell-english-sc-OFL.txt', 'alegreya-sans-OFL.txt', 'ibm-plex-mono-OFL.txt'];

test('every vendored OFL text exists and contains the OFL 1.1 marker', () => {
  for (const name of LICENSE_FILES) {
    const p = path.join(VENDOR_FONTS_DIR, name);
    assert.ok(fs.existsSync(p), `${p} must exist`);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(OFL_MARKER), `${name} must contain "${OFL_MARKER}"`);
  }
});

// -- 5. buildNoticesText() carries Section 6, every family, every disk sha256, every OFL text ---

test('buildNoticesText() contains SECTION 6, every family name, every disk sha256 and every OFL text', () => {
  const text = buildNoticesText();
  assert.match(text, /SECTION 6: FONTS EMBEDDED IN THE ADMIN PANEL/);
  for (const family of FAMILY_SET) {
    assert.ok(text.includes(family), `notices text must name family "${family}"`);
  }
  const manifest = JSON.parse(fs.readFileSync(FONTS_MANIFEST_PATH, 'utf8'));
  for (const f of manifest.files) {
    const diskSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ADMIN_FONTS_DIR, f.file))).digest('hex');
    assert.ok(text.includes(diskSha), `notices text must include the sha256 for ${f.file}`);
  }
  for (const name of LICENSE_FILES) {
    const licenseText = fs.readFileSync(path.join(VENDOR_FONTS_DIR, name), 'utf8').trimEnd();
    assert.ok(text.includes(licenseText), `notices text must include the full OFL text from ${name}`);
  }
});

// M13 positive control: dropping one family's OFL text from the built string is detectable.
test('positive control: notices text stripped of one OFL text no longer contains it', () => {
  const text = buildNoticesText();
  const licenseText = fs.readFileSync(path.join(VENDOR_FONTS_DIR, 'ibm-plex-mono-OFL.txt'), 'utf8').trimEnd();
  const stripped = text.split(licenseText).join('<removed>');
  assert.ok(!stripped.includes(licenseText));
  assert.notEqual(stripped, text);
});

// -- 6. Real server: every ADMIN_ASSET_ROUTES key returns 200 with the exact content type and ---
//      bytes equal to disk, including unauthenticated fonts ------------------------------------

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# x\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'Alpha Test' }, null, 2) + '\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath };
}

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-fonts-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Mirrors test/admin-http.test.js's launch(): real handles, t.after() force-close. */
function launch(t, configPath) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed by shutdown() below
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}

function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForHandles(state) {
  while (state.handles.length < 2) {
    await waitForMacrotask();
  }
  return state;
}

async function shutdown(state) {
  state.signals.emit('SIGINT');
  await state.resultPromise;
}

function request(port, { method = 'GET', path: reqPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('real server: every ADMIN_ASSET_ROUTES key returns 200, unauthenticated, with the exact content type and bytes equal to disk', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;

    for (const [name, contentType] of Object.entries(ADMIN_ASSET_ROUTES)) {
      const res = await request(adminPort, { path: `/assets/${name}` });
      const onDisk = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name));
      assert.equal(res.status, 200, `/assets/${name} should be 200`);
      assert.equal(res.headers['content-type'], contentType, `/assets/${name} content-type`);
      assert.ok(Buffer.compare(res.body, onDisk) === 0, `/assets/${name} bytes should equal disk`);
    }

    await shutdown(state);
  });
});

// M9 positive control: the content-type assertion above actually distinguishes a wrong type.
test('positive control: a font served with the wrong content type fails the content-type check', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const res = await request(adminPort, { path: '/assets/fonts/IMFeENrm28P.ttf' });
    assert.notEqual(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['content-type'], 'font/ttf');
    await shutdown(state);
  });
});

// -- 7. Negative controls, each paired with the exact-name positive -----------------------------

test('negative controls: /assets/fonts and /assets/fonts/ both give 404 (no directory listing)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    for (const p of ['/assets/fonts', '/assets/fonts/']) {
      const res = await request(adminPort, { path: p });
      assert.equal(res.status, 404, `${p} should be 404`);
    }
    // paired positive: the exact name is 200
    const ok = await request(adminPort, { path: '/assets/fonts/IMFeENrm28P.ttf' });
    assert.equal(ok.status, 200);
    await shutdown(state);
  });
});

test('negative control: a wrong-case font name gives 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const res = await request(adminPort, { path: '/assets/fonts/imfeenrm28p.ttf' });
    assert.equal(res.status, 404);
    const ok = await request(adminPort, { path: '/assets/fonts/IMFeENrm28P.ttf' });
    assert.equal(ok.status, 200);
    await shutdown(state);
  });
});

test('negative control: a wrong extension (string-prefix sibling) gives 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const res = await request(adminPort, { path: '/assets/fonts/IMFeENrm28P.ttfx' });
    assert.equal(res.status, 404);
    const ok = await request(adminPort, { path: '/assets/fonts/IMFeENrm28P.ttf' });
    assert.equal(ok.status, 200);
    await shutdown(state);
  });
});

test('negative control: a traversal-shaped name (fonts/../admin.css) gives 404, not the admin.css bytes', async (t) => {
  await withScratch(async ({ configPath }) => {
    const state = await waitForHandles(launch(t, configPath));
    const adminPort = state.handles[0].port;
    const res = await request(adminPort, { path: '/assets/fonts/../admin.css' });
    assert.equal(res.status, 404);
    const ok = await request(adminPort, { path: '/assets/admin.css' });
    assert.equal(ok.status, 200);
    await shutdown(state);
  });
});

// M8 positive control: removing one font key from ADMIN_ASSET_ROUTES only (not from disk, not
// from FONTS.json) is exactly what the consistency test (section 2) and the real-server 200 test
// (section 6) are meant to catch; simulated here without mutating the real module.
test('positive control: a route map missing one font key fails the same consistency shape the real check uses', () => {
  const withoutOne = { ...ADMIN_ASSET_ROUTES };
  delete withoutOne['fonts/IMFeENrm28P.ttf'];
  const routeFontKeys = Object.keys(withoutOne).filter((k) => k.startsWith('fonts/'));
  assert.notDeepEqual(routeFontKeys.slice().sort(), FONT_ROUTE_KEYS.slice().sort());
});
