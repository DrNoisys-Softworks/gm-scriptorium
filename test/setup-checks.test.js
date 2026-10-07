'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scratchRoot, copySample } = require('./helpers/setup-fixtures');

const checks = require('../src/setup/checks');

/*
 * AC: every field is checked on the server with the shared rules, and each refusal's `rule` is the
 * shared validator's own message, written out here word for word (never read back from the code
 * under test): name (src/setup/validate.js), not found and not a vault (src/vault/locate.js),
 * inside the vault (src/build/plan.js), the non-empty output warning and the title rule.
 */

const NOT_A_VAULT_TAIL =
  ' exists but has no _meta/vault-config.md; it is not a gm-apprentice vault. ' +
  'A vault needs a _meta/vault-config.md settings page. To see a complete one, look at examples/the-long-lease ' +
  'in the GM-Scriptorium download; to create your own, see the gm-apprentice project: ' +
  'https://github.com/AntTheLimey/gm-apprentice';
const RELATIVE_RULE = 'Use the full folder path, starting with a drive letter or /';

/** A fake fsp that records every call, so a test can prove nothing touched the filesystem. */
function spyFsp() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.reject(Object.assign(new Error('spy'), { code: 'ENOENT' }));
  };
  return { calls, stat: record('stat'), readdir: record('readdir') };
}

// --- name ------------------------------------------------------------------

test('checkName: a good name is ok and carries no rule', async () => {
  const r = await checks.checkName('lease');
  assert.equal(r.field, 'name');
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'lease');
  assert.equal(r.rule, null);
});

test('checkName: a bad name is bad, with the shared message word for word and a slug suggestion', async () => {
  const r = await checks.checkName('The Long Lease!');
  assert.equal(r.state, 'bad');
  assert.equal(
    r.rule,
    'invalid campaign name "The Long Lease!": use 1 to 63 lowercase letters, digits or hyphens, starting with a letter or digit',
  );
  assert.equal(r.facts.suggestion, 'the-long-lease');
});

test('checkName: surrounding spaces are trimmed (init trims the answer), an empty name is bad, no suggestion for nothing usable', async () => {
  assert.equal((await checks.checkName('  lease  ')).value, 'lease');
  assert.equal((await checks.checkName('')).state, 'bad');
  assert.equal((await checks.checkName('!!!')).facts.suggestion, null);
});

// --- vault -----------------------------------------------------------------

test('checkVault: a vault is ok with its facts (local, no pack yet, title from vault-config.md)', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkVault(vault, { name: 'lease', commit: false });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, vault);
  assert.equal(r.rule, null);
  assert.deepEqual(r.facts, { found: true, isVault: true, unc: false, candidate: null, packExists: false, campaignTitle: 'The Long Lease' });
});

test('checkVault: packExists is true once _meta/scriptorium is there', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  assert.equal((await checks.checkVault(vault, { name: 'lease' })).facts.packExists, true);
});

