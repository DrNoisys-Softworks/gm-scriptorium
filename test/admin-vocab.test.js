'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./helpers/toml-plain');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const TOML = require('smol-toml');

const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');
const { resolveVaultSite } = require('../src/cli/check');
const { parsePackToml } = require('../src/build/packtoml');
const vocabHandler = require('../src/admin/handlers/vocab');

/*
 * Phase 8 slice S4 (docs/agent-runs/admin-s4-engineering-brief-2026-09-28.md, "Test-first order"
 * item 2). Real sockets through S1's exports, S3's real runSave/replacePackFile, and the real
 * labels.js/packtoml.js parsers -- mirrors test/admin-pack.test.js's own harness (ctxFor, launch
 * with t.after, post). Synthetic cast only (NFR-10/NFR-11); every vault is built fresh in
 * os.tmpdir(), or copied from a scratch copy of test/fixtures/vocab-vault -- never written into
 * test/fixtures itself.
 */

const TOKEN = 'admin-vocab-test-token';
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

// -- Independent expected values (CLAUDE.md: "never derive an assertion's expected value from
// the code under test"). Hand-written here, not imported from src/build/labels.js. --

const LABEL_NAMES = [
  'learned_lens',
  'learned_legend',
  'story_lens',
  'chapter',
  'recap',
  'recap_learned_link',
  'same_recap',
  'connections_heading',
  'group_tie',
  'group_named',
  'group_pc',
  'group_npc',
  'group_faction',
  'group_location',
  'group_thing',
  'group_event',
  'group_other',
];

const COLUMN_NAMES = ['title', 'kind', 'weight', 'place', 'in_game', 'when', 'real_world', 'what', 'session', 'learned', 'after'];

const TIMELINE_KEYS = ['kinds', 'weights', 'session_token', 'segment_units', 'columns'];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-vocab-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A convention-pack vault, minimal by default; pass toml/writeToml to shape it. */
function writeVault(root, { toml = 'theme = "plain"\n', writeToml = true } = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  if (writeToml) fs.writeFileSync(path.join(packDir, 'pack.toml'), toml);
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Vocab Test' }, null, 2)}\n`);
  return { vaultPath, packDir };
}

/** Copies the real fixture into a scratch vault (T7's "same file" and T18's real content). */
function writeVocabFixtureVault(root) {
  const vaultPath = path.join(root, 'vault');
  copyDir(path.join(__dirname, 'fixtures', 'vocab-vault'), vaultPath);
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  return { vaultPath, packDir };
}

function writeConfigToml(root, vaultPath, campaign) {
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vaultPath}'`, `output = '${path.join(root, 'out')}'`, ''].join(
      '\n',
    ),
  );
  return configPath;
}

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', ...opts });
  assert.equal(res.error, undefined, `spawn error: ${res.error && res.error.message}`);
  return res;
}

function ctxFor(vaultPath, extra = {}) {
  const ctxInfo = { campaign: 'vocab', vault: vaultPath, ...extra };
  const { site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: TOKEN });
}

/** Starts a real admin listener bound to ctx; t.after() force-closes it (Lesson 4). */
async function launch(t, ctx) {
  const handle = await startLocalListener(createAdminHandler(ctx), { port: 0 });
  ctx.adminPort = handle.port;
  t.after(async () => {
    try {
      await handle.close();
    } catch {
      // already closed
    }
  });
  return handle.port;
}

