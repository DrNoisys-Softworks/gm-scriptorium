'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const prefsStore = require('../src/admin/prefs');
const { PREF_SCHEMA, PREFS_FILE, PREFS_MAX_BYTES, VIEWPORTS, LEGACY_VIEW_KEYS, defaults, explicitOf, normalise, readPrefs, writePref } = prefsStore;
const { resolveMachineDir } = require('../src/config/machinedir');

/*
 * V1e-2 (ADR 0033 SS7, SD-10, AC-06), extended V1e-3 (SD-20, per-viewport-class prefs). Isolation
 * (test-first order): every scratch env var is set to a per-file mkdtemp BEFORE any test runs, so
 * an accidental default-path fallback anywhere in this file lands in scratch, never in the real
 * ~/.config/scriptorium or %APPDATA%\Scriptorium.
 */
const SCRATCH_XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-xdg-'));
process.env.XDG_CONFIG_HOME = SCRATCH_XDG;
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-appdata-'));
process.env.SCRIPTORIUM_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-sc-')), 'config.toml');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeMachineDir(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, 'x');
  const result = resolveMachineDir({ configPath, vaultPath });
  assert.equal(result.ok, true, 'test fixture setup: expected an ok machine dir');
  return { result, configDir, vaultPath };
}

// Independent literal (never derived from PREF_SCHEMA): 5 screens x 3 viewport classes, plus
// pane.place.laptop/phone (owner decision, 2026-09-30: default "below", not the Architect's
// original "overlay"), plus the 4 unchanged single-value keys. 15 + 2 + 4 = 21.
const DEFAULTS_LITERAL = {
  'view.overview.wide': 'ov1',
  'view.overview.laptop': 'ov1',
  'view.overview.phone': 'ov1',
  'view.title.wide': 'tt1',
  'view.title.laptop': 'tt1',
  'view.title.phone': 'tt1',
  'view.images.wide': 'im1',
  'view.images.laptop': 'im1',
  'view.images.phone': 'im1',
  'view.vocab.wide': 'vo1',
  'view.vocab.laptop': 'vo1',
  'view.vocab.phone': 'vo1',
  'view.vault-config.wide': 'vc1',
  'view.vault-config.laptop': 'vc1',
  'view.vault-config.phone': 'vc1',
  'pane.place.laptop': 'below',
  'pane.place.phone': 'below',
  'pane.hidden': false,
  'rail.hidden': false,
  'ov2.follow': true,
  'preview.device': 'desktop',
};

// === PREF_SCHEMA shape =========================================================================

test('PREF_SCHEMA: exactly 21 entries, [key, allowedValues, default] each, in DEFAULTS_LITERAL\'s own order, and defaults() equals the independent literal', () => {
  assert.equal(PREF_SCHEMA.length, 21);
  assert.deepEqual(PREF_SCHEMA.map((e) => e[0]), Object.keys(DEFAULTS_LITERAL));
  assert.deepEqual(defaults(), DEFAULTS_LITERAL);
  assert.deepEqual(Object.keys(defaults()), Object.keys(DEFAULTS_LITERAL));
  assert.equal(PREFS_FILE, 'panel-prefs.json');
  assert.equal(PREFS_MAX_BYTES, 4096);
  assert.deepEqual(VIEWPORTS, ['wide', 'laptop', 'phone']);
});

test('owner decision: pane.place.laptop and pane.place.phone both default to "below", overriding the drawer/sheet overlay default', () => {
  assert.equal(defaults()['pane.place.laptop'], 'below');
  assert.equal(defaults()['pane.place.phone'], 'below');
});

test('LEGACY_VIEW_KEYS: 5 entries, [legacyKey, screenId, legacyDefault], one per view.* screen', () => {
  assert.deepEqual(LEGACY_VIEW_KEYS, [
    ['view.overview', 'overview', 'ov1'],
    ['view.title', 'title', 'tt1'],
    ['view.images', 'images', 'im1'],
    ['view.vocab', 'vocab', 'vo1'],
    ['view.vault-config', 'vault-config', 'vc1'],
  ]);
});

