'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { createAdminContext } = require('../src/admin/context');
const { runBuildCommand } = require('../src/cli/build');
const variants = require('../src/admin/variants');
const preview = require('../src/admin/preview');
const packfiles = require('../src/admin/packfiles');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');

/*
 * V1e-8 (ADR 0039 addendum, SD-70). POST /api/variants/vocab: a private, never-written copy of
 * the site built from the saved pack.toml plus the Vocabulary screen's own unsaved edits, through
 * the save path's own dry run. Synthetic cast only; test/fixtures/vocab-vault is copied to
 * scratch, never written in place.
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

async function withVocabVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variant-vocab-'));
  try {
    const vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    return await fn({ vaultPath, packDir, configPath }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeCtx(configPath) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
  const { vaultPath, site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: 'TOK' });
}

function listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  })(dir, '');
  out.sort();
  return out;
}

function assertTreesByteIdentical(dirA, dirB) {
  const a = listTree(dirA);
  const b = listTree(dirB);
  assert.deepEqual(a, b, 'the two trees do not have the same file list');
  for (const rel of a) {
    assert.deepEqual(fs.readFileSync(path.join(dirA, rel)), fs.readFileSync(path.join(dirB, rel)), `byte mismatch at ${rel}`);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function vaultManifest(vaultPath) {
  return listTree(vaultPath).map((rel) => {
    const buf = fs.readFileSync(path.join(vaultPath, rel));
    return { rel, size: buf.length, sha256: sha256(buf) };
  });
}

function launch(t, configPath, extraFlags = {}) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, 'vocab', {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        // already closed
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}
function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}
async function waitForHandles(state) {
  while (state.handles.length < 2) await waitForMacrotask();
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
function postJson(port, cookie, origin, reqPath, obj) {
  return postRawJson(port, cookie, origin, reqPath, JSON.stringify(obj));
}
/** Like postJson, but `body` is a caller-built JSON string -- needed for a genuine own
 * "__proto__" key, which `{ __proto__: x }` object-literal syntax can never produce (it sets the
 * prototype instead); `JSON.parse` on the wire has no such special case. */