/** A real POST over a real socket, with a valid Host/Origin/Cookie by default. */
function post(port, urlPath, obj, { auth = true, origin, host } = {}) {
  const bodyBuf = Buffer.from(JSON.stringify(obj));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBuf.length),
    Host: host || `127.0.0.1:${port}`,
    Origin: origin || `http://127.0.0.1:${port}`,
  };
  if (auth) headers.Cookie = `scriptorium_admin_${port}=${TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          // leave json null; a test asserting on it will fail loudly
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** A raw POST/GET with fully caller-controlled headers (T15: gate pairs). */
function raw(port, urlPath, { method = 'POST', headers = {}, body } = {}) {
  const bodyBuf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const finalHeaders = { 'Content-Type': 'application/json', 'Content-Length': String(bodyBuf.length), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw: rawBody });
      });
    });
    req.on('error', reject);
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function get(port, urlPath, { host, cookie } = {}) {
  const headers = { Host: host || `127.0.0.1:${port}` };
  if (cookie !== undefined) headers.Cookie = cookie;
  else headers.Cookie = `scriptorium_admin_${port}=${TOKEN}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        let json = null;
        try {
          json = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null;
        } catch {
          // leave json null
        }
        resolve({ status: res.statusCode, json, raw: rawBody });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- T1: a single-key set, everything else untouched -----------------------

test('T1: setting one label gives 200; the label lands, the rest of [labels]/[timeline]/[recaps] are untouched', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { connections_heading: 'Bonds' }, baseSha256 });
    assert.equal(res.status, 200);

    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(after.labels.connections_heading, 'Bonds');
    const { connections_heading: _dropped, ...otherBeforeLabels } = before.labels;
    const { connections_heading: _dropped2, ...otherAfterLabels } = after.labels;
    assert.deepEqual(otherAfterLabels, otherBeforeLabels);
    assert.deepEqual(after.timeline, before.timeline);
    assert.deepEqual(after.recaps, before.recaps);
  });
});

// --- T2: null removes a key, keeps the rest ---------------------------------

test('T2: labels.group_npc = null removes that key and keeps the rest of [labels]', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { group_npc: null }, baseSha256 });
    assert.equal(res.status, 200);

    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(after.labels, 'group_npc'));
    const { group_npc: _dropped, ...otherBeforeLabels } = before.labels;
    assert.deepEqual(plain(after.labels), otherBeforeLabels);
  });
});

// --- T3 (FR20): unknown keys, added by hand, survive ------------------------

test('T3 (FR20): unknown on-disk keys in [labels], [timeline] and a kind entry survive a labels-only save', async (t) => {
  await withScratchDir(async (root) => {
    const toml = [
      'theme = "plain"',
      '',
      '[labels]',
      'chapter = "Episode"',
      'future_label = "x"',
      '',
      '[timeline]',
      'future_key = "y"',
      '',
      '[[timeline.kinds]]',
      'key = "fight"',
      'color = "red"',
      '',
      '[recaps]',
      'learned_heading = "Lessons"',
      '',
    ].join('\n');
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256 });
    assert.equal(res.status, 200);

    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(after.labels.chapter, 'Session');
    assert.equal(after.labels.future_label, 'x');
    assert.equal(after.timeline.future_key, 'y');
    assert.equal(after.timeline.kinds[0].color, 'red');
  });
});

test('T3 (FR20): a kinds save that echoes an unknown kind-entry key keeps it', async (t) => {
  await withScratchDir(async (root) => {
    const toml = ['theme = "plain"', '', '[[timeline.kinds]]', 'key = "fight"', 'color = "red"', ''].join('\n');
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', {
      timeline: { kinds: [{ key: 'fight', color: 'red', glyph: 'fight' }] },
      baseSha256,
    });
    assert.equal(res.status, 200);
    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(after.timeline.kinds[0].color, 'red');
    assert.equal(after.timeline.kinds[0].glyph, 'fight');
  });
});

// --- T4/T5: an emptied table is removed, never fabricated ------------------

test('T4: removing the only [labels] key on theme = "plain"\\n\\n[labels]\\nchapter = "Episode"\\n leaves exactly theme = "plain"\\n', async (t) => {
  await withScratchDir(async (root) => {
    const toml = 'theme = "plain"\n\n[labels]\nchapter = "Episode"\n';
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: null }, baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

test('T5: removing a label that was never on disk, on theme = "plain"\\n, leaves exactly theme = "plain"\\n (no [labels] table created)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: null }, baseSha256 });
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), 'theme = "plain"\n');
  });
});

