'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const TOML = require('smol-toml');

const { startLocalListener } = require('../src/serve/server');
const { createAdminHandler } = require('../src/admin/router');
const { createAdminContext } = require('../src/admin/context');
const { resolveVaultSite } = require('../src/cli/check');

// Runs under plain node (the same {VB} = module.exports branch site-runtime.test.js uses for
// {TL, CX}): assets/admin/vocab.js's pure row->entry logic, VB.buildKindEntry, is testable
// without a DOM and without adding a dependency (admin-fix-1 item 1).
const { VB } = require(path.join(__dirname, '..', 'assets', 'admin', 'vocab.js'));

/*
 * admin-fix-1, item 1 (HIGH, FR25): assets/admin/vocab.js's buildKindRow().toEntry() used to send
 * `label` (and, on the same pattern, glyph/aliases/before) for EVERY kind row whenever ANY kind
 * was edited, even for a kind with no on-disk key of that name -- the server then refuses an
 * empty `label` (src/build/labels.js's validateLabelString: "must be a non-empty string").
 * test/fixtures/vocab-vault's 4 kinds have no labels, so it reproduced on every attempt.
 *
 * Section A: VB.buildKindEntry in isolation, under plain node (no server, no DOM).
 * Section B: the REAL server path (a real admin listener, real runSave, real labels.js parser),
 * pairing the old buggy payload shape (refused) against the fixed client's payload (accepted),
 * on a scratch copy of vocab-vault whose kinds have no labels.
 */

// --- Section A: VB.buildKindEntry, pure, under node -------------------------

function untouchedInput(source) {
  return {
    key: source.key,
    label: source.label === undefined ? '' : source.label,
    labelInitial: source.label === undefined ? '' : source.label,
    glyph: source.glyph === undefined ? '' : source.glyph,
    glyphInitial: source.glyph === undefined ? '' : source.glyph,
    aliases: Array.isArray(source.aliases) ? source.aliases.join(', ') : '',
    aliasesInitial: Array.isArray(source.aliases) ? source.aliases.join(', ') : '',
    before: source.before === true,
    beforeInitial: source.before === true,
  };
}

test('A1: label absent on disk, untouched -> omitted (this is the reported bug: the old code sent label:"")', () => {
  const source = { key: 'parley', glyph: 'meeting' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'label'), false);
  assert.deepEqual(entry, { key: 'parley', glyph: 'meeting' });
});

test('A2: label absent on disk, GM types a value -> the typed value is sent (positive control)', () => {
  const source = { key: 'parley', glyph: 'meeting' };
  const input = untouchedInput(source);
  input.label = 'Episode (QA)'; // typed; labelInitial stays '' (never touched before this)
  const entry = VB.buildKindEntry(source, input);
  assert.equal(entry.label, 'Episode (QA)');
});

test('A3: label present on disk, untouched -> round-trips unchanged (positive control)', () => {
  const source = { key: 'origin', label: 'Origin story', glyph: 'backstory' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(entry.label, 'Origin story');
});

test('A4: label present on disk, GM clears it to empty -> omitted (falls back to the key default)', () => {
  const source = { key: 'origin', label: 'Origin story', glyph: 'backstory' };
  const input = untouchedInput(source);
  input.label = '';
  const entry = VB.buildKindEntry(source, input);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'label'), false);
});

test('A5: label present on disk, GM edits it to a new value -> the new value is sent', () => {
  const source = { key: 'origin', label: 'Origin story', glyph: 'backstory' };
  const input = untouchedInput(source);
  input.label = 'Backstory beat';
  const entry = VB.buildKindEntry(source, input);
  assert.equal(entry.label, 'Backstory beat');
});

// -- The same pattern for glyph (the brief: "check the other per-row fields ... for the same
// pattern") --

test('A6: glyph absent on disk, untouched -> omitted', () => {
  const source = { key: 'novel-kind' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'glyph'), false);
});

test('A7: glyph present on disk, untouched -> round-trips unchanged', () => {
  const source = { key: 'clash', glyph: 'fight', aliases: ['battle'] };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(entry.glyph, 'fight');
});