function postRawJson(port, cookie, origin, reqPath, body) {
  return request(port, {
    method: 'POST',
    path: reqPath,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
}
/** Starts an admin server on a fresh scratch vault for `t`, returns {adminPort, cookie, origin, sha}. */
async function startSession(t, configPath) {
  const ctx = makeCtx(configPath);
  const sha = packfiles.readPackFile(ctx, 'pack.toml').sha256;
  const state = await waitForHandles(launch(t, configPath));
  const adminPort = state.handles[0].port;
  const token = tokenFromLine(state.emitted[0]);
  const cookie = `scriptorium_admin_${adminPort}=${token}`;
  const origin = `http://127.0.0.1:${adminPort}`;
  return { state, adminPort, cookie, origin, sha };
}

// A minimal fake req/res pair for calling handlers.buildVocab directly without a real socket.
function fakeBodyReq(obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const req = Object.assign(new EventEmitter(), {
    headers: { 'content-length': String(buf.length) },
    resume() {},
  });
  setImmediate(() => {
    req.emit('data', buf);
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  const res = {
    status: null,
    headers: null,
    json: null,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      if (body !== undefined) {
        try {
          res.json = JSON.parse(body.toString());
        } catch {
          res.text = body.toString();
        }
      }
    },
  };
  return res;
}

// --- The AC-11 literal, ctx-level (candidateReads evidence, AC-V8-01) --------------------------

test('variants.buildVariant(vocab, ...) over an unsaved label edit: the copy tree has the literal, pack.toml and the vault manifest are unchanged, candidateReads >= 1', async () => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const manifestBefore = vaultManifest(vaultPath);
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const cur = packfiles.readPackFile(ctx, 'pack.toml');
      const candidate = cur.raw.toString('utf8').replace('group_npc = "Folk"', 'group_npc = "Zq Invented Folk Zq"');
      assert.notEqual(candidate, cur.raw.toString('utf8'), 'fixture precondition: group_npc = "Folk" must be in pack.toml');

      const outcome = variants.buildVariant(ctx, variants.VOCAB_VARIANT_ID, candidate);
      assert.equal(outcome.result.exitCode, 0, outcome.result.human);
      assert.ok(outcome.candidateReads >= 1, 'AC-V8-01: the candidate must reach the build through the read overlay');

      const dir = variants.variantDirFor(ctx, variants.VOCAB_VARIANT_ID);
      const files = listTree(dir);
      const hit = files.some((rel) => fs.readFileSync(path.join(dir, rel), 'utf8').includes('Zq Invented Folk Zq'));
      assert.ok(hit, 'the vocab copy tree must contain the unsaved literal somewhere');

      const mainPreviewRoot = path.join(ctx.previewRoot, 'site');
      if (fs.existsSync(mainPreviewRoot)) {
        const mainFiles = listTree(mainPreviewRoot);
        const mainHit = mainFiles.some((rel) => fs.readFileSync(path.join(mainPreviewRoot, rel), 'utf8').includes('Zq Invented Folk Zq'));
        assert.equal(mainHit, false, 'the main preview (never built here) must not carry the literal');
      }

      const onDiskAfter = packfiles.readPackFile(ctx, 'pack.toml');
      assert.equal(onDiskAfter.sha256, cur.sha256, 'pack.toml must be byte-unchanged');
      assert.deepEqual(vaultManifest(vaultPath), manifestBefore);

      const configuredOutput = path.join(path.dirname(configPath), 'out');
      assert.ok(!fs.existsSync(configuredOutput));
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});

// --- The AC-11 literal, over HTTP ----------------------------------------------------------------

test('POST /api/variants/vocab over HTTP: 200 exitCode 0, variant.pages has a character role, pack.toml and the vault manifest are unchanged', async (t) => {
  await withVocabVault(async ({ vaultPath, configPath }) => {
    const manifestBefore = vaultManifest(vaultPath);
    const { adminPort, cookie, origin, sha } = await startSession(t, configPath);

    const res = await postJson(adminPort, cookie, origin, '/api/variants/vocab', {
      labels: { group_npc: 'Zq Invented Folk Zq' },
      baseSha256: sha,
    });
    assert.equal(res.status, 200, res.body.toString());
    const parsed = JSON.parse(res.body.toString());
    assert.equal(parsed.exitCode, 0, parsed.human);
    assert.ok(parsed.variant.pages.some((p) => p.role === 'character'), 'variant.pages must carry a character role');
    assert.equal(parsed.variant.id, 'vocab');

    const onDiskAfter = packfiles.readPackFile(makeCtx(configPath), 'pack.toml');
    assert.equal(onDiskAfter.sha256, sha, 'pack.toml must be byte-unchanged');
    assert.deepEqual(vaultManifest(vaultPath), manifestBefore);
  });
});

// --- Equivalence: the copy tree equals a CLI build of a really-saved second scratch copy --------

test('equivalence: the vocab copy tree is byte-identical to a CLI build of a second scratch copy into which the same edits were really saved', async (t) => {
  await withVocabVault(async ({ configPath: configPathA }) => {
    // Built at the ctx level (through the real handler, fake req/res), not over a real socket:
    // the admin server creates its OWN ctx internally, with its own mktemp previewRoot this
    // process has no path to -- the same reason V1e-7's own equivalence test builds directly.
    const ctxA = makeCtx(configPathA);
    preview.ensurePreviewRoot(ctxA);
    try {
      const handlers = require('../src/admin/handlers/variants');
      const sha = packfiles.readPackFile(ctxA, 'pack.toml').sha256;
      const res = fakeRes();
      await handlers.buildVocab(fakeBodyReq({ labels: { group_npc: 'Second Copy Folk' }, baseSha256: sha }), res, ctxA);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.exitCode, 0, res.json.human);
      const vocabDir = variants.variantDirFor(ctxA, variants.VOCAB_VARIANT_ID);

      await withVocabVault(async ({ configPath: configPathB }) => {
        const sessionB = await startSession(t, configPathB);
        const dry = await postJson(sessionB.adminPort, sessionB.cookie, sessionB.origin, '/api/pack/vocab', {
          labels: { group_npc: 'Second Copy Folk' },
          baseSha256: sessionB.sha,
          dryRun: true,
        });
        assert.equal(dry.status, 200, dry.body.toString());
        const confirm = await postJson(sessionB.adminPort, sessionB.cookie, sessionB.origin, '/api/pack/vocab', {
          labels: { group_npc: 'Second Copy Folk' },
          baseSha256: sessionB.sha,
        });
        assert.equal(confirm.status, 200, confirm.body.toString());

        // Own parent dir (issue #102): a build stages in a SIBLING of its output, so an output sitting
    // directly in os.tmpdir() shares a staging parent with every other parallel test file.
    const cliOutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-variant-vocab-cli-'));
    const cliOut = path.join(cliOutRoot, 'out');
        try {
          const cli = runBuildCommand({ config: configPathB, out: cliOut }, 'vocab');
          assert.equal(cli.exitCode, 0, cli.human);
          assertTreesByteIdentical(vocabDir, cliOut);
        } finally {
          fs.rmSync(cliOutRoot, { recursive: true, force: true });
        }
      });
    } finally {
      preview.removePreviewRoot(ctxA);
    }
  });
});

// --- Parity of refusals -----------------------------------------------------------------------

test('parity of refusals: each bad body gives the same 400 message on /api/variants/vocab as /api/pack/vocab (dryRun:true) does', async (t) => {
  await withVocabVault(async ({ configPath }) => {
    const { adminPort, cookie, origin, sha } = await startSession(t, configPath);

    const cases = [
      { label: 'unknown label', raw: JSON.stringify({ labels: { chapter_extra: 'x' }, baseSha256: sha }) },
      {
        label: '__proto__ inside labels',
        // A genuine own "__proto__" key: JSON.parse (unlike `{ __proto__: x }` object-literal
        // syntax, which sets the prototype instead) has no special case for it.
        raw: `{"labels":{"__proto__":{"polluted":true}},"baseSha256":"${sha}"}`,
      },
      { label: 'timeline: null', raw: JSON.stringify({ timeline: null, baseSha256: sha }) },
      { label: 'no edit keys', raw: JSON.stringify({ baseSha256: sha }) },
      { label: 'a 63-character sha', raw: JSON.stringify({ labels: { group_npc: 'x' }, baseSha256: 'a'.repeat(63) }) },
    ];

    for (const { label, raw } of cases) {
      const parsedBody = JSON.parse(raw);
      const variantRes = await postRawJson(adminPort, cookie, origin, '/api/variants/vocab', raw);
      const packRes = await postJson(adminPort, cookie, origin, '/api/pack/vocab', { ...parsedBody, dryRun: true });
      assert.equal(variantRes.status, 400, `case ${label}: ${variantRes.body.toString()}`);
      assert.equal(packRes.status, 400, `parity fixture case ${label}: ${packRes.body.toString()}`);
      const variantJson = JSON.parse(variantRes.body.toString());
      const packJson = JSON.parse(packRes.body.toString());
      assert.equal(variantJson.message, packJson.message, `case ${label}`);
    }

    const dryRunCase = await postJson(adminPort, cookie, origin, '/api/variants/vocab', {
      labels: { group_npc: 'x' },
      baseSha256: sha,
      dryRun: true,
    });
    assert.equal(dryRunCase.status, 400);
    assert.deepEqual(JSON.parse(dryRunCase.body.toString()), { error: 'invalid', message: 'unknown field: dryRun' });
  });
});

// --- Sha precondition, busy, read-only, product-parse failure -----------------------------------

test('sha precondition: an outside pack.toml edit then a POST with the old sha gives 409 changed with the save message, and no copy is built', async (t) => {
  await withVocabVault(async ({ packDir, configPath }) => {
    const { adminPort, cookie, origin, sha: oldSha } = await startSession(t, configPath);

    const raw = fs.readFileSync(path.join(packDir, 'pack.toml'), 'utf8');
    fs.writeFileSync(path.join(packDir, 'pack.toml'), raw + '\n# an outside edit\n');

    const res = await postJson(adminPort, cookie, origin, '/api/variants/vocab', {
      labels: { group_npc: 'x' },
      baseSha256: oldSha,
    });
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body.toString()), {
      error: 'changed',
      message: 'pack.toml changed outside the panel. Reload before saving.',
    });

    const stateRes = await request(adminPort, { path: '/api/state?include=variants', headers: { Cookie: cookie } });
    const stateBody = JSON.parse(stateRes.body.toString());
    const vocabItem = stateBody.variants.items.find((it) => it.id === 'vocab');
    assert.equal(vocabItem.built, false, 'no vocab copy should have been built');
  });
});