// --- T6: timeline.columns merges key by key ---------------------------------

test('T6: a partial edit to timeline.columns keeps every other on-disk column key; a null removes only that column', async (t) => {
  await withScratchDir(async (root) => {
    const toml = ['theme = "plain"', '', '[timeline.columns]', 'title = ["heading"]', 'kind = ["sort"]', 'place = ["where"]', ''].join('\n');
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { timeline: { columns: { title: ['heading2'] } }, baseSha256 });
    assert.equal(res.status, 200);
    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.deepEqual(after.timeline.columns.title, ['heading2']);
    assert.deepEqual(after.timeline.columns.kind, ['sort']);
    assert.deepEqual(after.timeline.columns.place, ['where']);
  });
});

test('T6b: nulling a column removes only that column key, keeping the rest', async (t) => {
  await withScratchDir(async (root) => {
    const toml = ['theme = "plain"', '', '[timeline.columns]', 'title = ["heading"]', 'kind = ["sort"]', ''].join('\n');
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { timeline: { columns: { kind: null } }, baseSha256 });
    assert.equal(res.status, 200);
    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(after.timeline.columns, 'kind'));
    assert.deepEqual(after.timeline.columns.title, ['heading']);
  });
});

// --- T7 (FR25 parity, real pipeline) ----------------------------------------

// Each case hand-edits an EXISTING line in vocab-vault's own pack.toml (never appends a second
// [timeline]/[labels] table -- smol-toml/TOML both refuse to redefine a table, which would make
// the "same file" hand-edit invalid TOML for an unrelated reason).
const T7_CASES = [
  {
    name: 'session_token: invalid regex syntax',
    find: "session_token = '\\bEp(\\d+)\\b'",
    replace: "session_token = '\\bEp(\\d+'",
    body: { timeline: { session_token: '\\bEp(\\d+' } },
  },
  {
    name: 'session_token: valid syntax, zero capture groups',
    find: "session_token = '\\bEp(\\d+)\\b'",
    replace: "session_token = '\\bEp\\d+\\b'",
    body: { timeline: { session_token: '\\bEp\\d+\\b' } },
  },
  {
    name: 'weights: only 2 entries',
    find: 'weights = ["footnote", "scene", "watershed"]',
    replace: 'weights = ["a", "b"]',
    body: { timeline: { weights: ['a', 'b'] } },
  },
  {
    name: 'labels: a control character',
    find: 'chapter = "Episode"',
    replace: 'chapter = "x\\u0007y"',
    body: { labels: { chapter: 'x\u0007y' } },
  },
];

// The omen-kind glyph case needs the kind to already exist on disk (glyph via `timeline.kinds`
// replaces the whole array, so it's exercised on its own with a matching on-disk fixture).
test('T7 (FR25 parity, real pipeline): each C37 step-6 refusal (plus weights/control-char) gives 400, writes nothing, and its message equals check\'s stderr on the SAME file', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const configPath = writeConfigToml(root, vaultPath, 'vocab');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');

    for (const c of T7_CASES) {
      const before = fs.readFileSync(tomlPath);
      const beforeText = before.toString('utf8');
      assert.ok(beforeText.includes(c.find), `${c.name}: fixture no longer contains the line this case hand-edits`);
      const baseSha256 = sha256(before);
      const res = await post(port, '/api/pack/vocab', { ...c.body, baseSha256 });
      assert.equal(res.status, 400, c.name);
      assert.deepEqual(fs.readFileSync(tomlPath), before, `${c.name}: nothing written`);
      const panelMessage = res.json.message;

      // Write the same value by hand into the SAME file, then run `check` on it.
      fs.writeFileSync(tomlPath, beforeText.replace(c.find, c.replace));
      const cli = runCli(['check', 'vocab', '--config', configPath], { env: scratchEnv(root) });
      const firstStderrLine = cli.stderr.split('\n')[0];
      assert.equal(firstStderrLine, panelMessage, `${c.name}: CLI parity`);
      // Restore.
      fs.writeFileSync(tomlPath, before);
    }
  });
});