// -- aliases --

test('A8: aliases absent on disk, untouched -> omitted', () => {
  const source = { key: 'parley', glyph: 'meeting' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'aliases'), false);
});

test('A9: aliases present on disk, untouched -> round-trips unchanged (array, not a re-joined string)', () => {
  const source = { key: 'clash', glyph: 'fight', aliases: ['battle', 'skirmish'] };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.deepEqual(entry.aliases, ['battle', 'skirmish']);
});

test('A10: aliases touched with a new comma list -> parsed, trimmed, filtered', () => {
  const source = { key: 'clash', glyph: 'fight', aliases: ['battle'] };
  const input = untouchedInput(source);
  input.aliases = ' skirmish ,, duel ';
  const entry = VB.buildKindEntry(source, input);
  assert.deepEqual(entry.aliases, ['skirmish', 'duel']);
});

test('A11: aliases touched then cleared back to blank -> omitted', () => {
  const source = { key: 'clash', glyph: 'fight', aliases: ['battle'] };
  const input = untouchedInput(source);
  input.aliases = '   ';
  const entry = VB.buildKindEntry(source, input);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'aliases'), false);
});

// -- before --

test('A12: before absent on disk, untouched -> omitted', () => {
  const source = { key: 'parley', glyph: 'meeting' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'before'), false);
});

test('A13: before present on disk (true), untouched -> round-trips unchanged', () => {
  const source = { key: 'origin', glyph: 'backstory', before: true };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(entry.before, true);
});

test('A14: before toggled off by the GM -> the new value (false) is sent explicitly', () => {
  const source = { key: 'origin', glyph: 'backstory', before: true };
  const input = untouchedInput(source);
  input.before = false;
  const entry = VB.buildKindEntry(source, input);
  assert.equal(entry.before, false);
});

// -- key and unrecognised on-disk keys --

test('A15: key is always sent, touched or not', () => {
  const source = { key: 'clash', glyph: 'fight' };
  const entry = VB.buildKindEntry(source, untouchedInput(source));
  assert.equal(entry.key, 'clash');
});

test('A16: an unrecognised on-disk key (e.g. "color") survives untouched, independent of every other edit', () => {
  const source = { key: 'clash', glyph: 'fight', color: 'red' };
  const input = untouchedInput(source);
  input.label = 'Skirmish'; // edit an unrelated field
  const entry = VB.buildKindEntry(source, input);
  assert.equal(entry.color, 'red');
  assert.equal(entry.label, 'Skirmish');
});

test('A17: a brand-new row (no on-disk data beyond a typed key) omits every untouched field', () => {
  const source = { key: '' };
  const input = untouchedInput(source);
  input.key = 'new-kind';
  const entry = VB.buildKindEntry(source, input);
  assert.deepEqual(entry, { key: 'new-kind' });
});

// --- Section B: the real server path (S3's real runSave/replacePackFile, S4's real labels.js) --

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-vocab-kindentry-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeVocabFixtureVault(root) {
  const vaultPath = path.join(root, 'vault');
  copyDir(path.join(__dirname, 'fixtures', 'vocab-vault'), vaultPath);
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  return { vaultPath, packDir };
}

const TOKEN = 'admin-vocab-kindentry-test-token';

function ctxFor(vaultPath) {
  const ctxInfo = { campaign: 'vocab', vault: vaultPath };
  const { site } = resolveVaultSite(ctxInfo);
  return createAdminContext({ ctxInfo, vaultPath, site, token: TOKEN });
}

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

function post(port, urlPath, obj) {
  const bodyBuf = Buffer.from(JSON.stringify(obj));
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBuf.length),
    Host: `127.0.0.1:${port}`,
    Origin: `http://127.0.0.1:${port}`,
    Cookie: `scriptorium_admin_${port}=${TOKEN}`,
  };
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
          // leave json null
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** Builds the exact `timeline.kinds` array assets/admin/vocab.js's buildForm() would submit when
 * the GM edits exactly one row's label, using the REAL VB.buildKindEntry -- i.e. the fixed
 * client's own payload, not a hand re-derived shape. */
