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
const { VaultUnreachableError, ScriptoriumError } = require('../src/util/errors');

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
    let elsewhereBefore;
    let res;
    try {
      res = await carry(root);
    } finally {
      restore();
    }
    elsewhereBefore = fs.readFileSync(elsewhere, 'utf8');
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.ok(res.err.message.includes('it is not a regular file'), res.err.message);
    assert.ok(res.err.message.includes(`so ${packOf(vault)} was left as it was.`), res.err.message);
    assert.deepEqual(fs.readFileSync(packOf(vault)), packBefore);
    assert.ok(fs.lstatSync(yamlOf(vault)).isSymbolicLink(), 'the link must still be a link');
    assert.ok(!/folder_map:/.test(elsewhereBefore), 'the file behind the link must not have been written');
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
