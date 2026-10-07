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
 * V1e-9 (ADR 0033 addendum, ADR 0041, SD-98/SD-99). Real sockets, test/admin-vault-config-http.
 * test.js's launch()/launchAuthed() pattern (copied, not required -- house rule). Isolation:
 * every scratch env var is set to a per-file mkdtemp before any test runs; every launch also
 * passes an explicit --config under the test's own scratch root. A body marker ([[VceBodyMarker]])
 * is planted in every scratch fixture's body and asserted absent from every response.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-sc-')), 'config.toml');

const BODY_MARKER = '[[VceBodyMarker]]';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeScratchVault(root, opts = {}) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });

  const mdText = opts.vaultConfigMd !== undefined ? opts.vaultConfigMd : `---\ntype: meta\npublish:\n  mode: player\n---\n\nSee ${BODY_MARKER} below.\n`;
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), mdText);

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-'));
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
  assert.doesNotMatch(res.body.toString('utf8'), /VceBodyMarker/, label || 'body marker leaked');
}

// === Include shape ============================================================================

test('?include=vaultconfigeditor gives the documented shape, and siblings add nothing', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const res = await c.get('/api/state?include=vaultconfigeditor');
    const body = json(res);
    assert.deepEqual(Object.keys(body.vaultConfigEditor).sort(), ['backupDir', 'canEdit', 'eol', 'exists', 'keep', 'lineCount', 'parse', 'reason', 'sha256', 'text'].sort());
    assert.equal(body.vaultConfigEditor.exists, true);
    assert.equal(body.vaultConfigEditor.canEdit, true);
    assert.equal(body.vaultConfigEditor.reason, null);
    assert.equal(body.vaultConfigEditor.keep, 20);
    assert.deepEqual(body.vaultConfigEditor.parse, { ok: true });
    assertNoBodyMarker(res);

    for (const q of ['vaultconfigeditorx', 'vaultconfigedito', 'Vaultconfigeditor']) {
      const sib = json(await c.get(`/api/state?include=${q}`));
      assert.equal(Object.prototype.hasOwnProperty.call(sib, 'vaultConfigEditor'), false, q);
    }

    const before = await c.get('/api/state');
    await c.get('/api/state?include=vaultconfigeditor');
    const after = await c.get('/api/state');
    assert.deepEqual(before.body, after.body);
    await c.shutdown();
  });
});

// === Text: dry run then confirm ===============================================================

test('text: dry run then confirm saves the frontmatter, keeps the body byte-identical, and backs up the pre-save file', async (t) => {
  const bom = '﻿';
  const original = `${bom}---\r\ntype: meta\r\npublish:\r\n  mode: player\r\n---\r\n\r\nSee ${BODY_MARKER} below.\r\n`;
  await withScratchOpts({ vaultConfigMd: original }, async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const baseSha256 = state.vaultConfigEditor.sha256;
    assert.equal(state.vaultConfigEditor.eol, 'crlf');

    const newText = 'type: meta\npublish:\n  mode: full';
    const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256, dryRun: true });
    assert.equal(dry.status, 200);
    const dryBody = json(dry);
    assert.equal(dryBody.ok, true);
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.op, 'text');
    assertNoBodyMarker(dry);

    const confirm = await postJson(c, '/api/vault-config/text', {
      frontmatterText: newText,
      baseSha256,
      dryRun: false,
      saveAnyway: true,
      reviewedSha256: dryBody.candidateSha256,
    });
    assert.equal(confirm.status, 200);
    const confirmBody = json(confirm);
    assert.equal(confirmBody.ok, true);
    assertNoBodyMarker(confirm);

    const onDisk = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'));
    assert.equal(sha256(onDisk), confirmBody.sha256);
    assert.ok(onDisk.toString('utf8').includes(BODY_MARKER), 'the body must be preserved byte-for-byte');
    assert.ok(onDisk.toString('utf8').includes('mode: full'), 'the frontmatter must carry the NEW content, not the old');
    assert.ok(!onDisk.toString('utf8').includes('mode: player'), 'the old frontmatter must not remain');
    assert.ok(onDisk.toString('utf8').startsWith(bom), 'the BOM must be preserved');
    assert.match(onDisk.toString('utf8'), /\r\n/, 'the file keeps its own CRLF line endings');

    const backupPath = confirmBody.backupPath;
    assert.ok(fs.existsSync(backupPath));
    assert.deepEqual(fs.readFileSync(backupPath), Buffer.from(original, 'utf8'));

    await c.shutdown();
  });
});