function fixedClientKindsPayload(onDiskKinds, editIndex, newLabel) {
  return onDiskKinds.map((source, i) => {
    const input = untouchedInput(source);
    if (i === editIndex) input.label = newLabel;
    return VB.buildKindEntry(source, input);
  });
}

/** The OLD buggy client's payload: every row always carries label/glyph/aliases/before verbatim
 * from its own display value, regardless of touch state -- reproducing the exact reported defect
 * for a kind with no on-disk label (glyph/aliases/before happen to be on-disk for every
 * vocab-vault kind, so only `label` differs from source here, matching the QA repro). */
function oldBuggyClientKindsPayload(onDiskKinds, editIndex, newLabel) {
  return onDiskKinds.map((source, i) => ({
    key: source.key,
    label: i === editIndex ? newLabel : source.label === undefined ? '' : source.label,
    glyph: source.glyph === undefined ? '' : source.glyph,
    aliases: Array.isArray(source.aliases) ? source.aliases : [],
    before: source.before === true,
  }));
}

test('B1 (real pipeline): the OLD buggy payload (label:"" for every untouched kind) is refused by the real server', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath, 'utf8');
    const onDiskKinds = TOML.parse(before).timeline.kinds;
    const baseSha256 = sha256(Buffer.from(before, 'utf8'));

    const res = await post(port, '/api/pack/vocab', {
      timeline: { kinds: oldBuggyClientKindsPayload(onDiskKinds, 0, 'Episode (QA)') },
      baseSha256,
    });

    assert.equal(res.status, 400);
    assert.ok(
      res.json && typeof res.json.message === 'string' && res.json.message.includes('label must be a non-empty string'),
      `expected the "label must be a non-empty string" refusal; got: ${JSON.stringify(res.json)}`,
    );
    assert.equal(fs.readFileSync(tomlPath, 'utf8'), before, 'pack.toml must be unchanged after a refusal');
  });
});

test('B2 (real pipeline): the FIXED client payload (VB.buildKindEntry, real toEntry() logic) is accepted, and pack.toml changes only in the edited field', async (t) => {
  await withScratchDir(async (root) => {
    const { vaultPath, packDir } = writeVocabFixtureVault(root);
    const ctx = ctxFor(vaultPath);
    const port = await launch(t, ctx);
    const tomlPath = path.join(packDir, 'pack.toml');
    const before = fs.readFileSync(tomlPath, 'utf8');
    const beforeParsed = TOML.parse(before);
    const onDiskKinds = beforeParsed.timeline.kinds;
    const baseSha256 = sha256(Buffer.from(before, 'utf8'));

    const res = await post(port, '/api/pack/vocab', {
      timeline: { kinds: fixedClientKindsPayload(onDiskKinds, 0, 'Episode (QA)') },
      baseSha256,
    });

    assert.equal(res.status, 200, JSON.stringify(res.json));

    const after = fs.readFileSync(tomlPath, 'utf8');
    const afterParsed = TOML.parse(after);

    // Only kind #1 (index 0, "clash") gained a label; every other kind entry, and every other
    // table in the file, is byte-for-byte the value it started as.
    assert.equal(afterParsed.timeline.kinds[0].label, 'Episode (QA)');
    assert.deepEqual(afterParsed.timeline.kinds[0].glyph, onDiskKinds[0].glyph);
    assert.deepEqual(afterParsed.timeline.kinds[0].aliases, onDiskKinds[0].aliases);
    for (let i = 1; i < onDiskKinds.length; i++) {
      assert.deepEqual(afterParsed.timeline.kinds[i], onDiskKinds[i], `kind #${i + 1} must be unchanged`);
    }
    assert.deepEqual(afterParsed.labels, beforeParsed.labels);
    assert.deepEqual(afterParsed.recaps, beforeParsed.recaps);
    assert.equal(afterParsed.theme, beforeParsed.theme);
  });
});