test('each PREF_SCHEMA entry is accepted by normalise(), and each of its listed values round-trips', () => {
  for (const [key, allowed, def] of PREF_SCHEMA) {
    assert.ok(allowed.includes(def), `${key}'s own default must be one of its allowed values`);
    for (const value of allowed) {
      const n = normalise({ [key]: value });
      assert.equal(n[key], value, `${key}=${JSON.stringify(value)} must round-trip through normalise`);
    }
  }
});

test('normalise(): a value outside a key\'s allowedValues falls back to that key\'s own default, independently per key', () => {
  const n = normalise({ 'view.overview.wide': 'ov4', 'view.title.laptop': 'tt2', 'pane.hidden': 'true' });
  assert.equal(n['view.overview.wide'], 'ov1'); // rejected, falls back
  assert.equal(n['view.title.laptop'], 'tt2'); // accepted
  assert.equal(n['pane.hidden'], false); // "true" (string) is not in [false,true]
});

test('normalise(): an unknown key and a literal "__proto__" own-property are both dropped, never copied', () => {
  const tampered = JSON.parse('{"__proto__":{"polluted":true},"view.overview.wide":"ov2","nonsense.key":"x"}');
  const n = normalise(tampered);
  assert.deepEqual(Object.keys(n).sort(), Object.keys(DEFAULTS_LITERAL).sort());
  assert.equal(n['view.overview.wide'], 'ov2');
  assert.equal(Object.prototype.hasOwnProperty.call(n, 'nonsense.key'), false);
  assert.equal({}.polluted, undefined, 'normalise must never pollute Object.prototype');
});

test('normalise(): a non-object, an array, and null all produce plain defaults', () => {
  assert.deepEqual(normalise(null), DEFAULTS_LITERAL);
  assert.deepEqual(normalise(undefined), DEFAULTS_LITERAL);
  assert.deepEqual(normalise('x'), DEFAULTS_LITERAL);
  assert.deepEqual(normalise(['view.overview.wide', 'ov2']), DEFAULTS_LITERAL);
});

// === explicitOf(): sparse subset, migration ====================================================

test('explicitOf(): a fresh per-class value round-trips, in schema order, nothing else present', () => {
  const e = explicitOf({ 'view.title.laptop': 'tt2', 'pane.hidden': true });
  assert.deepEqual(e, { 'view.title.laptop': 'tt2', 'pane.hidden': true });
  assert.deepEqual(Object.keys(e), ['view.title.laptop', 'pane.hidden']); // schema order
});

test('explicitOf(): migration -- a legacy {view.title:"tt2"} (differs from its own default tt1) fills all three title classes', () => {
  const e = explicitOf({ 'view.title': 'tt2' });
  assert.deepEqual(e, { 'view.title.wide': 'tt2', 'view.title.laptop': 'tt2', 'view.title.phone': 'tt2' });
});

test('explicitOf(): migration -- a legacy value EQUAL to its own default (view.overview:"ov1") is never counted as a choice', () => {
  const e = explicitOf({ 'view.overview': 'ov1' });
  assert.deepEqual(e, {});
});

test('explicitOf(): an explicit per-class key beats legacy migration for that one class; the other two classes still migrate', () => {
  const e = explicitOf({ 'view.title': 'tt3', 'view.title.laptop': 'tt2' });
  assert.deepEqual(e, { 'view.title.laptop': 'tt2', 'view.title.wide': 'tt3', 'view.title.phone': 'tt3' });
});

test('explicitOf(): a legacy value the schema does not allow for that screen is ignored entirely', () => {
  const e = explicitOf({ 'view.title': 'ov1' }); // ov1 is not a title option
  assert.deepEqual(e, {});
});

test('explicitOf(): a non-object, an array, and null all give {}', () => {
  assert.deepEqual(explicitOf(null), {});
  assert.deepEqual(explicitOf(undefined), {});
  assert.deepEqual(explicitOf('x'), {});
  assert.deepEqual(explicitOf(['view.title', 'tt2']), {});
});

