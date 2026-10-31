'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');

/*
 * `check` and `build` never write to the vault, whichever layout its settings are in. For a moved
 * vault and a mixed one (both settings files), with a pack holding a hide entry the yaml lacks,
 * this hashes every file under the vault before and after `check` and `build` (which stops at the
 * check step), and `build --force-check` and `build --no-check` (which the build itself refuses
 * until the pack is carried, ADR 0071 section 12), and asserts the two listings are equal: no file
 * changed, added or removed. Then the GM's carry runs (it writes the vault, on purpose), and the
 * same holds for `build --force-check` and `build --no-check` that do build. SCRIPTORIUM_TEST_BIN
 * runs this against the packaged binary.
 */

/** Sorted "relative path : sha256" lines for every file under dir; folders as "path/". */
function snapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else {
        out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  })(dir, '');
  return out.sort();
}

function setup(root, state) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  if (state === 'mixed') fs.copyFileSync(path.join(SAMPLE, '_meta', 'vault-config.md'), path.join(vaultPath, '_meta', 'vault-config.md'));
  const pack = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(pack, 'utf8'));
  json.excludeSections.push('Uncarried Secret');
  fs.writeFileSync(pack, JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vaultPath}'\noutput = '${path.join(root, 'site')}'\n`);
  return vaultPath;
}

for (const state of ['moved', 'mixed']) {
  test(`check, build, build --force-check and build --no-check leave a ${state} vault exactly as it was`, () => {
    withScratch((root) => {
      const vault = setup(root, state);
      const before = snapshot(vault);
      assert.ok(before.length > 50, 'the snapshot holds the whole vault');

      assert.equal(run(root, ['check']).code, 2);
      assert.deepEqual(snapshot(vault), before, 'check wrote to the vault');

      assert.equal(run(root, ['build']).code, 2);
      assert.deepEqual(snapshot(vault), before, 'build wrote to the vault');

      for (const flag of ['--force-check', '--no-check']) {
        const refused = run(root, ['build', flag]);
        assert.equal(refused.code, 3, refused.all);
        assert.equal(fs.existsSync(path.join(root, 'site')), false, `a refused build ${flag} writes no site`);
        assert.deepEqual(snapshot(vault), before, `a refused build ${flag} wrote to the vault`);
      }

      const carried = run(root, ['carry', '--yes']);
      assert.equal(carried.code, 0, carried.all);
      const afterCarry = snapshot(vault);
      for (const flag of ['--force-check', '--no-check']) {
        const built = run(root, ['build', flag]);
        assert.equal(built.code, 0, built.all);
        assert.equal(fs.existsSync(path.join(root, 'site', 'index.html')), true);
        assert.deepEqual(snapshot(vault), afterCarry, `build ${flag} wrote to the vault`);
      }
    });
  });
}