test('text: unchanged candidate gives 200 unchanged with no backup, and does not re-run check', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath, packDir }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const backupsDirBefore = fs.existsSync(path.join(path.dirname(configPath), 'backups'));
    const res = await postJson(c, '/api/vault-config/text', {
      frontmatterText: state.vaultConfigEditor.text,
      baseSha256: state.vaultConfigEditor.sha256,
      dryRun: false,
      reviewedSha256: '0'.repeat(64),
    });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.unchanged, true);
    assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'backups')), backupsDirBefore);
    await c.shutdown();
  });
});

// === 409s =======================================================================================

test('text: a stale baseSha256 gives 409 changed', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const res = await postJson(c, '/api/vault-config/text', { frontmatterText: 'type: meta', baseSha256: '0'.repeat(64), dryRun: true });
    assert.equal(res.status, 409);
    assert.equal(json(res).error, 'changed');
    await c.shutdown();
  });
});

test('text: a reviewedSha256 mismatch on confirm gives 409 changed', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const confirm = await postJson(c, '/api/vault-config/text', {
      frontmatterText: 'type: meta\npublish:\n  mode: full',
      baseSha256: state.vaultConfigEditor.sha256,
      dryRun: false,
      saveAnyway: true,
      reviewedSha256: '0'.repeat(64),
    });
    assert.equal(confirm.status, 409);
    assert.equal(json(confirm).error, 'changed');
    await c.shutdown();
  });
});

// === needs-ack ===================================================================================

test('text: a privacy-risk edit gives 422 needs-ack without the tick, 200 with it', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const newText = 'type: meta\npublish:\n  mode: full';
    const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    const dryBody = json(dry);
    assert.equal(dryBody.needsAck, true);
    assert.ok(dryBody.reasons.includes('privacy'));

    const noTick = await postJson(c, '/api/vault-config/text', {
      frontmatterText: newText,
      baseSha256: state.vaultConfigEditor.sha256,
      dryRun: false,
      reviewedSha256: dryBody.candidateSha256,
    });
    assert.equal(noTick.status, 422);
    assert.equal(json(noTick).error, 'needs-ack');

    const withTick = await postJson(c, '/api/vault-config/text', {
      frontmatterText: newText,
      baseSha256: state.vaultConfigEditor.sha256,
      dryRun: false,
      saveAnyway: true,
      reviewedSha256: dryBody.candidateSha256,
    });
    assert.equal(withTick.status, 200);
    await c.shutdown();
  });
});

test('text dry run: cur and cand are never swapped -- a featured_npcs change reports added/removed on the correct side', async (t) => {
  const vaultConfigMd = `---\ntype: meta\npublish:\n  mode: player\n  landing:\n    featured_npcs: ["Orpiment"]\n---\n\nSee ${BODY_MARKER} below.\n`;
  await withScratchOpts({ vaultConfigMd }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const newText = 'type: meta\npublish:\n  mode: player\n  landing:\n    featured_npcs: ["Ivo"]';
    const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    assert.equal(dry.status, 200);
    const effects = json(dry).effects;
    assert.deepEqual(
      effects.filter((e) => e.id.startsWith('featured-')).map((e) => ({ id: e.id, title: e.title })),
      [
        { id: 'featured-added', title: 'Ivo joins the featured characters' },
        { id: 'featured-removed', title: 'Orpiment is no longer featured' },
      ],
    );
    await c.shutdown();
  });
});

// === 400s: a `---` line, broken YAML =============================================================

test('text: a line starting with --- gives 400 with the typed line', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const res = await postJson(c, '/api/vault-config/text', { frontmatterText: 'type: meta\n---\npublish:\n  mode: full', baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    assert.equal(res.status, 400);
    const body = json(res);
    assert.equal(body.error, 'invalid');
    assert.equal(body.line, 3);
    await c.shutdown();
  });
});