test('T7 (FR25 parity, real pipeline): the omen kind\'s glyph refusal matches check on the same file', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const configPath = writeConfigToml(root, vaultPath, 'vocab');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath, 'utf8');
    const parsedBefore = TOML.parse(before);
    const baseSha256 = sha256(Buffer.from(before, 'utf8'));

    const kinds = parsedBefore.timeline.kinds.map((k) => (k.key === 'omen' ? { ...k, glyph: '<path d="M0 0"/>' } : k));
    const res = await post(port, '/api/pack/vocab', { timeline: { kinds }, baseSha256 });
    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), before);
    const panelMessage = res.json.message;

    const onDisk = before.replace('glyph = "M10 2 L18 18 L2 18 Z"', 'glyph = "<path d=\\"M0 0\\"/>"');
    assert.notEqual(onDisk, before, 'the hand edit must actually change the omen kind\'s glyph line');
    fs.writeFileSync(tomlPath, onDisk);
    const cli = runCli(['check', 'vocab', '--config', configPath], { env: scratchEnv(root) });
    const firstStderrLine = cli.stderr.split('\n')[0];
    assert.equal(firstStderrLine, panelMessage);
  });
});

// --- T8: shape refusals, exact messages, each with a positive control ------

const T8_CASES = [
  {
    name: 'labels must be a table',
    body: { labels: 'x' },
    message: 'vocab edit: labels must be a table',
    positive: { labels: { chapter: 'Session' } },
  },
  {
    name: 'unknown label',
    body: { labels: { chapter_extra: 'x' } },
    message: 'vocab edit: unknown label "chapter_extra"',
    positive: { labels: { chapter: 'Session' } },
  },
  {
    name: 'a number value',
    body: { labels: { chapter: 5 } },
    message: 'vocab edit: labels.chapter must be a string or null',
    positive: { labels: { chapter: 'Session' } },
  },
  {
    name: 'timeline.kinds not an array',
    body: { timeline: { kinds: {} } },
    message: 'vocab edit: timeline.kinds must be an array of tables or null',
    positive: { timeline: { kinds: [{ key: 'fight', glyph: 'fight' }] } },
  },
  // A mutation of my own (Lesson 3), and a gap-fill in the brief's own literal message list
  // (see the Engineer's report): the brief's 15 messages have no "timeline must be a table"
  // entry, even though "labels must be a table" and "recaps must be a table" both exist.
  // Object.keys(null) throws and Object.keys(<other primitives>) silently no-ops, so a bare
  // `timeline: "x"` or `timeline: null` needs its own explicit refusal to avoid a 500 or a
  // silent no-op accept.
  {
    name: 'timeline not a table (Engineer gap-fill)',
    body: { timeline: 'x' },
    message: 'vocab edit: timeline must be a table',
    positive: { timeline: { weights: ['a', 'b', 'c'] } },
  },
  {
    name: 'timeline is null (Engineer gap-fill)',
    body: { timeline: null },
    message: 'vocab edit: timeline must be a table',
    positive: { timeline: { weights: ['a', 'b', 'c'] } },
  },
  {
    name: 'a null inside columns.title',
    body: { timeline: { columns: { title: [null] } } },
    message: 'vocab edit: timeline.columns.title must be an array of strings or null',
    positive: { timeline: { columns: { title: ['heading2'] } } },
  },
  {
    name: 'labels forbidden key __proto__',
    body: { labels: JSON.parse('{"__proto__":"x"}') },
    message: 'vocab edit: the key "__proto__" is not allowed',
    positive: { labels: { chapter: 'Session' } },
  },
  {
    name: 'timeline.columns forbidden key __proto__',
    body: { timeline: { columns: JSON.parse('{"__proto__":[]}') } },
    message: 'vocab edit: the key "__proto__" is not allowed',
    positive: { timeline: { columns: { title: ['heading2'] } } },
  },
];

