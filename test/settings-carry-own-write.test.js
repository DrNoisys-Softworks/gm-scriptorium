'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');
const { runCarryCommand } = require('../src/cli/carry');
const pinned = require('../src/generator/pinned');
const vaultsettingswrite = require('../src/vault/vaultsettingswrite');
const { VaultUnreachableError, ScriptoriumError } = require('../src/util/errors');
const { startPanel, post } = require('./helpers/campaigns-panel');

/*
 * The carry's own step that sets the site title and folder map in _meta/vault-config.yaml (the pin's
 * move drops them; AntTheLimey/gm-apprentice#539). It writes through the guarded settings writer, so a
 * file that changed after the pin's apply, or became a link, is refused and the pack is left exactly as
 * it was. The step reuses the yaml copy the carry made before anything was written, so it adds no
 * backup of its own.
 *
 * Every case starts from a moved copy of the sample whose move did not fold the pack in, so the yaml
 * has no title and no folder map and the carry's own step has both to set.
 */

const yamlOf = (vault) => path.join(vault, '_meta', 'vault-config.yaml');
const packOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
const BAK_RE = /^(vault-config|vault\.config)-\d{8}T\d{9}Z-[0-9a-f]{6}\.(yaml|json)\.bak$/;

function setupUnfolded(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  fs.writeFileSync(
    path.join(root, 'config.toml'),
    `config_version = 1\n[campaigns.t]\nvault = '${vaultPath}'\noutput = '${path.join(root, 'site')}'\n`,
  );
  const yaml = fs.readFileSync(yamlOf(vaultPath), 'utf8');
  assert.ok(!/^\s*title:/m.test(yaml) && !/folder_map:/.test(yaml), 'the fixture yaml must set neither the title nor the folder map');
  return vaultPath;
}

function backupsIn(root) {
  const dir = path.join(root, 'backups', 'campaign-t');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function carry(root) {
  const input = new PassThrough();
  let out = '';
  const output = {
    isTTY: false,
    write(s) {
      out += s;
      return true;
    },
  };
  try {
    const result = await runCarryCommand({ config: path.join(root, 'config.toml'), yes: true }, [], { input, output, now: () => Date.parse('2026-10-27T10:00:00Z') });
    return { code: result.exitCode, out };
  } catch (err) {
    if (err instanceof VaultUnreachableError) return { code: 3, out, err };
    if (err instanceof ScriptoriumError) return { code: 1, out, err };
    throw err;
  }
}

/** Runs `after` once, right after the carry plans its own yaml text and before it writes it. */
function afterOwnPlan(after) {
  const real = pinned.planSettingsText;
  let fired = false;
  pinned.planSettingsText = (...args) => {
    const plan = real(...args);
    if (!fired) {
      fired = true;
      after();
    }
    return plan;
  };
  return () => {
    pinned.planSettingsText = real;
    assert.ok(fired, 'the carry must plan its own yaml text with planSettingsText');
  };
}

function withRoot(prefix, fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'a yaml changed between the pin\'s apply and the title write is refused: exit 3, the pack is byte-for-byte as it was, the edit survives',
  withRoot('scriptorium-ownwrite-changed-', async (root) => {
    const vault = setupUnfolded(root);
    const packBefore = fs.readFileSync(packOf(vault));
    const EDIT = '# added by another program\n';
    const restore = afterOwnPlan(() => fs.appendFileSync(yamlOf(vault), EDIT));
    let res;
    try {
      res = await carry(root);
    } finally {
      restore();
    }
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.ok(
      res.err.message.startsWith(
        "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (it changed while the carry was running), " +
          `so ${packOf(vault)} was left as it was. Run "gm-scriptorium carry" again. The files as they were are kept at `,
      ),
      res.err.message,
    );
    assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.ok(yaml.endsWith(EDIT), 'the other program\'s edit must survive');
    assert.ok(!/folder_map:/.test(yaml), 'the folder map must not have been written');
  }),
);

test(
  'a yaml swapped for a link before the title write is refused: exit 3, the pack is byte-for-byte as it was, the link is not followed',
  { skip: process.platform === 'win32' },
  withRoot('scriptorium-ownwrite-link-', async (root) => {
    const vault = setupUnfolded(root);
    const packBefore = fs.readFileSync(packOf(vault));
    const elsewhere = path.join(root, 'elsewhere.yaml');
    const restore = afterOwnPlan(() => {
      fs.renameSync(yamlOf(vault), elsewhere);
      fs.symlinkSync(elsewhere, yamlOf(vault));
    });
    let res;
    try {
      res = await carry(root);
    } finally {
      restore();
    }
    const elsewhereAfter = fs.readFileSync(elsewhere, 'utf8');
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.ok(
      res.err.message.startsWith(
        "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (_meta/vault-config.yaml is a link or not a regular file), " +
          `so ${packOf(vault)} was left as it was. Replace it with the file itself, then run "gm-scriptorium carry" again. The files as they were are kept at `,
      ),
      res.err.message,
    );
    assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
    assert.ok(fs.lstatSync(yamlOf(vault)).isSymbolicLink(), 'the link must still be a link');
    assert.ok(!/folder_map:/.test(elsewhereAfter), 'the file behind the link must not have been written');
  }),
);

test(
  'a carry that sets the title and folder map writes one yaml copy and one pack copy, and reports the yaml copy it took first',
  withRoot('scriptorium-ownwrite-bak-', async (root) => {
    const vault = setupUnfolded(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const res = await carry(root);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /`siteTitle` moved to `player_site\.title`/);
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /folder_map:/);
    const names = backupsIn(root);
    assert.equal(names.length, 2, names.join(', '));
    assert.ok(names.every((n) => BAK_RE.test(n)), names.join(', '));
    assert.equal(names.filter((n) => n.startsWith('vault-config-')).length, 1);
    assert.equal(names.filter((n) => n.startsWith('vault.config-')).length, 1);
    // The one yaml copy holds the file as it was before the carry began, not after the pin's apply.
    const yamlCopyPath = path.join(root, 'backups', 'campaign-t', names.find((n) => n.startsWith('vault-config-')));
    assert.deepEqual(fs.readFileSync(yamlCopyPath), yamlBefore);
    assert.ok(res.out.includes(`  ${yamlCopyPath}\n`), res.out);
  }),
);