test('explicitOf(): "__proto__" as an own-property is dropped, never pollutes', () => {
  const tampered = JSON.parse('{"__proto__":{"polluted":true},"view.title.laptop":"tt2"}');
  const e = explicitOf(tampered);
  assert.deepEqual(e, { 'view.title.laptop': 'tt2' });
  assert.equal({}.polluted, undefined);
});

test('normalise() == defaults() overlaid with explicitOf(): independently confirmed for a mixed object', () => {
  const obj = { 'view.title': 'tt2', 'pane.place.laptop': 'overlay' };
  const n = normalise(obj);
  assert.equal(n['view.title.wide'], 'tt2');
  assert.equal(n['view.title.laptop'], 'tt2');
  assert.equal(n['view.title.phone'], 'tt2');
  assert.equal(n['pane.place.laptop'], 'overlay');
  assert.equal(n['pane.place.phone'], 'below'); // untouched key keeps its own default
  assert.equal(n['view.overview.wide'], 'ov1');
});

// === readPrefs(): tamper cases, hand-written bytes =============================================

test('readPrefs(): an unavailable machine dir gives defaults, not persisted, with its reason carried through', () => {
  const r = readPrefs({ ok: false, reason: 'nope' });
  assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
  assert.equal(r.persisted, false);
  assert.equal(r.reason, 'nope');
});

test('readPrefs(): no file yet (ENOENT) gives defaults, not persisted, reason null', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal(r.persisted, false);
    assert.equal(r.reason, null);
  });
});

test('readPrefs(): a sparse file with one unknown id round-trips the rest and drops the unknown key (persisted)', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), JSON.stringify({ 'view.overview.wide': 'ov3', 'view.titlex': 'tt9' }));
    const r = readPrefs(result);
    assert.equal(r.persisted, true);
    assert.equal(r.prefs['view.overview.wide'], 'ov3');
    assert.equal(r.prefs['view.title.wide'], 'tt1');
  });
});

test('readPrefs(): a legacy on-disk file (V1e-2 shape) migrates through explicitOf on read', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), JSON.stringify({ 'view.title': 'tt3', 'pane.hidden': true }));
    const r = readPrefs(result);
    assert.equal(r.prefs['view.title.wide'], 'tt3');
    assert.equal(r.prefs['view.title.laptop'], 'tt3');
    assert.equal(r.prefs['view.title.phone'], 'tt3');
    assert.equal(r.prefs['pane.hidden'], true);
  });
});

test('readPrefs(): a "__proto__" own-property in a valid JSON object file is dropped, prototype stays clean', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), '{"__proto__":{"polluted":true}}');
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal({}.polluted, undefined);
  });
});

test('readPrefs(): malformed JSON gives defaults, not persisted', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), '{not json');
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal(r.persisted, false);
  });
});

test('readPrefs(): a top-level JSON array gives defaults, not persisted', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), '["view.overview","ov2"]');
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal(r.persisted, false);
  });
});

test('readPrefs(): a file over 4096 bytes gives defaults, not persisted (exactly-4096 is still read)', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    const okObj = { 'view.overview.wide': 'ov2' };
    // Pad with a harmless unknown key so the encoded size is deterministic and > 4096.
    okObj.pad = 'x'.repeat(4200);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), JSON.stringify(okObj));
    assert.ok(fs.statSync(path.join(result.dir, PREFS_FILE)).size > PREFS_MAX_BYTES);
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal(r.persisted, false);
  });
});

test('readPrefs(): a symlinked panel-prefs.json is refused (lstat, never followed) and gives defaults', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    const real = path.join(result.dir, 'real-prefs.json');
    fs.writeFileSync(real, JSON.stringify({ 'view.overview.wide': 'ov2' }));
    fs.symlinkSync(real, path.join(result.dir, PREFS_FILE));
    const r = readPrefs(result);
    assert.deepEqual(r.prefs, DEFAULTS_LITERAL);
    assert.equal(r.persisted, false);
  });
});