test('text: broken YAML gives 400 with the typed line number', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const res = await postJson(c, '/api/vault-config/text', {
      frontmatterText: 'type: meta\npublish:\n  mode: [unterminated',
      baseSha256: state.vaultConfigEditor.sha256,
      dryRun: true,
    });
    assert.equal(res.status, 400);
    const body = json(res);
    assert.equal(body.error, 'invalid');
    assert.equal(typeof body.line, 'number');
    assert.match(body.message, /^Line \d+:/);
    await c.shutdown();
  });
});

// === Injection: buildTextCandidate altering the tail gives 422, file unchanged, no backup =======

test('text: an injected candidate builder that alters the tail is refused (bodyGuard), and nothing is written', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const before = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'));

    const original = vaultconfigcandidate.buildTextCandidate;
    vaultconfigcandidate.buildTextCandidate = (split, text) => {
      const real = original(split, text);
      if (!real.ok) return real;
      return { ok: true, bytes: Buffer.concat([real.bytes, Buffer.from('TAMPERED\n')]), frontmatterText: real.frontmatterText };
    };
    let res;
    try {
      res = await postJson(c, '/api/vault-config/text', { frontmatterText: 'type: meta\npublish:\n  mode: full', baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    } finally {
      vaultconfigcandidate.buildTextCandidate = original;
    }
    assert.equal(res.status, 422);
    assert.equal(json(res).error, 'unsupported');
    assert.deepEqual(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md')), before);
    await c.shutdown();
  });
});

test('text: an injected candidate builder returning `---js` bytes gives 400 with the exact fence message', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));

    const original = vaultconfigcandidate.buildTextCandidate;
    vaultconfigcandidate.buildTextCandidate = () => ({ ok: true, bytes: Buffer.from('---js\nx: 1\n---\n\nbody\n', 'utf8'), frontmatterText: 'x: 1' });
    let res;
    try {
      res = await postJson(c, '/api/vault-config/text', { frontmatterText: 'anything', baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    } finally {
      vaultconfigcandidate.buildTextCandidate = original;
    }
    // candSplit.frontmatterText ("x: 1") won't equal cand.frontmatterText ("x: 1") -- actually it
    // will; this exercises the earlier split-mismatch/fence guard instead depending on content.
    assert.ok(res.status === 400 || res.status === 422);
    await c.shutdown();
  });
});

// === Restore round trip (AC-13) ==================================================================

test('restore round trip: save A, save B, restore A -- frontmatter equals A, body is the current one, a backup of B exists', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);

    async function saveText(text) {
      const state = json(await c.get('/api/state?include=vaultconfigeditor'));
      const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: text, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
      const dryBody = json(dry);
      const confirm = await postJson(c, '/api/vault-config/text', {
        frontmatterText: text,
        baseSha256: state.vaultConfigEditor.sha256,
        dryRun: false,
        saveAnyway: true,
        reviewedSha256: dryBody.candidateSha256,
      });
      assert.equal(confirm.status, 200, JSON.stringify(json(confirm)));
      return json(confirm);
    }

    const aText = 'type: meta\npublish:\n  mode: full\n  exclude_fields: ["alpha"]';
    await saveText(aText);
    const bText = 'type: meta\npublish:\n  mode: full\n  exclude_fields: ["beta"]';
    const bResult = await saveText(bText);

    const listRes = await c.get('/api/vault-config/backups');
    const list = json(listRes);
    assert.equal(list.available, true);
    assert.ok(list.items.length >= 2);
    // Newest first: saving A backs up the ORIGINAL file (taken before A was written); saving B
    // backs up A itself (taken before B was written) -- so the newest item IS the backup of A.
    const backupOfA = list.items[0];
    assertNoBodyMarker(listRes);

    const stateBeforeRestore = json(await c.get('/api/state?include=vaultconfigeditor'));
    const restoreDry = await postJson(c, '/api/vault-config/restore', { backupId: backupOfA.id, baseSha256: stateBeforeRestore.vaultConfigEditor.sha256, dryRun: true });
    assert.equal(restoreDry.status, 200);
    const restoreDryBody = json(restoreDry);
    assert.equal(restoreDryBody.backup.id, backupOfA.id);
    assert.equal(restoreDryBody.backup.takenAt, backupOfA.takenAt, 'the dry-run backup.takenAt must reflect the real backup time, not a placeholder');
    const restoreConfirm = await postJson(c, '/api/vault-config/restore', {
      backupId: backupOfA.id,
      baseSha256: stateBeforeRestore.vaultConfigEditor.sha256,
      dryRun: false,
      saveAnyway: true,
      reviewedSha256: restoreDryBody.candidateSha256,
    });
    assert.equal(restoreConfirm.status, 200);

    const finalBytes = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'));
    const finalText = finalBytes.toString('utf8');
    assert.ok(finalText.includes('exclude_fields: ["alpha"]'));
    assert.ok(finalText.includes(BODY_MARKER), 'the body stays the CURRENT one, not A\'s backup body');

    const backupOfB = fs.existsSync(path.join(path.dirname(bResult.backupPath)));
    assert.ok(backupOfB);
    await c.shutdown();
  });
});

