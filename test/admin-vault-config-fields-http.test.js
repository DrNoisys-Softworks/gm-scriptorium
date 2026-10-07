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
const backups = require('../src/config/backups');
const machinedir = require('../src/config/machinedir');
const vaultconfigwrite = require('../src/vault/vaultconfigwrite');
const vaultconfigcandidate = require('../src/admin/vaultconfigcandidate');
const read = require('../src/vault/read');

/*
 * V1e-10 (ADR 0033 second addendum, SD-110/SD-112). Real sockets, test/admin-vault-config-http.
 * test.js's launch()/launchAuthed() pattern (copied, not required -- house rule). Isolation:
 * every scratch env var is set to a per-file mkdtemp before any test runs; every launch also
 * passes an explicit --config under the test's own scratch root. A body marker ([[VcfBodyMarker]])
 * is planted in every scratch fixture's body and asserted absent from every response.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcf-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcf-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcf-sc-')), 'config.toml');

const BODY_MARKER = '[[VcfBodyMarker]]';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeScratchVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });

  const mdText = opts.vaultConfigMd !== undefined ? opts.vaultConfigMd : `---\ntype: meta\npublish:\n  mode: player\n---\n\nSee ${BODY_MARKER} below.\n`;
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), mdText);

  for (const [rel, text] of Object.entries(opts.pages || {})) {
    fs.mkdirSync(path.dirname(path.join(vaultPath, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, rel), text);
  }

  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify({ siteTitle: 'Lease Test', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'] }, null, 2) + '\n',
  );

  const configDir = opts.configDir || path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  const campaignKey = opts.campaignKey || 'lease';
  fs.writeFileSync(
    configPath,
    ['config_version = 1', `default_campaign = "${campaignKey}"`, '', `[campaigns.${campaignKey}]`, `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join(
      '\n',
    ),
  );
  return { vaultPath, packDir, configPath, configDir, campaignKey };
}

async function withScratchOpts(opts, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcf-'));
  try {
    return await fn(writeScratchVault(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withScratch(fn) {
  return withScratchOpts({}, fn);
}

function launch(t, configPath, campaign, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, campaign, {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed by the test's own shutdown()
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

function tokenFromLine(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
}

function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function launchAuthed(t, configPath, campaign, extraFlags = {}) {
  const s = await waitForHandles(launch(t, configPath, campaign, extraFlags));
  const adminPort = s.handles[0].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    adminPort,
    cookie: cookieHeader,
    get: (p) => request(adminPort, { path: p, headers: { Cookie: cookieHeader } }),
    post: (p, opts = {}) =>
      request(adminPort, {
        method: 'POST',
        path: p,
        headers: {
          Cookie: cookieHeader,
          Origin: `http://127.0.0.1:${adminPort}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body,
      }),
    shutdown: () => shutdown(s),
  };
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

function postJson(c, p, obj) {
  return c.post(p, { body: JSON.stringify(obj) });
}

/** Asserts the body marker appears 0 times anywhere in a response. */
function assertNoBodyMarker(res, label) {
  assert.doesNotMatch(res.body.toString('utf8'), /VcfBodyMarker/, label || 'body marker leaked');
}

// === Fixtures ====================================================================================

function fmFile(fm, body = `\nSee ${BODY_MARKER} below.\n`) {
  return `---\n${fm}\n---\n${body}`;
}

const RICH_FM = [
  'type: meta',
  'campaign: Invented Campaign',
  'publish:',
  '  mode: player',
  '  system: dnd5e',
  '  exclude_fields: ["constructor", "gm_zz", "secrets"]',
  '  exclude_sections: ["Aaa"]',
  '  theme:',
  '    tagline: "A tagline"',
  '    palette:',
  '      primary: "#112233"',
  '    genre: horror',
  '  landing:',
  '    featured_npcs: ["Orpiment", "Hesper"]',
  '    max_npcs: 6',
  '  four_oh_four:',
  '    message: "Lost"',
  '  extra_thing: 1',
].join('\n');