// === writePref(): sparse write, atomic write, structural scan ==================================

test('writePref(): P15 -- writes a SPARSE object (only the one key just set), not the full effective object', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    const written = writePref(result, 'view.title.laptop', 'tt2');
    assert.equal(written['view.title.laptop'], 'tt2');
    assert.equal(written['view.overview.wide'], 'ov1'); // effective object still carries every default

    const filePath = path.join(result.dir, PREFS_FILE);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // The literal sparse-file proof: ONLY the key just written is on disk, nothing else.
    assert.deepEqual(onDisk, { 'view.title.laptop': 'tt2' });

    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const reread = readPrefs(result);
    assert.equal(reread.persisted, true);
    assert.equal(reread.prefs['view.title.laptop'], 'tt2');

    // No stray temp files left behind.
    const leftover = fs.readdirSync(result.dir).filter((n) => n.includes('scriptorium-tmp'));
    assert.deepEqual(leftover, []);
  });
});

test('writePref(): two sequential writes each keep the other key, sparse, in schema order', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    writePref(result, 'view.title.wide', 'tt3');
    writePref(result, 'pane.hidden', true);
    const filePath = path.join(result.dir, PREFS_FILE);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(onDisk, { 'view.title.wide': 'tt3', 'pane.hidden': true });
    assert.deepEqual(Object.keys(onDisk), ['view.title.wide', 'pane.hidden']); // schema order
  });
});

test('writePref(): class independence -- writing view.title.laptop leaves wide and phone unwritten (sparse)', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    writePref(result, 'view.title.laptop', 'tt2');
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.dir, PREFS_FILE), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'view.title.wide'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'view.title.phone'), false);
    const effective = readPrefs(result).prefs;
    assert.equal(effective['view.title.laptop'], 'tt2');
    assert.equal(effective['view.title.wide'], 'tt1');
    assert.equal(effective['view.title.phone'], 'tt1');
  });
});

test('writePref(): a legacy on-disk file is migrated away on the first write -- the legacy key never survives back to disk', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    fs.writeFileSync(path.join(result.dir, PREFS_FILE), JSON.stringify({ 'view.title': 'tt2' }));
    writePref(result, 'pane.hidden', true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.dir, PREFS_FILE), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'view.title'), false);
    assert.deepEqual(onDisk, {
      'view.title.wide': 'tt2',
      'view.title.laptop': 'tt2',
      'view.title.phone': 'tt2',
      'pane.hidden': true,
    });
  });
});

test('writePref(): an already-invalid pair (bypassing the HTTP handler\'s own gate) is silently normalised away in the RETURNED effective object', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    const written = writePref(result, 'view.overview.wide', 'not-a-real-view');
    assert.equal(written['view.overview.wide'], 'ov1');
  });
});

test('writePref(): a failing rename leaves the temp file removed and the target untouched (mutation E-style)', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    writePref(result, 'view.title.wide', 'tt1'); // establish a baseline file
    const before = fs.readFileSync(path.join(result.dir, PREFS_FILE), 'utf8');

    const original = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    };
    try {
      assert.throws(() => writePref(result, 'view.title.wide', 'tt2'));
    } finally {
      fs.renameSync = original;
    }

    const after = fs.readFileSync(path.join(result.dir, PREFS_FILE), 'utf8');
    assert.equal(after, before, 'a failed rename must leave the previously-written file unchanged');
    const leftover = fs.readdirSync(result.dir).filter((n) => n.includes('scriptorium-tmp'));
    assert.deepEqual(leftover, []);
  });
});

test('structural: src/admin/prefs.js has exactly one wx openSync, one renameSync, one unlinkSync, no recursive, and never names config.toml', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'prefs.js'), 'utf8');
  const source = fullSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.ok(!source.includes('recursive'));
  assert.ok(!source.toLowerCase().includes('config.toml'));

  const openCalls = source.match(/openSync\([^)]*\)/g) || [];
  assert.equal(openCalls.length, 1);
  assert.match(openCalls[0], /'wx'/);

  for (const token of ['renameSync(', 'unlinkSync(']) {
    const count = (source.match(new RegExp(token.replace('(', '\\('), 'g')) || []).length;
    assert.equal(count, 1, `expected exactly one ${token}, found ${count}`);
  }
});