test('checkVault: a missing folder is bad with the not-found message word for word', async (t) => {
  const root = scratchRoot(t);
  const missing = path.join(root, 'nowhere');
  const r = await checks.checkVault(missing, { name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, `campaign "lease": configured vault path does not exist: ${missing}`);
  assert.equal(r.facts.found, false);
  assert.equal(r.facts.isVault, false);
});

test('checkVault: a folder that is not a vault is bad with the not-a-vault message word for word', async (t) => {
  const root = scratchRoot(t);
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const r = await checks.checkVault(plain, { name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, `campaign "lease": ${plain}${NOT_A_VAULT_TAIL}`);
  assert.deepEqual(r.facts, { found: true, isVault: false, unc: false, candidate: null, packExists: false, campaignTitle: null });
});

test('checkVault: the candidate offer names a vault exactly one folder down', async (t) => {
  const root = scratchRoot(t);
  const parent = path.join(root, 'games');
  fs.mkdirSync(parent);
  const inner = copySample(parent, 'long-lease');
  const r = await checks.checkVault(parent, { name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.facts.candidate, inner);
});

test('checkVault: a relative path is refused with the full-path message (browser input has no working directory)', async () => {
  const r = await checks.checkVault('vault/here', { name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, RELATIVE_RULE);
});

test('checkVault: surrounding double quotes are stripped, as init does', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkVault(`"${vault}"`, { name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, vault);
});

test('checkVault: a UNC path with commit=0 is deferred and makes ZERO filesystem calls', async () => {
  const fsp = spyFsp();
  for (const unc of ['\\\\ledger-nas\\campaigns\\lease', '//ledger-nas/campaigns/lease']) {
    const r = await checks.checkVault(unc, { name: 'lease', commit: false }, { fsp });
    assert.equal(r.state, 'deferred', unc);
    assert.equal(r.facts.unc, true);
    assert.equal(r.rule, null);
  }
  const noFlag = await checks.checkVault('//ledger-nas/campaigns/lease', { name: 'lease' }, { fsp });
  assert.equal(noFlag.state, 'deferred');
  assert.deepEqual(fsp.calls, [], 'no stat, no readdir');
});

test('checkVault: a UNC path with commit=1 is probed; a share that does not answer is unreachable, and the sync validator never runs', async () => {
  const fsp = {
    calls: 0,
    stat() {
      this.calls++;
      return new Promise(() => {});
    },
  };
  const real = require('../src/vault/locate');
  let locateCalls = 0;
  const original = real.locateVault;
  real.locateVault = (...args) => {
    locateCalls++;
    return original(...args);
  };
  try {
    const iv = setInterval(() => {}, 20);
    const r = await checks.checkVault('//ledger-nas/campaigns/lease', { name: 'lease', commit: true }, { fsp, timeoutMs: 50 });
    clearInterval(iv);
    assert.equal(r.state, 'unreachable');
    assert.equal(r.facts.reason, 'timeout');
    assert.match(r.rule, /within a few seconds/);
  } finally {
    real.locateVault = original;
  }
  assert.equal(fsp.calls, 1);
  assert.equal(locateCalls, 0, 'locateVault is called only after the probe answers ok or missing');
});

test('checkVault: a vault reached through a //host/share style path with commit=1 is a warn (network share) once found', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  // On POSIX "//" + an absolute path is the same folder, which gives a real UNC-looking path to test with.
  const uncLooking = `/${vault}`;
  const r = await checks.checkVault(uncLooking, { name: 'lease', commit: true });
  assert.equal(r.state, 'warn');
  assert.equal(r.facts.unc, true);
  assert.equal(r.facts.isVault, true);
  assert.equal(r.value, vault);
});

// --- output ----------------------------------------------------------------

test('checkOutput: a new sibling folder is ok and the default is <vault parent>/<name>-site', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const want = path.join(root, 'lease-site');
  const r = await checks.checkOutput(want, { vault, name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, want);
  assert.deepEqual(r.facts, { default: want, inside: false, nonEmptyForeign: false, exists: false });
});

test('checkOutput: an empty value answers with the default so the browser can prefill it', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkOutput('', { vault, name: 'lease' });
  assert.equal(r.facts.default, path.join(root, 'lease-site'));
  assert.equal(r.state, 'bad');
});

test('checkOutput: inside the vault is bad with the shared refusal word for word', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const inside = path.join(vault, 'site');
  const r = await checks.checkOutput(inside, { vault, name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, `refusing to build inside the vault: ${inside}`);
  assert.equal(r.facts.inside, true);
});

test('checkOutput: a folder that contains the vault is bad with the shared refusal word for word', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkOutput(root, { vault, name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, `refusing to build into an output dir that contains the vault: ${root}`);
  assert.equal(r.facts.inside, false);
});

test('checkOutput: a non-empty folder that is not an earlier build is warn with init\'s warning text, and an earlier build is ok', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const foreign = path.join(root, 'stuff');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'notes.txt'), 'x');
  const r = await checks.checkOutput(foreign, { vault, name: 'lease' });
  assert.equal(r.state, 'warn');
  assert.equal(r.rule, `warning: ${foreign} exists and is not empty; the first build will replace its contents`);
  assert.equal(r.facts.nonEmptyForeign, true);

  const build = path.join(root, 'old-build');
  fs.mkdirSync(path.join(build, 'css'), { recursive: true });
  fs.writeFileSync(path.join(build, 'index.html'), 'x');
  fs.writeFileSync(path.join(build, 'css', 'scriptorium.css'), 'x');
  assert.equal((await checks.checkOutput(build, { vault, name: 'lease' })).state, 'ok');
});