const RICH_PAGES = {
  'Notes/PageOne.md': '---\ntype: npc\nsecrets: a\ngm_zz: 1\n---\n\nOne.\n',
  'Notes/PageTwo.md': '---\ntype: npc\nsecrets: b\n---\n\nTwo.\n',
  'Notes/PageThree.md': '---\ntype: npc\nconstructor: 7\n---\n\nThree.\n',
  'Notes/PageFour.md': '---\ntype: npc\n---\n\nFour.\n',
};


async function stateOf(c) {
  return json(await c.get('/api/state?include=vaultconfigeditor')).vaultConfigEditor;
}

async function review(c, set, extra = {}) {
  const ed = await stateOf(c);
  const dry = await postJson(c, '/api/vault-config/fields', { set, baseSha256: ed.sha256, dryRun: true, ...extra });
  return { ed, dry };
}

// === GET /api/vault-config/fields ==================================================================

test('GET fields: documented shape; value, shape and form per path; unknown keys; usage counts (own keys only); missing defaults', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM), pages: RICH_PAGES }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const res = await c.get('/api/vault-config/fields');
    assert.equal(res.status, 200);
    assertNoBodyMarker(res);
    const body = json(res);
    assert.deepEqual(Object.keys(body), ['ok', 'sha256', 'fields', 'display', 'unknown', 'usage', 'missingDefaults']);
    assert.equal(body.ok, true);
    assert.equal(body.sha256, (await stateOf(c)).sha256);

    assert.deepEqual(
      body.fields.map((f) => [f.path, f.kind, f.group, f.label, f.value, f.shape, f.form]),
      [
        ['publish.exclude_fields', 'list', 'privacy', 'Hidden fields', ['constructor', 'gm_zz', 'secrets'], 'flow', null],
        ['publish.exclude_sections', 'list', 'privacy', 'Hidden headings', ['Aaa'], 'flow', null],
        ['publish.exclude_dirs', 'list', 'privacy', 'Hidden folders', null, 'absent', null],
        ['publish.landing.featured_npcs', 'list', 'safe', 'Featured characters', ['Orpiment', 'Hesper'], 'flow', null],
        ['publish.landing.quick_links', 'list', 'safe', 'Quick links', null, 'absent', null],
        ['publish.landing.max_npcs', 'int', 'safe', 'How many characters to show', 6, 'scalar', null],
        ['publish.four_oh_four.message', 'string', 'safe', 'Not-found message', 'Lost', 'scalar', null],
      ],
    );
    assert.deepEqual(
      body.display.map((d) => [d.path, d.group, d.label, d.value]),
      [
        ['publish.mode', 'privacy', 'Publish mode', 'player'],
        ['publish.theme.palette', 'look', 'Colours', { primary: '#112233' }],
        ['publish.theme.fonts', 'look', 'Fonts', null],
        ['publish.theme.campaign_image', 'look', 'Cover art', null],
        ['publish.theme.genre', 'look', 'Genre preset', 'horror'],
        ['publish.banners', 'look', 'Section banners', null],
      ],
    );
    assert.deepEqual(body.unknown, ['type', 'campaign', 'publish.system', 'publish.extra_thing', 'publish.theme.tagline']);
    // Hand-counted from RICH_PAGES: secrets on 2 pages, gm_zz on 1, constructor as an OWN key on 1
    // (an inherited-property count would give 4, every page).
    assert.deepEqual(body.usage, {
      constructor: 1,
      gm_zz: 1,
      secrets: 2,
      current_plan: 0,
      plan_progress: 0,
      gm_notes: 0,
      prep_notes: 0,
      reliability: 0,
    });
    assert.deepEqual(body.missingDefaults, {
      exclude_fields: ['current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability'],
      exclude_sections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile'],
    });
    await c.shutdown();
  });
});