/** Replaces `mod[name]` with `impl` for the length of `fn`, then puts it back. */
async function withInjected(mod, name, impl, fn) {
  const real = mod[name];
  mod[name] = impl;
  try {
    return await fn();
  } finally {
    mod[name] = real;
  }
}

const planRefusal = (kind, message) => () => {
  throw new pinned.SettingsPlanError(kind, message);
};

// A refusal the pin gives for the file as it is (refused, not made, unreadable) comes back on every
// run, so the message says what to fix rather than only to run the carry again.
for (const kind of ['refused', 'not-made', 'unreadable']) {
  test(
    `a ${kind} plan for the title and folder map is refused: exit 3, the pack is byte-for-byte as it was, and the message says what to fix`,
    withRoot(`scriptorium-ownwrite-${kind}-`, async (root) => {
      const vault = setupUnfolded(root);
      const packBefore = fs.readFileSync(packOf(vault));
      const res = await withInjected(pinned, 'planSettingsText', planRefusal(kind, `injected: the pin will not plan this (${kind}).`), () => carry(root));
      assert.equal(res.code, 3, res.out);
      assert.equal(res.err.reason, 'carry-blocked');
      assert.ok(
        res.err.message.startsWith(
          `The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (injected: the pin will not plan this (${kind}).), ` +
            `so ${packOf(vault)} was left as it was. Fix what it names in _meta/vault-config.yaml, then run "gm-scriptorium carry" again. ` +
            'The files as they were are kept at ',
        ),
        res.err.message,
      );
      assert.ok(!res.err.message.includes('Run "gm-scriptorium carry" again'), res.err.message);
      assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
    }),
  );
}

test(
  'a plan that did not start from the file the carry read is refused without claiming nothing was written',
  withRoot('scriptorium-ownwrite-mismatch-', async (root) => {
    const vault = setupUnfolded(root);
    const packBefore = fs.readFileSync(packOf(vault));
    const res = await withInjected(
      pinned,
      'planSettingsText',
      planRefusal('mismatch', 'the settings plan did not start from the file the panel checked; nothing was written.'),
      () => carry(root),
    );
    assert.equal(res.code, 3, res.out);
    assert.ok(
      res.err.message.startsWith(
        "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (the settings plan did not start from the file the carry read), " +
          `so ${packOf(vault)} was left as it was. Run "gm-scriptorium carry" again. The files as they were are kept at `,
      ),
      res.err.message,
    );
    assert.ok(!/nothing was written/i.test(res.err.message), res.err.message);
    assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
  }),
);