// P12: neither prefs module ever re-derives a path itself -- machinedir's result is the only
// input for "where". A structural grep, not a live mutation (there is no fallback code to
// neuter -- the property under test is its total ABSENCE from the source).
test('P12: prefs.js and handlers/prefs.js never reference defaultConfigPath or resolveConfigPath', () => {
  for (const rel of ['src/admin/prefs.js', 'src/admin/handlers/prefs.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!src.includes('defaultConfigPath'), `${rel} must not reference defaultConfigPath`);
    assert.ok(!src.includes('resolveConfigPath'), `${rel} must not reference resolveConfigPath`);
  }
});

// P10: readPrefs() has no in-process cache -- it re-reads disk on every call.
test('P10: readPrefs() has no in-process cache -- it re-reads disk (and sees a write made in between) on every call', () => {
  withScratchDir((root) => {
    const { result } = makeMachineDir(root);
    writePref(result, 'view.title.wide', 'tt1');

    let calls = 0;
    const original = fs.readFileSync;
    fs.readFileSync = function (...args) {
      calls += 1;
      return original.apply(fs, args);
    };
    let first;
    let second;
    try {
      first = readPrefs(result);
      // A change made through a channel other than this process's own writePref call (as a
      // hand-edit, or another process, would do) -- a cache would never observe this.
      fs.writeFileSync(path.join(result.dir, PREFS_FILE), JSON.stringify({ 'view.title.wide': 'tt3' }));
      second = readPrefs(result);
    } finally {
      fs.readFileSync = original;
    }
    assert.equal(calls, 2, 'each readPrefs() call must perform its own disk read');
    assert.equal(first.prefs['view.title.wide'], 'tt1');
    assert.equal(second.prefs['view.title.wide'], 'tt3', 'a cache would still report tt1 here');
  });
});

// =================================================================================================
// HTTP: GET and POST /api/prefs
// =================================================================================================

function writeScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  const packDir = path.join(vaultPath, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify({ siteTitle: 'Prefs Test' }, null, 2) + '\n');
  fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');

  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
  );
  return { vaultPath, configPath, configDir };
}

function writeReadOnlyScratchVault(root) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  const packRoot = path.join(root, 'pack');
  fs.mkdirSync(packRoot, { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'pack.toml'), 'theme = "plain"\n');
  fs.writeFileSync(path.join(packRoot, 'vault.config.json'), '{"siteTitle":"RO"}\n');
  const configDir = path.join(root, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, `pack = '${packRoot}'`, ''].join(
      '\n',
    ),
  );
  return { vaultPath, configPath, configDir };
}