test('GET fields: a file with no exclude lists reports no missing defaults, and a refusal form per path', async (t) => {
  const fm = 'type: meta\npublish:\n  mode: player\n  landing: {max_npcs: 3}\n  four_oh_four:\n    message: |\n      hi';
  await withScratchOpts({ vaultConfigMd: fmFile(fm) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const body = json(await c.get('/api/vault-config/fields'));
    assert.deepEqual(body.missingDefaults, { exclude_fields: [], exclude_sections: [] });
    const byPath = Object.fromEntries(body.fields.map((f) => [f.path, f]));
    assert.equal(byPath['publish.landing.max_npcs'].shape, null);
    assert.equal(byPath['publish.landing.max_npcs'].form, 'a flow mapping');
    assert.equal(byPath['publish.four_oh_four.message'].form, 'a block scalar');
    assert.equal(byPath['publish.exclude_fields'].shape, 'absent');
    await c.shutdown();
  });
});

test('GET fields: an unreadable frontmatter gives 422 unsupported, never a crash', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile('type: meta\npublish: [unclosed') }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const res = await c.get('/api/vault-config/fields');
    assert.equal(res.status, 422);
    assert.equal(json(res).error, 'unsupported');
    assertNoBodyMarker(res);
    await c.shutdown();
  });
});

// === POST: dry run then confirm ====================================================================

test('POST fields: removing a privacy entry needs the tick (422 then 200); only that line changes; the body is byte-identical; the backup is the pre-save file', async (t) => {
  const original = fmFile(RICH_FM);
  await withScratchOpts({ vaultConfigMd: original, pages: RICH_PAGES }, async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const { ed, dry } = await review(c, { 'publish.exclude_fields': ['constructor', 'secrets'] });
    assert.equal(dry.status, 200);
    assertNoBodyMarker(dry);
    const dryBody = json(dry);
    assert.equal(dryBody.op, 'fields');
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.needsAck, true);
    assert.ok(dryBody.reasons.includes('privacy'));
    assert.ok(dryBody.effects.some((e) => e.level === 'bad'));
    assert.equal(dryBody.before.includes('exclude_fields: ["constructor", "gm_zz", "secrets"]'), true);
    assert.equal(dryBody.after.includes('exclude_fields: ["constructor", "secrets"]'), true);
    assert.equal(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8'), original, 'a dry run writes nothing');

    const confirmBody = { set: { 'publish.exclude_fields': ['constructor', 'secrets'] }, baseSha256: ed.sha256, dryRun: false, reviewedSha256: dryBody.candidateSha256 };
    const noTick = await postJson(c, '/api/vault-config/fields', confirmBody);
    assert.equal(noTick.status, 422);
    assert.equal(json(noTick).error, 'needs-ack');
    assert.equal(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8'), original);

    const ok = await postJson(c, '/api/vault-config/fields', { ...confirmBody, saveAnyway: true });
    assert.equal(ok.status, 200);
    const okBody = json(ok);
    assertNoBodyMarker(ok);
    const onDisk = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8');
    assert.equal(onDisk, original.replace('["constructor", "gm_zz", "secrets"]', '["constructor", "secrets"]'));
    assert.deepEqual(fs.readFileSync(okBody.backupPath), Buffer.from(original, 'utf8'));
    assert.equal(sha256(Buffer.from(onDisk)), okBody.sha256);
    await c.shutdown();
  });
});