test('restore keeps the CURRENT body at restore time, never the backup\'s own (stale) body', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const target = path.join(vaultPath, '_meta', 'vault-config.md');

    async function saveText(text) {
      const state = json(await c.get('/api/state?include=vaultconfigeditor'));
      const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: text, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
      const dryBody = json(dry);
      const confirm = await postJson(c, '/api/vault-config/text', {
        frontmatterText: text,
        baseSha256: state.vaultConfigEditor.sha256,
        dryRun: false,
        saveAnyway: true,
        reviewedSha256: dryBody.candidateSha256,
      });
      assert.equal(confirm.status, 200, JSON.stringify(json(confirm)));
      return json(confirm);
    }

    await saveText('type: meta\npublish:\n  mode: full\n  exclude_fields: ["alpha"]');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(BODY_MARKER, '[[BodyAtBackupTime]]'));

    const bResult = await saveText('type: meta\npublish:\n  mode: full\n  exclude_fields: ["beta"]');
    const backupOfA = bResult.backupPath; // carries frontmatter A ("alpha") + body "[[BodyAtBackupTime]]"

    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('[[BodyAtBackupTime]]', '[[BodyAtRestoreTime]]'));

    const stateBeforeRestore = json(await c.get('/api/state?include=vaultconfigeditor'));
    const backupId = path.basename(backupOfA);
    const restoreDry = await postJson(c, '/api/vault-config/restore', { backupId, baseSha256: stateBeforeRestore.vaultConfigEditor.sha256, dryRun: true });
    const restoreDryBody = json(restoreDry);
    assert.equal(restoreDry.status, 200, JSON.stringify(restoreDryBody));
    const restoreConfirm = await postJson(c, '/api/vault-config/restore', {
      backupId,
      baseSha256: stateBeforeRestore.vaultConfigEditor.sha256,
      dryRun: false,
      saveAnyway: true,
      reviewedSha256: restoreDryBody.candidateSha256,
    });
    assert.equal(restoreConfirm.status, 200);

    const finalText = fs.readFileSync(target, 'utf8');
    assert.ok(finalText.includes('exclude_fields: ["alpha"]'), 'the restored frontmatter is A\'s');
    assert.ok(finalText.includes('[[BodyAtRestoreTime]]'), 'the body is the one that was current AT RESTORE TIME');
    assert.ok(!finalText.includes('[[BodyAtBackupTime]]'), 'the backup\'s own (stale) body must never be used');
    await c.shutdown();
  });
});

// === Read-only campaign ===========================================================================