for (const c of T8_CASES) {
  test(`T8: ${c.name} gives 400 with the exact message, writes nothing (positive control included)`, async (t) => {
    await withScratchDir(async (root) => {
      const { vaultPath, packDir } = writeVocabFixtureVault(root);
      const ctx = ctxFor(vaultPath);
      const port = await launch(t, ctx);
      const tomlPath = path.join(packDir, 'pack.toml');
      const before = fs.readFileSync(tomlPath);
      const baseSha256 = sha256(before);

      const bad = await post(port, '/api/pack/vocab', { ...c.body, baseSha256 });
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.json, { error: 'invalid', message: c.message });
      assert.deepEqual(fs.readFileSync(tomlPath), before);

      const good = await post(port, '/api/pack/vocab', { ...c.positive, baseSha256 });
      assert.equal(good.status, 200);
    });
  });
}

// A mutation of my own (Lesson 3): __proto__ inside a kinds entry is the ONE place no other
// unknown-key check would ever catch it, because kinds entries deliberately allow unrecognised
// keys (FR20 echo-back). This is the case that actually proves the forbidden-key walk is
// recursive, not just applied to each table's own top-level keys.
test('T8 (own mutation): a forbidden key inside a kinds entry is refused, even though kinds entries otherwise allow unknown keys', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);

    const entry = JSON.parse('{"key":"fight","glyph":"fight","__proto__":"x"}');
    const bad = await post(port, '/api/pack/vocab', { timeline: { kinds: [entry] }, baseSha256 });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid', message: 'vocab edit: the key "__proto__" is not allowed' });
    assert.deepEqual(fs.readFileSync(tomlPath), before);

    // Positive control: the same entry, minus the forbidden key, with an ordinary unknown key
    // instead -- which kinds entries DO allow (FR20).
    const okEntry = { key: 'fight', glyph: 'fight', color: 'red' };
    const good = await post(port, '/api/pack/vocab', { timeline: { kinds: [okEntry] }, baseSha256 });
    assert.equal(good.status, 200);
  });
});

// --- T9 (injection): TOML injection via a label value is impossible --------

test('T9 (injection): a label value containing TOML-breaking text is stored verbatim; no [images] table is created', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    const evil = 'x" ] [images] hero = "y';

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: evil }, baseSha256 });
    assert.equal(res.status, 200);
    const after = TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
    assert.equal(after.labels.chapter, evil);
    assert.equal(after.images, undefined);
  });
});

// --- T10 (D06): dry run ------------------------------------------------------

test('T10 (D06): dryRun returns before/after, leaves the hash unchanged; commentsLost tracks on-disk comments', async (t) => {
  await withScratchDir(async (root) => {
    const toml = '# a note\ntheme = "plain"\n';
    const { vaultPath, packDir } = writeVault(root, { toml });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    const baseSha256 = sha256(before);

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.dryRun, true);
    assert.equal(res.json.before, before.toString('utf8'));
    assert.ok(res.json.after.includes('chapter = "Session"'));
    assert.equal(res.json.commentsLost, true);
    assert.deepEqual(fs.readFileSync(tomlPath), before, 'a dry run must not write');
    assert.equal(sha256(fs.readFileSync(tomlPath)), baseSha256);
  });
});

test('T10 positive control: commentsLost is false for an on-disk pack.toml with no comment', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256, dryRun: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.commentsLost, false);
  });
});

// --- T11 (FR05, real pipeline): writable only for convention packs ---------

test('T11 (FR05): a site_config campaign is read-only, 403 with the exact reason', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const siteConfigPath = path.join(root, 'site.json');
    fs.writeFileSync(siteConfigPath, `${JSON.stringify({ siteTitle: 'X' }, null, 2)}\n`);

    const ctx = ctxFor(vaultPath, { site_config: siteConfigPath });
    const port = await launch(t, ctx);
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: 'a'.repeat(64) });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        'This campaign builds from a site_config file, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.',
    });
  });
});