test('POST fields: a max_npcs save changes only that one line (byte diff)', async (t) => {
  const original = fmFile(RICH_FM);
  await withScratchOpts({ vaultConfigMd: original }, async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const { ed, dry } = await review(c, { 'publish.landing.max_npcs': 12 });
    const dryBody = json(dry);
    assert.equal(dry.status, 200);
    assert.equal(dryBody.needsAck, false, 'a safe field change needs no tick');
    const ok = await postJson(c, '/api/vault-config/fields', {
      set: { 'publish.landing.max_npcs': 12 },
      baseSha256: ed.sha256,
      dryRun: false,
      reviewedSha256: dryBody.candidateSha256,
    });
    assert.equal(ok.status, 200);
    const after = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8');
    const a = original.split('\n');
    const b = after.split('\n');
    assert.equal(a.length, b.length);
    const differing = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    assert.deepEqual(differing, [['    max_npcs: 6', '    max_npcs: 12']]);
    await c.shutdown();
  });
});

test('POST fields: a notes entry names a lost comment and the response never carries the body', async (t) => {
  const fm = 'type: meta\npublish:\n  landing:\n    max_npcs: 6 # six';
  await withScratchOpts({ vaultConfigMd: fmFile(fm) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const { dry } = await review(c, { 'publish.landing.max_npcs': 7 });
    const body = json(dry);
    assert.ok(body.notes.includes('A comment on the How many characters to show line is removed.'), JSON.stringify(body.notes));
    assertNoBodyMarker(dry);
    await c.shutdown();
  });
});

test('POST fields: an unchanged value gives 200 unchanged and no backup', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const ed = await stateOf(c);
    const res = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 6 }, baseSha256: ed.sha256, dryRun: false, reviewedSha256: '0'.repeat(64) });
    assert.equal(res.status, 200);
    assert.equal(json(res).unchanged, true);
    assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'backups')), false);
    await c.shutdown();
  });
});

test('POST fields: a reviewedSha256 that is not the dry run\'s gives 409, and a stale baseSha256 gives 409', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const ed = await stateOf(c);
    const wrongReview = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 9 }, baseSha256: ed.sha256, dryRun: false, reviewedSha256: '0'.repeat(64) });
    assert.equal(wrongReview.status, 409);
    const stale = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 9 }, baseSha256: '0'.repeat(64), dryRun: true });
    assert.equal(stale.status, 409);
    await c.shutdown();
  });
});

// === 400s ==========================================================================================

test('POST fields: only the seven exact paths are accepted (mode, a longer sibling, a longer leaf, __proto__ all give 400)', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const ed = await stateOf(c);
    const before = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'));
    for (const key of ['publish.mode', 'publish.exclude_fieldsx', 'publish.landing.max_npcs_extra', 'publish', 'publish.theme.tagline', 'exclude_fields', 'publish.exclude_fields.', '__proto__']) {
      const body = `{"set":{${JSON.stringify(key)}:["a"]},"baseSha256":"${ed.sha256}","dryRun":true}`;
      const res = await c.post('/api/vault-config/fields', { body });
      assert.equal(res.status, 400, key);
      assert.deepEqual(json(res), { error: 'invalid', message: `unknown setting: ${key}` }, key);
    }
    assert.deepEqual(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md')), before);
    await c.shutdown();
  });
});

test('POST fields: set must be a plain object of 1 or more keys; a wrong type, range or duplicate gives 400 with the label', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const ed = await stateOf(c);
    const post = (set) => postJson(c, '/api/vault-config/fields', { set, baseSha256: ed.sha256, dryRun: true });
    for (const bad of [undefined, null, [], 'x', 3, {}]) {
      const res = await post(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(json(res).error, 'invalid');
    }
    const cases = [
      [{ 'publish.landing.max_npcs': '9' }, /^How many characters to show: /],
      [{ 'publish.landing.max_npcs': 101 }, /^How many characters to show: /],
      [{ 'publish.landing.max_npcs': 1.5 }, /^How many characters to show: /],
      [{ 'publish.exclude_fields': 'secrets' }, /^Hidden fields: /],
      [{ 'publish.exclude_fields': ['a', 'a'] }, /^Hidden fields: /],
      [{ 'publish.exclude_dirs': [' pad'] }, /^Hidden folders: /],
      [{ 'publish.exclude_sections': ['bad\nline'] }, /^Hidden headings: /],
      [{ 'publish.four_oh_four.message': '' }, /^Not-found message: /],
      [{ 'publish.four_oh_four.message': 'x'.repeat(301) }, /^Not-found message: /],
      [{ 'publish.four_oh_four.message': 5 }, /^Not-found message: /],
    ];
    for (const [set, re] of cases) {
      const res = await post(set);
      assert.equal(res.status, 400, JSON.stringify(set));
      assert.match(json(res).message, re, JSON.stringify(set));
    }
    await c.shutdown();
  });
});