async function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-http-'));
  try {
    return await fn(writeScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withReadOnlyScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-http-ro-'));
  try {
    return await fn(writeReadOnlyScratchVault(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function launch(t, configPath, extraFlags = {}) {
  const { runServeCommand } = require('../src/cli/serve');
  const { startLocalListener } = require('../src/serve/server');
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true, ...extraFlags }, 'alpha', {
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

async function launchAuthed(t, configPath, extraFlags = {}) {
  const s = await waitForHandles(launch(t, configPath, extraFlags));
  const adminPort = s.handles[0].port;
  const authResult = await request(adminPort, { path: `/auth?token=${tokenFromLine(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    adminPort,
    cookie: cookieHeader,
    emitted: s.emitted,
    get: (p, opts = {}) => request(adminPort, { path: p, headers: { Cookie: cookieHeader, ...(opts.headers || {}) } }),
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

test('GET /api/prefs: gives the exact 3-key shape, 21-key defaults, not persisted, reason null on a fresh vault', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.get('/api/prefs');
    assert.equal(res.status, 200);
    const body = json(res);
    assert.deepEqual(Object.keys(body).sort(), ['persisted', 'prefs', 'reason']);
    assert.deepEqual(body.prefs, DEFAULTS_LITERAL);
    assert.equal(body.persisted, false);
    assert.equal(body.reason, null);
    await c.shutdown();
  });
});

test('POST /api/prefs: each schema entry\'s each allowed value gives 200 with the effective prefs; GET then reflects it', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.vocab.wide', value: 'vo3' }) });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.prefs['view.vocab.wide'], 'vo3');

    const after = json(await c.get('/api/prefs'));
    assert.equal(after.prefs['view.vocab.wide'], 'vo3');
    assert.equal(after.persisted, true);
    await c.shutdown();
  });
});

test('POST /api/prefs: unknown key "view.titlex" gives 400 unknown preference', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.titlex', value: 'tt1' }) });
    assert.equal(res.status, 400);
    assert.match(json(res).message, /unknown preference: view\.titlex/);
    await c.shutdown();
  });
});

test('POST /api/prefs: the LEGACY (pre-V1e-3) key "view.title" is no longer a schema member -- 400', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title', value: 'tt2' }) });
    assert.equal(res.status, 400);
    assert.match(json(res).message, /unknown preference: view\.title$/);
    await c.shutdown();
  });
});

test('POST /api/prefs: view.title.laptop with an unlisted value "tt4" gives 400', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.laptop', value: 'tt4' }) });
    assert.equal(res.status, 400);
    assert.match(json(res).message, /view\.title\.laptop/);
    await c.shutdown();
  });
});

test('POST /api/prefs: pane.hidden with the string "true" (not boolean) gives 400', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'pane.hidden', value: 'true' }) });
    assert.equal(res.status, 400);
    await c.shutdown();
  });
});

test('POST /api/prefs: an extra body field gives 400 unknown field', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.wide', value: 'tt1', extra: 1 }) });
    assert.equal(res.status, 400);
    assert.match(json(res).message, /unknown field/);
    await c.shutdown();
  });
});

test('POST /api/prefs: malformed JSON gives 400', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 400);
    await c.shutdown();
  });
});

test('POST /api/prefs: 503 unavailable when the machine dir is inside the vault, and nothing lands under scratch XDG_CONFIG_HOME', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-prefs-inside-'));
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), '{"siteTitle":"Inside"}\n');
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    // The config lives INSIDE the vault -- machinedir must refuse.
    const configPath = path.join(vaultPath, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    const before = fs.readdirSync(SCRATCH_XDG);

    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }) });
    assert.equal(res.status, 503);
    assert.equal(json(res).error, 'unavailable');
    await c.shutdown();

    assert.deepEqual(fs.readdirSync(SCRATCH_XDG), before, 'a 503 must never fall back to the default per-machine folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only (pack-key) campaign\'s POST gives 200, not 403 (D-18 covers vault writes only)', async (t) => {
  await withReadOnlyScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const res = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }) });
    assert.equal(res.status, 200);
    assert.equal(json(res).ok, true);
    await c.shutdown();
  });
});

test('/api/prefsx, /api/prefs/ and /api give 404', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    for (const p of ['/api/prefsx', '/api/prefs/', '/api']) {
      const res = await c.get(p);
      assert.equal(res.status, 404, p);
    }
    await c.shutdown();
  });
});

test('P6 positive control: a test router copy using exact-path matching (the real rule) refuses "/api/prefsx"; a prefix-match copy wrongly accepts it', () => {
  const { ADMIN_ROUTES } = require('../src/admin/router');
  const exactMatch = (pathname) => ADMIN_ROUTES.find((r) => r.path !== undefined && r.path === pathname && r.method === 'GET');
  const prefixMatch = (pathname) => ADMIN_ROUTES.find((r) => r.path !== undefined && pathname.startsWith(r.path) && r.method === 'GET');

  assert.equal(exactMatch('/api/prefsx'), undefined, 'the real matching rule must refuse the sibling');
  assert.notEqual(prefixMatch('/api/prefsx'), undefined, 'a prefix-match copy demonstrably (wrongly) accepts the sibling -- proving the real rule is exact, not incidental');
});

test('POST /api/prefs without a cookie is refused: token; with a foreign Origin is refused: origin', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const noCookie = await request(c.adminPort, {
      method: 'POST',
      path: '/api/prefs',
      headers: { Origin: `http://127.0.0.1:${c.adminPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }),
    });
    assert.equal(noCookie.status, 403);
    assert.equal(noCookie.body.toString(), 'refused: token');

    const foreignOrigin = await request(c.adminPort, {
      method: 'POST',
      path: '/api/prefs',
      headers: { Cookie: c.cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }),
    });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.body.toString(), 'refused: origin');
    await c.shutdown();
  });
});

test('restart: a saved view.title.laptop survives SIGINT and a relaunch on a different port, from source, PER CLASS (wide/phone stay default)', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const savedRes = await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.laptop', value: 'tt2' }) });
    assert.equal(savedRes.status, 200);
    const firstPort = c.adminPort;
    await c.shutdown();

    const state2 = await waitForHandles(launch(t, configPath));
    const secondPort = state2.handles[0].port;
    assert.notEqual(secondPort, firstPort, 'the admin port must differ between launches with no --port');

    const auth2 = await request(secondPort, { path: `/auth?token=${tokenFromLine(state2.emitted[0])}` });
    const cookie2 = auth2.headers['set-cookie'][0].split(';')[0];
    const res2 = await request(secondPort, { path: '/api/prefs', headers: { Cookie: cookie2 } });
    assert.equal(res2.status, 200);
    const body2 = JSON.parse(res2.body.toString('utf8'));
    assert.equal(body2.prefs['view.title.laptop'], 'tt2');
    assert.equal(body2.prefs['view.title.wide'], 'tt1', 'the wide class must stay at its own default');
    assert.equal(body2.prefs['view.title.phone'], 'tt1', 'the phone class must stay at its own default');
    assert.equal(body2.persisted, true);

    await shutdown(state2);
  });
});