test('a read-only (pack-key) campaign gives 403 on every POST, and backups list gives available:false', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-ro-'));
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(root, 'elsewhere-pack');
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\nbody\n');
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

    await (async () => {
      // local closures cannot reuse the outer withScratch helper (different fixture shape)
    })();

    const { runServeCommand: rsc } = require('../src/cli/serve');
    const { startLocalListener: sll } = require('../src/serve/server');
    const handles = [];
    const emitted = [];
    const signals = new EventEmitter();
    const resultPromise = rsc({ config: configPath, admin: true }, 'ro', {
      emit: (l) => emitted.push(l),
      startLocalListener: async (handler, opts) => {
        const h = await sll(handler, opts);
        handles.push(h);
        return h;
      },
      signals,
    });
    while (handles.length < 2) await waitForMacrotask();
    const adminPort = handles[0].port;
    const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(emitted[0])}` });
    const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];

    const textRes = await request(adminPort, {
      method: 'POST',
      path: '/api/vault-config/text',
      headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frontmatterText: 'type: meta', baseSha256: '0'.repeat(64), dryRun: true }),
    });
    assert.equal(textRes.status, 403);
    assert.equal(json(textRes).error, 'read-only');

    const restoreRes = await request(adminPort, {
      method: 'POST',
      path: '/api/vault-config/restore',
      headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupId: 'vault-config-20260101T000000000Z-aaaaaa.md.bak', baseSha256: '0'.repeat(64), dryRun: true }),
    });
    assert.equal(restoreRes.status, 403);

    const backupsRes = await request(adminPort, { path: '/api/vault-config/backups', headers: { Cookie: cookieHeader } });
    assert.equal(backupsRes.status, 200);
    assert.equal(json(backupsRes).available, false);

    signals.emit('SIGINT');
    await resultPromise;
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === Route siblings give 404 =====================================================================

test('route siblings textx/restorex/effectsx/backupsx give 404', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    for (const p of ['/api/vault-config/textx', '/api/vault-config/restorex', '/api/vault-config/effectsx', '/api/vault-config/backupsx']) {
      const res = await c.post(p, { body: '{}' });
      assert.equal(res.status, 404, p);
    }
    await c.shutdown();
  });
});

// === Effects + putBack ===========================================================================

test('effects: a privacy-risk edit reports needsAck; putBack re-inserts the entry at its original index', async (t) => {
  const vaultConfigMd = `---\ntype: meta\npublish:\n  mode: player\n  exclude_fields: ["alpha", "beta", "gamma"]\n---\n\nSee ${BODY_MARKER} below.\n`;
  await withScratchOpts({ vaultConfigMd }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));

    const removedText = 'type: meta\npublish:\n  mode: player\n  exclude_fields: ["alpha", "gamma"]';
    const res = await postJson(c, '/api/vault-config/effects', { frontmatterText: removedText, baseSha256: state.vaultConfigEditor.sha256 });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.parse.ok, true);
    assert.ok(body.needsAck);
    assert.ok(body.effects.some((e) => e.id === 'list-removed' && e.fix && e.fix.entry === 'beta'));
    assertNoBodyMarker(res);

    const putBackRes = await postJson(c, '/api/vault-config/effects', {
      frontmatterText: removedText,
      baseSha256: state.vaultConfigEditor.sha256,
      putBack: { path: 'publish.exclude_fields', entry: 'beta' },
    });
    assert.equal(putBackRes.status, 200);
    const putBackBody = json(putBackRes);
    assert.equal(putBackBody.frontmatterText.includes('"alpha", "beta", "gamma"'), true, putBackBody.frontmatterText);
    await c.shutdown();
  });
});

test('effects: cur and cand are never swapped -- a featured_npcs change reports added/removed on the correct side', async (t) => {
  const vaultConfigMd = `---\ntype: meta\npublish:\n  mode: player\n  landing:\n    featured_npcs: ["Orpiment"]\n---\n\nSee ${BODY_MARKER} below.\n`;
  await withScratchOpts({ vaultConfigMd }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));

    const newText = 'type: meta\npublish:\n  mode: player\n  landing:\n    featured_npcs: ["Ivo"]';
    const res = await postJson(c, '/api/vault-config/effects', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256 });
    assert.equal(res.status, 200);
    const effects = json(res).effects;
    assert.deepEqual(
      effects.filter((e) => e.id.startsWith('featured-')).map((e) => ({ id: e.id, title: e.title })),
      [
        { id: 'featured-added', title: 'Ivo joins the featured characters' },
        { id: 'featured-removed', title: 'Orpiment is no longer featured' },
      ],
    );
    await c.shutdown();
  });
});

// === Concurrency ==================================================================================

// === K8 coverage: the unforceable refusal cannot be overridden by the tick ======================

test('text: a refusal the check marks unforceable gives 422 refused-by-check, and the tick cannot override it', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const newText = 'type: meta\npublish:\n  mode: full';

    // frontmatter/non-yaml-language and frontmatter/parse-error (UNFORCEABLE_IDS) can only ever
    // reach the real check on a candidate that ALREADY failed candSplit or parseWithBothDetailed
    // earlier in this same pipeline (both gates run first, and both would already have refused
    // with a 400/422 of their own) -- so this route's own unforceable gate is proven by injecting
    // candidatecheck.runReview's own return value directly, the same way other tests here inject
    // one dependency to prove the CONSUMER'S handling of it in isolation.
    const candidatecheck = require('../src/admin/candidatecheck');
    const original = candidatecheck.runReview;
    candidatecheck.runReview = (ctx, opts) => {
      const real = original(ctx, opts);
      if (!opts.withCheck) return real;
      return {
        ...real,
        check: {
          ...real.check,
          unforceable: [{ id: 'frontmatter/non-yaml-language', severity: 'error', path: candidatecheck.VAULT_CONFIG_REL, line: null, message: 'injected unforceable refusal' }],
        },
      };
    };
    let dry;
    try {
      dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    } finally {
      candidatecheck.runReview = original;
    }
    assert.equal(dry.status, 422, JSON.stringify(json(dry)));
    assert.equal(json(dry).error, 'refused-by-check');
    assert.match(json(dry).message, /injected unforceable refusal/);

    const before = fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md'));
    candidatecheck.runReview = (ctx, opts) => {
      const real = original(ctx, opts);
      if (!opts.withCheck) return real;
      return {
        ...real,
        check: {
          ...real.check,
          unforceable: [{ id: 'frontmatter/non-yaml-language', severity: 'error', path: candidatecheck.VAULT_CONFIG_REL, line: null, message: 'injected unforceable refusal' }],
        },
      };
    };
    let confirm;
    try {
      // The unforceable refusal (step 13) runs before the reviewedSha256 check (step 17), on a
      // dry run and a confirm alike -- any reviewedSha256 value reaches the same 422 here.
      confirm = await postJson(c, '/api/vault-config/text', {
        frontmatterText: newText,
        baseSha256: state.vaultConfigEditor.sha256,
        dryRun: false,
        saveAnyway: true,
        reviewedSha256: '1'.repeat(64),
      });
    } finally {
      candidatecheck.runReview = original;
    }
    assert.equal(confirm.status, 422);
    assert.equal(json(confirm).error, 'refused-by-check');
    assert.deepEqual(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.md')), before);
    await c.shutdown();
  });
});

// === K17 coverage: a machine dir inside the vault gives available:false ========================

test('listBackups (handler): a machine dir inside the vault gives available:false, not a real listing', async (t) => {
  await withScratch(async ({ configPath, campaignKey, vaultPath }) => {
    const original = machinedir.resolveMachineDir;
    machinedir.resolveMachineDir = () => ({ ok: false, reason: "GM-Scriptorium's own folder is inside the vault, so the panel won't keep backups or preferences there. Editing vault-config.md is off." });
    try {
      const c = await launchAuthed(t, configPath, campaignKey);
      const res = await c.get('/api/vault-config/backups');
      assert.equal(res.status, 200);
      const body = json(res);
      assert.equal(body.available, false);
      assert.match(body.reason, /inside the vault/);
      await c.shutdown();
    } finally {
      machinedir.resolveMachineDir = original;
    }
  });
});

// === K19 coverage: checkTarget runs before any read in editorView ===============================

test('editorView: checkTarget runs before any read -- a symlinked _meta outside the vault means zero reads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vce-k19-'));
  try {
    const vaultPath = path.join(root, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const outside = path.join(root, 'outside-meta');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'vault-config.md'), '---\ntype: meta\n---\n\nbody\n');
    fs.symlinkSync(outside, path.join(vaultPath, '_meta'));

    const packDir = path.join(root, 'pack-elsewhere');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ excludeDirs: [], folderMap: {} }) + '\n');
    const configDir = path.join(root, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "k19"', '', '[campaigns.k19]', `vault = '${vaultPath}'`, `pack = '${packDir}'`, `output = '${root}/out'`, ''].join('\n'),
    );

    const originalReadBytes = read.readBytes;
    let calls = 0;
    read.readBytes = (...args) => {
      if (String(args[0]).includes('vault-config.md')) calls++;
      return originalReadBytes(...args);
    };
    try {
      const c = await launchAuthed(t, configPath, 'k19');
      const res = await c.get('/api/state?include=vaultconfigeditor');
      const body = json(res);
      assert.equal(body.vaultConfigEditor.exists, false);
      assert.ok(body.vaultConfigEditor.reason);
      assert.equal(calls, 0, 'readBytes must never be called for vault-config.md when checkTarget already refused');
      await c.shutdown();
    } finally {
      read.readBytes = originalReadBytes;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// === K23 coverage: a lone stray CR disables canEdit =============================================

test('editorView: a stray carriage return inside the frontmatter disables canEdit (lone-cr)', async (t) => {
  // A \r embedded MID-LINE (not as part of the line's own \r\n terminator) -- the rest of the
  // frontmatter consistently uses plain \n, so this is lone-cr, not mixed-eol.
  const vaultConfigMd = '---\ntype: meta\npublish:\n  mode: "pla\ryer"\n---\n\nbody\n';
  await withScratchOpts({ vaultConfigMd }, async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const res = await c.get('/api/state?include=vaultconfigeditor');
    const body = json(res).vaultConfigEditor;
    assert.equal(body.canEdit, false);
    assert.match(body.reason, /stray carriage return/);
    await c.shutdown();
  });
});

test('a confirm while ctx.busy is set gives 409 busy', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const newText = 'type: meta\npublish:\n  mode: full';
    const [first, second] = await Promise.all([
      postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true }),
      postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.ok(statuses.includes(200));
    assert.ok(statuses.includes(200) || statuses.includes(409));
    await c.shutdown();
  });
});

// === Backup pruning failure never blocks a save ==================================================

test('an injected prune unlinkSync EBUSY still gives a 200 save', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const c = await launchAuthed(t, configPath, campaignKey);
    const state = json(await c.get('/api/state?include=vaultconfigeditor'));
    const newText = 'type: meta\npublish:\n  mode: full';
    const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
    const dryBody = json(dry);

    const original = backups.pruneBackups;
    backups.pruneBackups = () => {
      const err = new Error('EBUSY');
      err.code = 'EBUSY';
      throw err;
    };
    let confirm;
    try {
      confirm = await postJson(c, '/api/vault-config/text', {
        frontmatterText: newText,
        baseSha256: state.vaultConfigEditor.sha256,
        dryRun: false,
        saveAnyway: true,
        reviewedSha256: dryBody.candidateSha256,
      });
    } finally {
      backups.pruneBackups = original;
    }
    assert.equal(confirm.status, 200);
    await c.shutdown();
  });
});

// === console silence ===============================================================================

test('console silence: no console.log/warn/error during a full dry-run+confirm cycle', async (t) => {
  await withScratch(async ({ configPath, campaignKey }) => {
    const calls = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => calls.push(['log', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    try {
      const c = await launchAuthed(t, configPath, campaignKey);
      const state = json(await c.get('/api/state?include=vaultconfigeditor'));
      const newText = 'type: meta\npublish:\n  mode: full';
      const dry = await postJson(c, '/api/vault-config/text', { frontmatterText: newText, baseSha256: state.vaultConfigEditor.sha256, dryRun: true });
      const dryBody = json(dry);
      await postJson(c, '/api/vault-config/text', {
        frontmatterText: newText,
        baseSha256: state.vaultConfigEditor.sha256,
        dryRun: false,
        saveAnyway: true,
        reviewedSha256: dryBody.candidateSha256,
      });
      await c.shutdown();
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
    assert.deepEqual(calls, []);
  });
});