test('busy gives 409', async () => {
  // ctx.busy set directly, the same deterministic pattern V1e-7's own access test uses (a real
  // overlapping-request race against a build this fast has no reliable window to land in).
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    ctx.busy = 'write';
    const handlers = require('../src/admin/handlers/variants');
    const res = fakeRes();
    const sha = packfiles.readPackFile(ctx, 'pack.toml').sha256;
    await handlers.buildVocab(fakeBodyReq({ labels: { group_npc: 'x' }, baseSha256: sha }), res, ctx);
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'busy');
    ctx.busy = null;
  });
});

test('read-only gives 403', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    ctx.writable = false;
    ctx.readOnlyReason = 'read-only test campaign';
    const handlers = require('../src/admin/handlers/variants');
    const res = fakeRes();
    const sha = packfiles.readPackFile(ctx, 'pack.toml').sha256;
    await handlers.buildVocab(fakeBodyReq({ labels: { group_npc: 'x' }, baseSha256: sha }), res, ctx);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'read-only', message: 'read-only test campaign' });
  });
});

test('a candidate that fails product parse gives 400 with the dry-run message', async () => {
  await withVocabVault(async ({ configPath }) => {
    const ctx = makeCtx(configPath);
    preview.ensurePreviewRoot(ctx);
    try {
      const handlers = require('../src/admin/handlers/variants');
      const sha = packfiles.readPackFile(ctx, 'pack.toml').sha256;
      const res = fakeRes();
      await handlers.buildVocab(fakeBodyReq({ timeline: { session_token: '(' }, baseSha256: sha }), res, ctx);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'invalid');
    } finally {
      preview.removePreviewRoot(ctx);
    }
  });
});