test('T11 (FR05): a pack-key campaign is read-only, 403 with the exact reason', async (t) => {
  await withScratchDir(async (root) => {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    const packKeyDir = path.join(root, 'external-pack');
    fs.mkdirSync(packKeyDir, { recursive: true });
    fs.writeFileSync(path.join(packKeyDir, 'vault.config.json'), `${JSON.stringify({ siteTitle: 'Y' }, null, 2)}\n`);

    const ctx = ctxFor(vaultPath, { pack: packKeyDir });
    const port = await launch(t, ctx);
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: 'a'.repeat(64) });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, {
      error: 'read-only',
      message:
        "This campaign's pack key points at a folder of its own, so the panel is read-only. It only ever edits the campaign pack at _meta/scriptorium/ inside the vault.",
    });
  });
});

test('T11 (FR05) positive control: a convention campaign is writable', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    assert.equal(ctx.writable, true);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 200);
  });
});

// --- T12 (FR31): the write mutex --------------------------------------------

test('T12 (FR31): a save while ctx.busy is set gets 409 busy, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);
    ctx.busy = 'build';

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(before) });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'busy', busy: 'build' });
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

test('T12 (FR31) positive control: the same request when not busy succeeds', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 200);
  });
});

// --- T13 (FR17/FR21): stale sha and invalid on-disk TOML --------------------

test('T13 (FR17): a stale baseSha256 gives 409 changed, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const staleSha = sha256(fs.readFileSync(tomlPath));
    fs.writeFileSync(tomlPath, 'theme = "haze"\n');
    const before = fs.readFileSync(tomlPath);

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: staleSha });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

test('T13 (FR17) positive control: a matching sha succeeds', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 200);
  });
});

test('T13 (FR21): invalid on-disk TOML gives 422, and nothing is written', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n[labels\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath);

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(before) });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'invalid-on-disk');
    assert.deepEqual(fs.readFileSync(tomlPath), before);
  });
});

test('T13 (FR21) positive control: valid on-disk TOML is editable', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { toml: 'theme = "plain"\n' });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: sha256(fs.readFileSync(tomlPath)) });
    assert.equal(res.status, 200);
  });
});

// --- T14: a missing pack.toml gives 409 changed -----------------------------

test('T14: a missing pack.toml gives 409 changed (SD-4: "save a theme first")', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root, { writeToml: false });
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    assert.equal(fs.existsSync(tomlPath), false);

    const res = await post(port, '/api/pack/vocab', { labels: { chapter: 'Session' }, baseSha256: 'a'.repeat(64) });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'changed', message: 'pack.toml changed outside the panel. Reload before saving.' });
    assert.equal(fs.existsSync(tomlPath), false);
  });
});

// T1 (above) is this refusal's positive control: the identical shape of request succeeds once
// pack.toml exists.

// --- T15 (gate pairs, real router): Origin and token --------------------------

test('T15: a vocab save with a foreign Origin gives 403 refused: origin; the admin Origin gives 200 (dryRun, no write)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    const cookie = `scriptorium_admin_${port}=${TOKEN}`;
    const hostHeader = `127.0.0.1:${port}`;
    const body = { labels: { chapter: 'Session' }, baseSha256, dryRun: true };

    const foreign = await raw(port, '/api/pack/vocab', {
      headers: { Host: hostHeader, Origin: 'http://evil.example', Cookie: cookie },
      body,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.raw.toString(), 'refused: origin');

    const admin = await raw(port, '/api/pack/vocab', {
      headers: { Host: hostHeader, Origin: `http://${hostHeader}`, Cookie: cookie },
      body,
    });
    assert.equal(admin.status, 200);
  });
});