test('POST fields: an unknown top-level body key gives 400, and a missing baseSha256 gives 400', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const ed = await stateOf(c);
    const extra = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 }, baseSha256: ed.sha256, dryRun: true, frontmatterText: 'x' });
    assert.equal(extra.status, 400);
    const noBase = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 }, dryRun: true });
    assert.equal(noBase.status, 400);
    await c.shutdown();
  });
});

// === 422 ===========================================================================================

test('POST fields: a setting written in a form the panel cannot change safely gives 422 with the label message, and nothing is written', async (t) => {
  const fm = 'type: meta\npublish:\n  landing: {max_npcs: 3}';
  const original = fmFile(fm);
  await withScratchOpts({ vaultConfigMd: original }, async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const { dry } = await review(c, { 'publish.landing.max_npcs': 4 });
    assert.equal(dry.status, 422);
    assert.deepEqual(json(dry), {
      error: 'unsupported',
      message: 'How many characters to show is written in a form the panel can\'t change safely (a flow mapping). Use "Edit as text instead".',
    });
    assert.equal(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), 'utf8'), original);
    await c.shutdown();
  });
});

// === 403 and siblings ==============================================================================

async function withReadOnly(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vcf-ro-'));
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(root, 'elsewhere-pack');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), fmFile('type: meta\npublish:\n  mode: player'));
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ excludeDirs: [], folderMap: {} }) + '\n');
    const configDir = path.join(root, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "ro"', '', '[campaigns.ro]', `vault = '${vaultPath}'`, `pack = '${packDir}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    const c = await launchAuthed(t, configPath, 'ro');
    await fn(c);
    await c.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a read-only campaign gives 403 on GET and POST fields', async (t) => {
  await withReadOnly(t, async (c) => {
    const get = await c.get('/api/vault-config/fields');
    assert.equal(get.status, 403);
    assert.equal(json(get).error, 'read-only');
    const post = await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 }, baseSha256: '0'.repeat(64), dryRun: true });
    assert.equal(post.status, 403);
    assert.equal(json(post).error, 'read-only');
  });
});

test('route siblings fieldsx give 404 on GET and POST, and an unlisted method on fields gives 404', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM) }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    assert.equal((await c.get('/api/vault-config/fieldsx')).status, 404);
    assert.equal((await c.post('/api/vault-config/fieldsx', { body: '{}' })).status, 404);
    assert.equal((await c.get('/api/vault-config/field')).status, 404);
    await c.shutdown();
  });
});

// === console silence ===============================================================================

test('console silence: no console output during GET fields and a full dry-run + confirm cycle', async (t) => {
  await withScratchOpts({ vaultConfigMd: fmFile(RICH_FM), pages: RICH_PAGES }, async ({ configPath, campaignKey }) => {
    const calls = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => calls.push(['log', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    try {
      const c = await launchAuthed(t, configPath, campaignKey);
      await c.get('/api/vault-config/fields');
      const { ed, dry } = await review(c, { 'publish.landing.max_npcs': 3 });
      const dryBody = json(dry);
      await postJson(c, '/api/vault-config/fields', { set: { 'publish.landing.max_npcs': 3 }, baseSha256: ed.sha256, dryRun: false, reviewedSha256: dryBody.candidateSha256 });
      await c.shutdown();
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
    assert.deepEqual(calls, []);
  });
});