test(
  'a writer failure that keeps its code on cause is reported by that code, and the rest of the carry is done',
  withRoot('scriptorium-ownwrite-eio-', async (root) => {
    const vault = setupUnfolded(root);
    const res = await withInjected(
      vaultsettingswrite,
      'replaceVaultSettingsYaml',
      () => {
        throw new ScriptoriumError('injected: a long writer message that must not be shown', { cause: Object.assign(new Error('io'), { code: 'EIO' }) });
      },
      () => carry(root),
    );
    assert.equal(res.code, 3, res.out);
    assert.ok(
      res.err.message.startsWith(
        `siteTitle and folderMap are still in ${packOf(vault)}: the vault's settings file could not be written (EIO). ` +
          'The rest of the carry is done. Run "gm-scriptorium carry" again once the file can be written. The files as they were are kept at ',
      ),
      res.err.message,
    );
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.equal(pack.siteTitle, 'The Long Lease');
  }),
);

// Through the panel: the carry route answers a refusal with 503 io and the panel's own words.
async function panelCarry(t, root, inject) {
  const vault = setupUnfolded(root);
  const h = await startPanel(t, { config: path.join(root, 'config.toml') }, 't');
  const dry = await post(h, '/api/settings/carry', { dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  const packBefore = fs.readFileSync(packOf(vault));
  const res = await inject(() => post(h, '/api/settings/carry', { dryRun: false, baseSha256: dry.json.baseSha256 }));
  return { vault, res, packBefore };
}

test('through the panel, a yaml changed during the carry answers 503 io and says to press the button again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-ownwrite-panel-changed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { vault, res, packBefore } = await panelCarry(t, root, (fn) =>
    withInjected(
      vaultsettingswrite,
      'replaceVaultSettingsYaml',
      () => {
        throw new vaultsettingswrite.VaultSettingsChangedError('vault-config.yaml changed outside the panel. Reload before saving.');
      },
      fn,
    ),
  );
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'io');
  assert.ok(
    res.json.message.startsWith(
      "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (it changed while the carry was running), " +
        `so ${packOf(vault)} was left as it was. Press "Carry these settings" again. The files as they were are kept at `,
    ),
    res.json.message,
  );
  assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
});

test('through the panel, a plan the pin refuses answers 503 io and says what to fix before pressing the button again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-ownwrite-panel-refused-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { vault, res, packBefore } = await panelCarry(t, root, (fn) =>
    withInjected(pinned, 'planSettingsText', planRefusal('refused', 'injected: the pin will not plan this.'), fn),
  );
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'io');
  assert.ok(
    res.json.message.startsWith(
      "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (injected: the pin will not plan this.), " +
        `so ${packOf(vault)} was left as it was. Fix what it names in _meta/vault-config.yaml, then press "Carry these settings" again. ` +
        'The files as they were are kept at ',
    ),
    res.json.message,
  );
  assert.ok(!res.json.message.includes('gm-scriptorium carry'), res.json.message);
  assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
});

const { ConfigError } = require('../src/util/errors');

// The guarded writer's own refusal of a linked settings file, as it words it.
const notRegular = () => {
  throw new ConfigError('refusing to edit /somewhere/_meta/vault-config.yaml: it is not a regular file');
};

test(
  'through the panel, a yaml that is a link answers 503 io and says to replace it, then press the button again',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-ownwrite-panel-link-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { vault, res, packBefore } = await panelCarry(t, root, (fn) => withInjected(vaultsettingswrite, 'replaceVaultSettingsYaml', notRegular, fn));
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error, 'io');
    assert.ok(
      res.json.message.startsWith(
        "The carry could not finish: siteTitle and folderMap are not set in the vault's settings file (_meta/vault-config.yaml is a link or not a regular file), " +
          `so ${packOf(vault)} was left as it was. Replace it with the file itself, then press "Carry these settings" again. ` +
          'The files as they were are kept at ',
      ),
      res.json.message,
    );
    assert.ok(!res.json.message.includes('gm-scriptorium carry'), res.json.message);
    assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
  },
);

test(
  'a refusal of a linked yaml that is not the writer\'s file-kind refusal still says to run the carry again, with no fix named',
  withRoot('scriptorium-ownwrite-other-config-', async (root) => {
    const vault = setupUnfolded(root);
    const res = await withInjected(
      vaultsettingswrite,
      'replaceVaultSettingsYaml',
      () => {
        throw new ConfigError('refusing to edit /somewhere/_meta/vault-config.yaml: injected other refusal');
      },
      () => carry(root),
    );
    assert.equal(res.code, 3, res.out);
    assert.ok(res.err.message.includes('Run "gm-scriptorium carry" again. The files as they were'), res.err.message);
    assert.ok(!res.err.message.includes('Replace it with the file itself'), res.err.message);
    assert.ok(fs.existsSync(packOf(vault)));
  }),
);