test('checkOutput: relative paths are refused, and a UNC output with commit=0 is deferred without touching the filesystem', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  assert.equal((await checks.checkOutput('out', { vault, name: 'lease' })).rule, RELATIVE_RULE);
  const fsp = spyFsp();
  const r = await checks.checkOutput('\\\\nas\\share\\site', { vault, name: 'lease', commit: false }, { fsp });
  assert.equal(r.state, 'deferred');
  assert.deepEqual(fsp.calls, []);
});

test('checkOutput: without a vault there is nothing to compare against, so it says so', async () => {
  const r = await checks.checkOutput('/tmp/x', { vault: '', name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, 'Choose the vault folder first.');
});

// --- title -----------------------------------------------------------------

test('checkTitle: a new pack takes the title from the vault (default) and accepts any one-line title', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkTitle('', { vault, name: 'lease' });
  assert.equal(r.facts.readOnly, false);
  assert.equal(r.facts.default, 'The Long Lease');
  const ok = await checks.checkTitle('  My Site ', { vault, name: 'lease' });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.value, 'My Site');
});

test('checkTitle: an empty or multi-line title is bad with the shared message word for word', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const empty = await checks.checkTitle('   ', { vault, name: 'lease' });
  assert.equal(empty.state, 'bad');
  assert.equal(empty.rule, 'site title must be one non-empty line');
  assert.equal((await checks.checkTitle('a\nb', { vault, name: 'lease' })).rule, 'site title must be one non-empty line');
});

test('checkTitle: read-only, with the pack\'s own siteTitle, when vault.config.json already exists (the sample pack)', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const r = await checks.checkTitle('Something else', { vault, name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'The Long Lease');
  assert.equal(r.facts.readOnly, true);
});

// --- theme -----------------------------------------------------------------

test('checkTheme: a new pack defaults to gloam and lists nothing read-only', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkTheme('', { vault, name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'gloam');
  assert.equal(r.facts.readOnly, false);
});

test('checkTheme: an unknown theme is bad with the shared message word for word', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkTheme('nonesuch', { vault, name: 'lease' });
  assert.equal(r.state, 'bad');
  assert.equal(r.rule, 'unknown theme "nonesuch"; valid themes: gloam, haze, plain');
});

test('checkTheme: read-only, with the pack\'s own theme, when pack.toml exists (the sample pack says gloam)', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root, 'vault', { withPack: true });
  const r = await checks.checkTheme('haze', { vault, name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, 'gloam');
  assert.equal(r.facts.readOnly, true);
});

test('checkTheme: haze on a light palette carries the info note (the sample vault palette background is #fbf6ea)', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  const r = await checks.checkTheme('haze', { vault, name: 'lease' });
  assert.equal(r.state, 'ok');
  assert.equal(
    r.facts.note,
    'Your vault\'s palette background (#fbf6ea) is light and haze is dark. Check will report this as info, config/theme-scheme-mismatch. It still builds.',
  );
});

test('checkTheme: no note for plain, for gloam (it owns the palette), or when the palette is dark', async (t) => {
  const root = scratchRoot(t);
  const vault = copySample(root);
  assert.equal((await checks.checkTheme('plain', { vault, name: 'lease' })).facts.note, null);
  assert.equal((await checks.checkTheme('gloam', { vault, name: 'lease' })).facts.note, null);

  const fm = path.join(vault, '_meta', 'vault-config.md');
  fs.writeFileSync(fm, fs.readFileSync(fm, 'utf8').replace('background: "#fbf6ea"', 'background: "#101820"'));
  assert.equal((await checks.checkTheme('haze', { vault, name: 'lease' })).facts.note, null);
});