test('T15: a vocab save with no cookie gives 403 refused: token; the cookie gives 200 (dryRun, no write)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));
    const hostHeader = `127.0.0.1:${port}`;
    const body = { labels: { chapter: 'Session' }, baseSha256, dryRun: true };

    const noCookie = await raw(port, '/api/pack/vocab', { headers: { Host: hostHeader, Origin: `http://${hostHeader}` }, body });
    assert.equal(noCookie.status, 403);
    assert.equal(noCookie.raw.toString(), 'refused: token');

    const withCookie = await raw(port, '/api/pack/vocab', {
      headers: { Host: hostHeader, Origin: `http://${hostHeader}`, Cookie: `scriptorium_admin_${port}=${TOKEN}` },
      body,
    });
    assert.equal(withCookie.status, 200);
  });
});

// --- T16: GET /api/state with and without ?include=vocab -------------------

test('T16: GET /api/state with no parameter has exactly S2\'s key set (no vocab key)', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state');
    assert.equal(res.status, 200);
    assert.deepEqual(
      Object.keys(res.json).sort(),
      ['campaign', 'siteSource', 'writable', 'readOnlyReason', 'previewPort', 'packToml', 'vaultConfigJson', 'themes', 'vaultConfigMd', 'images', 'preview'].sort(),
    );
  });
});

test('T16: ?include=vocab adds exactly one extra key, "vocab"', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const plain = await get(port, '/api/state');
    const withVocab = await get(port, '/api/state?include=vocab');
    assert.equal(withVocab.status, 200);
    const plainKeys = Object.keys(plain.json).sort();
    const vocabKeys = Object.keys(withVocab.json).sort();
    assert.deepEqual(vocabKeys, [...plainKeys, 'vocab'].sort());
    for (const k of plainKeys) assert.deepEqual(withVocab.json[k], plain.json[k]);
    assert.ok(Object.prototype.hasOwnProperty.call(withVocab.json, 'vocab'));
  });
});

test('T16: defaults.labels keys equal the independent 17-name literal list', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state?include=vocab');
    assert.deepEqual(Object.keys(res.json.vocab.defaults.labels).sort(), [...LABEL_NAMES].sort());
  });
});

test('T16: defaults.timeline.columns keys equal the independent 11-name literal list', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state?include=vocab');
    assert.deepEqual(Object.keys(res.json.vocab.defaults.timeline.columns).sort(), [...COLUMN_NAMES].sort());
  });
});

test('T16: defaults.timeline.session_token is \\bS(\\d+)\\b', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state?include=vocab');
    assert.equal(res.json.vocab.defaults.timeline.session_token, '\\bS(\\d+)\\b');
  });
});

test('T16: defaults.timeline.weights is ["aside","scene","turning point"]', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state?include=vocab');
    assert.deepEqual(res.json.vocab.defaults.timeline.weights, ['aside', 'scene', 'turning point']);
  });
});

test('T16: defaults.recaps.learned_heading is "what the party learned"', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state?include=vocab');
    assert.equal(res.json.vocab.defaults.recaps.learned_heading, 'what the party learned');
  });
});

test('T16 (M7 guard): with no ?include, /api/state does not have a "vocab" key at all', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath } = writeVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const res = await get(port, '/api/state');
    assert.equal(Object.prototype.hasOwnProperty.call(res.json, 'vocab'), false);
  });
});

// --- T17 (drift): TIMELINE_EDIT_KEYS matches the real product's [timeline] keys ---

test('T17 (drift): a candidate setting all five TIMELINE_EDIT_KEYS parses with no "[timeline] unrecognised key" warning', () => {
  const raw2 = 'theme = "plain"\n';
  const edits = vocabHandler.validateVocabEdits({
    timeline: {
      kinds: [{ key: 'fight', glyph: 'fight' }],
      weights: ['aside', 'scene', 'turning point'],
      session_token: '\\bS(\\d+)\\b',
      segment_units: '\\b(week|day)\\s+(\\d+)\\b',
      columns: { title: ['heading'] },
    },
  });
  const candidate = vocabHandler.editPackTomlVocab(raw2, edits);
  const result = parsePackToml(candidate, { tomlPath: '/scratch/pack.toml', campaign: 'x' });
  assert.ok(
    !result.warnings.some((w) => w.includes('[timeline] unrecognised key')),
    `unexpected warnings: ${JSON.stringify(result.warnings)}`,
  );
});