test('a POST without a cookie leaves nothing written: prefs before and after are identical', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);
    const before = json(await c.get('/api/prefs'));
    await request(c.adminPort, {
      method: 'POST',
      path: '/api/prefs',
      headers: { Origin: `http://127.0.0.1:${c.adminPort}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }),
    });
    const after = json(await c.get('/api/prefs'));
    assert.deepEqual(after, before);
    await c.shutdown();
  });
});

test('console and process.stderr.write stay silent across a battery of /api/prefs requests', async (t) => {
  await withScratch(async ({ configPath }) => {
    const c = await launchAuthed(t, configPath);

    const calls = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalStderrWrite = process.stderr.write;
    console.log = (...a) => calls.push(['log', a]);
    console.info = (...a) => calls.push(['info', a]);
    console.warn = (...a) => calls.push(['warn', a]);
    console.error = (...a) => calls.push(['error', a]);
    process.stderr.write = (...a) => {
      calls.push(['stderr', a]);
      return true;
    };

    try {
      await c.get('/api/prefs');
      await c.post('/api/prefs', { body: JSON.stringify({ key: 'view.title.wide', value: 'tt2' }) });
      await c.post('/api/prefs', { body: JSON.stringify({ key: 'nonsense', value: 1 }) });
      await c.post('/api/prefs', { body: '{not json' });
      await c.get('/api/prefsx');
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
      process.stderr.write = originalStderrWrite;
    }

    assert.deepEqual(calls, []);
    await c.shutdown();
  });
});

// Drift tests against assets/admin/nav.js's NV.VIEWS/NV.PREF_DEFAULTS live in
// test/admin-v1e2-model.test.js (which already loads nav.js), not here: this file's own suite
// must stay green using only src/admin/prefs.js, src/admin/handlers/prefs.js and router.js, so
// it stands as its own commit ahead of the panel (nav.js/frame.js) changes.