test('T17 (drift) positive control: a sixth, genuinely unrecognised [timeline] key on disk DOES produce the warning', () => {
  const raw2 = 'theme = "plain"\n\n[timeline]\nweights = ["a", "b", "c"]\nbogus_key = "z"\n';
  const result = parsePackToml(raw2, { tomlPath: '/scratch/pack.toml', campaign: 'x' });
  assert.ok(result.warnings.some((w) => w.includes('[timeline] unrecognised key "bogus_key"')));
});

test('T17 (drift): TIMELINE_EDIT_KEYS exported literal equals the independent 5-name list', () => {
  assert.deepEqual([...vocabHandler.TIMELINE_EDIT_KEYS].sort(), [...TIMELINE_KEYS].sort());
});

// --- M9 guard (Reviewer finding, admin-s4 26eef96): validateVocabEdits must return the
// validated `fields`, never the raw request body. None of the validators in this file
// normalises or transforms a value in the success path (SD-2 scopes this function to shape
// validation only -- every field either passes through the exact value it was given, or throws),
// so `fields` and `parsed` are value-identical on labels/timeline/recaps content whenever
// validation succeeds. The ONE thing that always differs is which top-level keys survive:
// `parsed` is the whole POST body (baseSha256, dryRun and all), `fields` is only the
// labels/timeline/recaps the caller actually provided. A mutation that returns `parsed` instead
// of `fields` is invisible to every file-content assertion above (TOML.stringify never looks at
// baseSha256/dryRun), so it needs its own direct check on validateVocabEdits's return shape.

test('M9 guard: validateVocabEdits never leaks baseSha256 or dryRun into its return value', () => {
  const parsedBody = {
    labels: { chapter: 'Session' },
    timeline: { weights: ['a', 'b', 'c'] },
    recaps: { learned_heading: 'Lessons' },
    baseSha256: 'a'.repeat(64),
    dryRun: true,
  };
  const fields = vocabHandler.validateVocabEdits(parsedBody);
  assert.deepEqual(Object.keys(fields).sort(), ['labels', 'recaps', 'timeline']);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, 'baseSha256'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, 'dryRun'), false);
});

test('M9 guard: a request naming only "labels" returns an object with exactly that one key, nothing else from the body', () => {
  const parsedBody = { labels: { chapter: 'Session' }, baseSha256: 'b'.repeat(64), dryRun: false };
  const fields = vocabHandler.validateVocabEdits(parsedBody);
  assert.deepEqual(Object.keys(fields), ['labels']);
  assert.deepEqual(fields.labels, { chapter: 'Session' });
});

// --- T18 (end to end): a saved label reaches the built site -----------------

test('T18 (end to end): after a connections_heading save, a build shows the new label under people/', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const configPath = writeConfigToml(root, vaultPath, 'vocab');
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const baseSha256 = sha256(fs.readFileSync(tomlPath));

    const res = await post(port, '/api/pack/vocab', { labels: { connections_heading: 'Bonds' }, baseSha256 });
    assert.equal(res.status, 200);

    const outDir = path.join(root, 'scratch-out');
    const cli = runCli(['build', 'vocab', '--config', configPath, '--out', outDir], { env: scratchEnv(root) });
    assert.equal(cli.status, 0, `build failed: ${cli.stderr}`);

    const peopleDir = path.join(outDir, 'people');
    assert.ok(fs.existsSync(peopleDir), 'people/ was not built');
    const files = fs.readdirSync(peopleDir).filter((f) => f.endsWith('.html'));
    assert.ok(files.length > 0, 'no html files under people/');
    const found = files.some((f) => fs.readFileSync(path.join(peopleDir, f), 'utf8').includes('Bonds'));
    assert.ok(found, 'no people/ page contains the new "Bonds" connections heading');
  });
});
